// routes/support-tickets.js
//
// Einfaches Support-Ticket-System ab Starter-Paket (Kundenwunsch 10/2026):
// Kunde tippt kurz ein, was nicht geht, und bekommt sofort eine
// Eingangsbestätigung mit Ticketnummer. Wir bearbeiten strikt nach
// Reihenfolge - kein Priorisierungs-/Routing-System, bewusst einfach
// gehalten (siehe routes/admin.js für die Bearbeitungs-Warteschlange).
//
// Getrennt von routes/support.js (das ist der KI-Support-Chat) - beide
// Wege bestehen parallel: der Chat für Soforthilfe bei bekannten Fragen,
// dieses Ticket-System für alles, was ein Mensch anschauen muss.
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireCustomer, requireActiveSubscription } = require('../middleware/auth');
const { sendSupportTicketConfirmationEmail, sendSupportTicketNotificationEmail } = require('../lib/email');

const router = express.Router();
router.use(requireAuth, requireCustomer, requireActiveSubscription);

router.post('/', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Bitte beschreibe kurz, was nicht funktioniert.', error_code: 'MESSAGE_REQUIRED' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'Beschreibung ist zu lang (max. 4000 Zeichen).', error_code: 'MESSAGE_TOO_LONG' });
  }

  const customerId = req.auth.userId;

  try {
    const customer = db.prepare('SELECT company_name, customer_number, email FROM customers WHERE id = ?').get(customerId);

    const insertResult = db.prepare('INSERT INTO support_tickets (customer_id, message) VALUES (?, ?)').run(customerId, message);
    const ticketId = insertResult.lastInsertRowid;

    // E-Mail-Versand ist ein Nice-to-have, kein Kernbestandteil - ein SMTP-
    // Ausfall darf das Anlegen des Tickets nie verhindern (siehe
    // lib/email.js: sendMail() scheitert ohnehin nie, loggt nur).
    try {
      await Promise.all([
        sendSupportTicketConfirmationEmail(customer.email, ticketId, message),
        sendSupportTicketNotificationEmail(ticketId, customer, message)
      ]);
    } catch (emailError) {
      console.error('❌ Support-Ticket-Mail Fehler:', emailError.message);
    }

    res.status(201).json({ id: ticketId, status: 'open' });
  } catch (error) {
    console.error('❌ Support-Ticket Fehler:', error);
    res.status(500).json({ error: 'Ticket konnte nicht angelegt werden: ' + error.message });
  }
});

router.get('/', (req, res) => {
  try {
    const tickets = db.prepare(`
      SELECT id, message, status, created_at, updated_at
      FROM support_tickets
      WHERE customer_id = ?
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(tickets);
  } catch (error) {
    console.error('❌ Support-Tickets Laden Fehler:', error);
    res.status(500).json({ error: 'Tickets konnten nicht geladen werden.' });
  }
});

module.exports = router;
