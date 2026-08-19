const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ============================================================
// ALLE SKUS DES KUNDEN
// ============================================================
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM product_packaging
      WHERE customer_id = ?
      ORDER BY created_at DESC
    `).all(req.customer.sub);
    res.json(rows);
  } catch (error) {
    console.error('❌ Fehler beim Laden der SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Produkte' });
  }
});

// ============================================================
// NEUEN SKU ANLEGEN
// ============================================================
router.post('/', (req, res) => {
  try {
    const { sku_name, shopify_product_id, materials } = req.body;
    const customer_id = req.customer.sub;

    if (!sku_name || !materials || materials.length === 0) {
      return res.status(400).json({ error: 'Produktname und Materialien sind erforderlich.' });
    }

    const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
    const materials_json = JSON.stringify(materials);

    const result = db.prepare(`
      INSERT INTO product_packaging 
      (customer_id, sku_name, shopify_product_id, materials_json, total_weight_grams)
      VALUES (?, ?, ?, ?, ?)
    `).run(customer_id, sku_name, shopify_product_id || null, materials_json, total_weight);

    const newSku = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newSku);
  } catch (error) {
    console.error('❌ Fehler beim Erstellen des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Erstellen des Produkts: ' + error.message });
  }
});

// ============================================================
// SKU AKTUALISIEREN
// ============================================================
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { sku_name, shopify_product_id, materials } = req.body;
    const customer_id = req.customer.sub;

    // Prüfen, ob SKU existiert und dem Kunden gehört
    const existing = db.prepare('SELECT id FROM product_packaging WHERE id = ? AND customer_id = ?')
      .get(id, customer_id);
    if (!existing) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }

    const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
    const materials_json = JSON.stringify(materials);

    db.prepare(`
      UPDATE product_packaging 
      SET sku_name = ?, shopify_product_id = ?, materials_json = ?, total_weight_grams = ?, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(sku_name, shopify_product_id || null, materials_json, total_weight, id, customer_id);

    const updated = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Aktualisieren des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Produkts: ' + error.message });
  }
});

// ============================================================
// SKU LÖSCHEN
// ============================================================
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const customer_id = req.customer.sub;

    const result = db.prepare('DELETE FROM product_packaging WHERE id = ? AND customer_id = ?')
      .run(id, customer_id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Fehler beim Löschen des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Löschen des Produkts: ' + error.message });
  }
});

module.exports = router;
