const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, requireCustomer } = require('../middleware/auth');

const router = express.Router();

// Gleiches Material-Enum wie bei Produkten/Bestellungen (routes/skus.js,
// routes/orders.js) - eine Meldung wird jetzt direkt aus den tatsächlichen
// Bestellungen vorbefüllt, dafür müssen beide Seiten dieselben Kategorien
// verwenden.
const materialSchema = z.object({
  material: z.enum(['karton', 'kunststoff', 'papier', 'glas', 'metall', 'holz', 'sonstige']),
  weight_kg: z.number().positive(),
  qty: z.number().int().positive(),
});

const submissionSchema = z.object({
  destination: z.string().length(2),
  length_cm: z.number().positive(),
  width_cm: z.number().positive(),
  height_cm: z.number().positive(),
  materials: z.array(materialSchema).min(1),
});

router.post('/', requireAuth, (req, res) => {
  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe.' });

  const { destination, length_cm, width_cm, height_cm, materials } = parsed.data;
  const totalWeight = materials.reduce((sum, m) => sum + m.weight_kg * m.qty, 0);

  const insert = db.prepare(`
    INSERT INTO submissions (customer_id, destination, length_cm, width_cm, height_cm, materials_json, total_weight_kg)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    req.customer.sub, destination, length_cm, width_cm, height_cm,
    JSON.stringify(materials), totalWeight
  );

  res.status(201).json({ id: result.lastInsertRowid, destination, total_weight_kg: totalWeight });
});

router.get('/me', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions WHERE customer_id = ? ORDER BY created_at DESC')
    .all(req.customer.sub);
  res.json(rows.map(r => ({ ...r, materials_json: JSON.parse(r.materials_json) })));
});

// ============================================================
// MELDUNG BEARBEITEN (Tippfehler korrigieren)
//
// Nur die eigene Meldung des Händlers. Eine bereits vom Beauftragten
// exportierte/bearbeitete Meldung geht bei einer inhaltlichen Korrektur
// zurück auf "received" - der Beauftragte muss die geänderten Daten dann
// erneut prüfen, statt dass ein stiller Datenstand bestehen bleibt.
// ============================================================
router.put('/:id', requireAuth, requireCustomer, (req, res) => {
  const existing = db.prepare('SELECT * FROM submissions WHERE id = ? AND customer_id = ?')
    .get(req.params.id, req.customer.sub);
  if (!existing) return res.status(404).json({ error: 'Meldung nicht gefunden.' });

  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe.' });

  const { destination, length_cm, width_cm, height_cm, materials } = parsed.data;
  const totalWeight = materials.reduce((sum, m) => sum + m.weight_kg * m.qty, 0);

  db.prepare(`
    UPDATE submissions
    SET destination = ?, length_cm = ?, width_cm = ?, height_cm = ?,
        materials_json = ?, total_weight_kg = ?, status = 'received'
    WHERE id = ? AND customer_id = ?
  `).run(
    destination, length_cm, width_cm, height_cm,
    JSON.stringify(materials), totalWeight,
    req.params.id, req.customer.sub
  );

  const updated = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  res.json({ ...updated, materials_json: JSON.parse(updated.materials_json) });
});

router.get('/by-country/:countryCode', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, c.company_name, c.customer_number
    FROM submissions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.destination = ?
    ORDER BY s.created_at DESC
  `).all(req.params.countryCode);
  res.json(rows.map(r => ({ ...r, materials_json: JSON.parse(r.materials_json) })));
});

router.post('/:id/export', requireAuth, (req, res) => {
  db.prepare('UPDATE submissions SET status = "exported" WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
