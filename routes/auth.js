const express = require('express');
const bcrypt = require('bcryptjs'); // ⭐ ACHTUNG: bcryptjs, nicht bcrypt!
const { z } = require('zod');
const db = require('../db'); // ⭐ GEÄNDERT: ohne { }!
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

function generateCustomerNumber() {
  return 'FC-' + Math.floor(100000 + Math.random() * 900000);
}

const registerSchema = z.object({
  companyName: z.string().min(2),
  originCountry: z.string().length(2),
  contactName: z.string().optional(),
  email: z.string().email(),
  password: z.string().min(8),
  plan: z.enum(['S', 'M', 'L']).default('M'),
});

// ⭐ REGISTRIERUNG
router.post('/register', (req, res) => {
  console.log('🔍 Registrierungsversuch:', req.body);

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log('❌ Validierungsfehler:', parsed.error.flatten());
    return res.status(400).json({ error: 'Ungültige Eingabe.', details: parsed.error.flatten() });
  }

  const { companyName, originCountry, contactName, email, password, plan } = parsed.data;

  try {
    // Prüfen, ob E-Mail existiert
    const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'E-Mail existiert bereits.' });
    }

    // Passwort hashen
    const passwordHash = bcrypt.hashSync(password, 12);
    
    // Customer-Nummer generieren
    let customerNumber;
    do {
      customerNumber = generateCustomerNumber();
    } while (db.prepare('SELECT id FROM customers WHERE customer_number = ?').get(customerNumber));

    // Kunden speichern
    const insert = db.prepare(`
      INSERT INTO customers (customer_number, company_name, origin_country, contact_name, email, password_hash, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(customerNumber, companyName, originCountry, contactName || null, email, passwordHash, plan);

    console.log('✅ Kunde registriert:', customerNumber);

    // Kunden abrufen
    const customer = db.prepare('SELECT id, customer_number, company_name, email, plan FROM customers WHERE id = ?')
      .get(result.lastInsertRowid);
    
    const token = signToken(customer);
    res.status(201).json({ token, customer });

  } catch (error) {
    console.error('❌ Registrierungsfehler:', error);
    res.status(500).json({ error: 'Interner Serverfehler bei der Registrierung.' });
  }
});

// ⭐ LOGIN
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
      return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });
    }

    const token = signToken(customer);
    res.json({ token, customer: {
      id: customer.id,
      customer_number: customer.customer_number,
      company_name: customer.company_name,
      email: customer.email,
      plan: customer.plan
    }});
  } catch (error) {
    console.error('❌ Login-Fehler:', error);
    res.status(500).json({ error: 'Interner Serverfehler beim Login.' });
  }
});

// ⭐ AKTUELLEN BENUTZER ABRUFEN
router.get('/me', requireAuth, (req, res) => {
  try {
    const customer = db.prepare('SELECT id, customer_number, company_name, email, plan FROM customers WHERE id = ?')
      .get(req.customer.sub);
    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });
    res.json(customer);
  } catch (error) {
    console.error('❌ Auth-Fehler:', error);
    res.status(500).json({ error: 'Interner Serverfehler.' });
  }
});

module.exports = router;
