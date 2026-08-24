const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ============================================================
// ALLE AKTIVIERUNGEN DES KUNDEN (MIT MODE)
// ============================================================
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT 
        a.country_code, 
        a.status, 
        a.signed_at, 
        a.existing_number,
        a.provider_id,
        a.provider_epr_number,
        a.provider_status,
        a.mode,
        a.mode_updated_at,
        c.name, 
        c.register_body,
        c.flag
      FROM activations a
      JOIN countries c ON c.code = a.country_code
      WHERE a.customer_id = ?
    `).all(req.customer.sub);
    
    const result = rows.map(row => ({
      ...row,
      mode: row.mode || 'grauzone'
    }));
    
    res.json(result);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Aktivierungen:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Aktivierungen' });
  }
});

// ============================================================
// LAND AKTIVIEREN (mit mode: grauzone als Standard)
// ============================================================
router.post('/:countryCode', (req, res) => {
  try {
    const { countryCode } = req.params;
    const { existing_number } = req.body;
    
    const country = db.prepare('SELECT code FROM countries WHERE code = ?').get(countryCode);
    if (!country) {
      return res.status(404).json({ error: `Land ${countryCode} wird nicht unterstützt.` });
    }

    const existing = db.prepare('SELECT id FROM activations WHERE customer_id = ? AND country_code = ?')
      .get(req.customer.sub, countryCode);
    if (existing) {
      return res.status(409).json({ error: 'Bereits aktiviert.' });
    }

    const status = existing_number ? 'active' : 'pending';
    
    db.prepare(`
      INSERT INTO activations (customer_id, country_code, status, existing_number, mode)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.customer.sub, countryCode, status, existing_number || null, 'grauzone');

    res.status(201).json({ ok: true, countryCode, status, existing_number, mode: 'grauzone' });
  } catch (error) {
    console.error('❌ Fehler bei der Aktivierung:', error);
    res.status(500).json({ error: 'Fehler bei der Aktivierung: ' + error.message });
  }
});

// ============================================================
// VOLLMACHT SIGNIEREN
// ============================================================
router.post('/:countryCode/sign', (req, res) => {
  try {
    const { countryCode } = req.params;
    const result = db.prepare(`
      UPDATE activations SET status = 'signed', signed_at = datetime('now')
      WHERE customer_id = ? AND country_code = ?
    `).run(req.customer.sub, countryCode);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Keine Aktivierung gefunden.' });
    }
    res.json({ ok: true, countryCode, status: 'signed' });
  } catch (error) {
    console.error('❌ Fehler beim Signieren:', error);
    res.status(500).json({ error: 'Fehler beim Signieren: ' + error.message });
  }
});

// ============================================================
// ⚠️ ENTFERNT: POST /:countryCode/upgrade
// Dieser Endpunkt setzte mode = 'premium' direkt, OHNE jede
// Stripe-Zahlungsprüfung. Jeder eingeloggte Kunde hätte sich
// damit (z.B. über die Browser-Konsole) kostenlos auf
// "100% rechtssicher" setzen können.
//
// Die EINZIGE Stelle, die mode = 'premium' setzen darf, ist
// der Stripe-Webhook in routes/billing.js (nach bestätigter
// Zahlung). Das Dashboard ruft dafür bereits korrekt
// /api/billing/create-upgrade-session auf.
// ============================================================

// ============================================================
// STATUS ABFRAGEN (für Dashboard)
// ============================================================
router.get('/:countryCode/status', (req, res) => {
  try {
    const { countryCode } = req.params;
    const activation = db.prepare(`
      SELECT mode, status, provider_epr_number, provider_status
      FROM activations 
      WHERE customer_id = ? AND country_code = ?
    `).get(req.customer.sub, countryCode);

    if (!activation) {
      return res.status(404).json({ error: 'Land nicht aktiviert.' });
    }

    res.json({
      countryCode,
      mode: activation.mode || 'grauzone',
      status: activation.status,
      epr_number: activation.provider_epr_number,
      provider_status: activation.provider_status
    });
  } catch (error) {
    console.error('❌ Fehler beim Status:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen des Status.' });
  }
});

module.exports = router;
