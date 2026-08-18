const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/csv/:countryCode', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, c.company_name, c.customer_number
    FROM submissions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.destination = ?
    ORDER BY s.created_at ASC
  `).all(req.params.countryCode);

  const header = 'ID,Kunde,Land,Materialien,Gewicht_kg,Status,Datum\n';
  const lines = rows.map(r => {
    const materials = JSON.parse(r.materials_json || '[]')
      .map(m => `${m.material}:${m.weight_kg}kg×${m.qty}`).join('|');
    return `${r.id},${r.company_name},${r.destination},${materials},${r.total_weight_kg},${r.status},${r.created_at}`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="export_${req.params.countryCode}.csv"`);
  res.send(header + lines);
});

module.exports = router;