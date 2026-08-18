const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Alle Aktivierungen des Kunden
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT a.country_code, a.status, a.signed_at, a.existing_number, c.name, c.register_body
    FROM activations a
    JOIN countries c ON c.code = a.country_code
    WHERE a.customer_id = ?
  `).all(req.customer.sub);
  res.json(rows);
});

// Land aktivieren (mit oder ohne bestehende Nummer)
router.post('/:countryCode', (req, res) => {
  const { countryCode } = req.params;
  const { existing_number } = req.body;
  
  const country = db.prepare('SELECT code FROM countries WHERE code = ?').get(countryCode);
  if (!country) return res.status(404).json({ error: `Land ${countryCode} wird nicht unterstützt.` });

  const existing = db.prepare('SELECT id FROM activations WHERE customer_id = ? AND country_code = ?')
    .get(req.customer.sub, countryCode);
  if (existing) return res.status(409).json({ error: 'Bereits aktiviert.' });

  const status = existing_number ? 'active' : 'pending';
  db.prepare(`
    INSERT INTO activations (customer_id, country_code, status, existing_number) 
    VALUES (?, ?, ?, ?)
  `).run(req.customer.sub, countryCode, status, existing_number || null);

  res.status(201).json({ ok: true, countryCode, status, existing_number });
});

// Vollmacht signieren
router.post('/:countryCode/sign', (req, res) => {
  const { countryCode } = req.params;
  const result = db.prepare(`
    UPDATE activations SET status = 'signed', signed_at = datetime('now')
    WHERE customer_id = ? AND country_code = ?
  `).run(req.customer.sub, countryCode);

  if (result.changes === 0) return res.status(404).json({ error: 'Keine Aktivierung gefunden.' });
  res.json({ ok: true, countryCode, status: 'signed' });
});

module.exports = router;