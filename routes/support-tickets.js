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

// Ticketnummer im Format JJMMTT-NN (z.B. "261006-01", nächster Tag
// "261007-01") statt der reinen durchlaufenden id (Kundenwunsch 10/2026) -
// sortiert als String korrekt chronologisch (anders als TTMMJJ, wo z.B.
// "05112601" alphabetisch vor "06102601" käme, obwohl November nach
// Oktober liegt). NN zählt pro Kalendertag (UTC, wie created_at) neu von
// 01 - synchron innerhalb desselben better-sqlite3-Aufrufs, also ohne
// Race Condition zwischen Zählen und Einfügen.
function generateTicketNumber() {
  const now = new Date();
  const datePrefix = [
    String(now.getUTCFullYear()).slice(-2),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  ].join('');

  const { count } = db.prepare(`
    SELECT COUNT(*) as count FROM support_tickets WHERE ticket_number LIKE ?
  `).get(`${datePrefix}-%`);

  return `${datePrefix}-${String(count + 1).padStart(2, '0')}`;
}

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
    const customer = db.prepare('SELECT company_name, customer_number, email, preferred_lang FROM customers WHERE id = ?').get(customerId);

    const ticketNumber = generateTicketNumber();
    const insertResult = db.prepare('INSERT INTO support_tickets (customer_id, message, ticket_number) VALUES (?, ?, ?)').run(customerId, message, ticketNumber);
    const ticketId = insertResult.lastInsertRowid;

    // E-Mail-Versand ist ein Nice-to-have, kein Kernbestandteil - ein SMTP-
    // Ausfall darf das Anlegen des Tickets nie verhindern (siehe
    // lib/email.js: sendMail() scheitert ohnehin nie, loggt nur).
    try {
      await Promise.all([
        sendSupportTicketConfirmationEmail(customer.email, ticketNumber, message, customer.preferred_lang),
        sendSupportTicketNotificationEmail(ticketNumber, customer, message)
      ]);
    } catch (emailError) {
      console.error('❌ Support-Ticket-Mail Fehler:', emailError.message);
    }

    res.status(201).json({ id: ticketId, ticket_number: ticketNumber, status: 'open' });
  } catch (error) {
    console.error('❌ Support-Ticket Fehler:', error);
    res.status(500).json({ error: 'Ticket konnte nicht angelegt werden: ' + error.message });
  }
});

router.get('/', (req, res) => {
  try {
    const tickets = db.prepare(`
      SELECT id, ticket_number, message, status, created_at, updated_at
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
