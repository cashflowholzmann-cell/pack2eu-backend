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
  material_subtype: z.string().nullable().optional(),
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

// Kundenwunsch: WEEE-/Batterieprodukte werden nicht nach Gewicht, sondern
// nach STÜCKZAHL je Kategorie (WEEE) bzw. Batterietyp gemeldet - daher ein
// eigenes, schlankeres Schema ohne Paketmaße/Materialgewichte (siehe
// lib/weee-battery-items.js für dieselbe Struktur bei den zugrunde
// liegenden Bestellungen). "code" ist je nach stream ein weee_category-
// oder battery_type-Code aus den entsprechenden Kategorien-Tabellen.
const weeeBatteryItemSchema = z.object({
  code: z.string().min(1),
  quantity: z.number().int().positive(),
});

const weeeBatterySubmissionSchema = z.object({
  stream: z.enum(['weee', 'battery']),
  destination: z.string().length(2),
  items: z.array(weeeBatteryItemSchema).min(1),
});

function parseSubmissionRow(row) {
  return {
    ...row,
    materials_json: JSON.parse(row.materials_json || '[]'),
    items_json: row.items_json ? JSON.parse(row.items_json) : null
  };
}

router.post('/', requireAuth, (req, res) => {
  // stream fehlt/= 'packaging': unverändertes Verhalten (Maße + Material-
  // Gewichte). stream = 'weee'/'battery': Stückzahl-Meldung ohne Maße -
  // length_cm/width_cm/height_cm/materials_json bleiben dafür auf 0/'[]',
  // da diese Spalten NOT NULL sind und für eine reine Stückzahl-Meldung
  // keine sinnvollen Werte haben.
  if (req.body?.stream === 'weee' || req.body?.stream === 'battery') {
    const parsed = weeeBatterySubmissionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe.' });

    const { stream, destination, items } = parsed.data;
    const insert = db.prepare(`
      INSERT INTO submissions (customer_id, destination, length_cm, width_cm, height_cm, materials_json, total_weight_kg, stream, items_json)
      VALUES (?, ?, 0, 0, 0, '[]', 0, ?, ?)
    `);
    const result = insert.run(req.customer.sub, destination, stream, JSON.stringify(items));

    return res.status(201).json({ id: result.lastInsertRowid, destination, stream, items });
  }

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
  res.json(rows.map(parseSubmissionRow));
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

  if (req.body?.stream === 'weee' || req.body?.stream === 'battery') {
    const parsed = weeeBatterySubmissionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ungültige Eingabe.' });

    const { stream, destination, items } = parsed.data;
    db.prepare(`
      UPDATE submissions
      SET destination = ?, stream = ?, items_json = ?, status = 'received'
      WHERE id = ? AND customer_id = ?
    `).run(destination, stream, JSON.stringify(items), req.params.id, req.customer.sub);

    const updated = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    return res.json(parseSubmissionRow(updated));
  }

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
  res.json(parseSubmissionRow(updated));
});

router.get('/by-country/:countryCode', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, c.company_name, c.customer_number
    FROM submissions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.destination = ?
    ORDER BY s.created_at DESC
  `).all(req.params.countryCode);
  res.json(rows.map(parseSubmissionRow));
});

router.post('/:id/export', requireAuth, (req, res) => {
  db.prepare("UPDATE submissions SET status = 'exported' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
