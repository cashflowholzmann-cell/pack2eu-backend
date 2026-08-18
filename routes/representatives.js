const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Beauftragter registrieren
router.post('/register', async (req, res) => {
  const { email, password, name, company, country_code } = req.body;
  
  const existing = db.prepare('SELECT id FROM representatives WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'E-Mail bereits registriert.' });
  
  const passwordHash = bcrypt.hashSync(password, 12);
  const insert = db.prepare(`
    INSERT INTO representatives (email, password_hash, name, company, country_code)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(email, passwordHash, name, company, country_code);
  
  res.status(201).json({ success: true, message: 'Beauftragter registriert.' });
});

// Beauftragter Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const rep = db.prepare('SELECT * FROM representatives WHERE email = ?').get(email);
  
  if (!rep || !bcrypt.compareSync(password, rep.password_hash)) {
    return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });
  }
  
  const token = signToken({ sub: rep.id, role: 'representative' });
  res.json({ token, representative: { id: rep.id, name: rep.name, email: rep.email } });
});

// Eingehende Meldungen für Beauftragten
router.get('/submissions', requireAuth, (req, res) => {
  // Nur Beauftragte dürfen darauf zugreifen
  if (req.customer.role !== 'representative') {
    return res.status(403).json({ error: 'Nur für Beauftragte.' });
  }
  
  const rep = db.prepare('SELECT country_code FROM representatives WHERE id = ?').get(req.customer.sub);
  if (!rep) return res.status(404).json({ error: 'Beauftragter nicht gefunden.' });
  
  const rows = db.prepare(`
    SELECT s.*, c.company_name, c.customer_number
    FROM submissions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.destination = ?
    ORDER BY s.created_at DESC
  `).all(rep.country_code);
  
  res.json(rows);
});

module.exports = router;
