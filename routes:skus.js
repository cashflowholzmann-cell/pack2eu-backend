const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Alle SKUs des Kunden
router.get('/', requireAuth, (req, res) => {
  const skus = db.prepare(`
    SELECT * FROM product_packaging WHERE customer_id = ? ORDER BY sku_name
  `).all(req.customer.sub);
  
  const parsed = skus.map(s => ({
    ...s,
    materials: JSON.parse(s.materials_json)
  }));
  res.json(parsed);
});

// Neue SKU anlegen
router.post('/', requireAuth, (req, res) => {
  const { sku_name, shopify_product_id, shopify_variant_id, materials, packaging_type } = req.body;
  
  if (!sku_name || !materials || materials.length === 0) {
    return res.status(400).json({ error: 'Produktname und Materialien sind erforderlich.' });
  }
  
  const total_weight_grams = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
  
  const insert = db.prepare(`
    INSERT INTO product_packaging 
    (customer_id, sku_name, shopify_product_id, shopify_variant_id, materials_json, total_weight_grams, packaging_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = insert.run(
    req.customer.sub,
    sku_name,
    shopify_product_id || null,
    shopify_variant_id || null,
    JSON.stringify(materials),
    total_weight_grams,
    packaging_type || 'sonstige'
  );
  
  res.status(201).json({
    id: result.lastInsertRowid,
    sku_name,
    total_weight_grams,
    materials
  });
});

// SKU aktualisieren
router.put('/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { sku_name, materials, packaging_type } = req.body;
  
  const existing = db.prepare('SELECT customer_id FROM product_packaging WHERE id = ?').get(id);
  if (!existing || existing.customer_id !== req.customer.sub) {
    return res.status(404).json({ error: 'SKU nicht gefunden.' });
  }
  
  const total_weight_grams = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
  
  db.prepare(`
    UPDATE product_packaging 
    SET sku_name = ?, materials_json = ?, total_weight_grams = ?, packaging_type = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(sku_name, JSON.stringify(materials), total_weight_grams, packaging_type || 'sonstige', id);
  
  res.json({ success: true });
});

// SKU löschen
router.delete('/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  
  const existing = db.prepare('SELECT customer_id FROM product_packaging WHERE id = ?').get(id);
  if (!existing || existing.customer_id !== req.customer.sub) {
    return res.status(404).json({ error: 'SKU nicht gefunden.' });
  }
  
  db.prepare('DELETE FROM product_packaging WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;