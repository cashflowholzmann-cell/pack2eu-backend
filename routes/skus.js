const express = require('express');
const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { findAnomalousSkus } = require('../lib/sku-anomalies');
const { getRates, computeSkuCost, simulateAlternative } = require('../lib/material-savings');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// ============================================================
// WEEE-/BATTERIE-KATEGORIEN (für die Klassifizierungs-Auswahl im
// SKU-Editor - siehe dashboard.html)
// ============================================================
router.get('/categories', (req, res) => {
  try {
    res.json({
      weee: db.prepare('SELECT code, name_de, name_en, description FROM weee_categories ORDER BY code').all(),
      battery: db.prepare('SELECT code, name_de, name_en, description FROM battery_categories ORDER BY code').all()
    });
  } catch (error) {
    console.error('❌ Fehler beim Laden der Kategorien:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Kategorien' });
  }
});

// Ohne diese Angaben kann das System nicht wissen, ob eine SKU überhaupt
// WEEE- oder Batteriepflichten auslöst - siehe Kommentar in db/index.js
// zu den product_packaging-Klassifizierungsfeldern.
function readClassification(body = {}) {
  const isElectricalEquipment = Boolean(body.is_electrical_equipment);
  const containsBattery = Boolean(body.contains_battery);

  const weeeCategory = isElectricalEquipment && body.weee_category ? String(body.weee_category).trim() : null;
  const batteryType = containsBattery && body.battery_type ? String(body.battery_type).trim() : null;

  if (weeeCategory) {
    const valid = db.prepare('SELECT 1 FROM weee_categories WHERE code = ?').get(weeeCategory);
    if (!valid) throw new Error(`Unbekannte WEEE-Kategorie: ${weeeCategory}`);
  }
  if (batteryType) {
    const valid = db.prepare('SELECT 1 FROM battery_categories WHERE code = ?').get(batteryType);
    if (!valid) throw new Error(`Unbekannter Batterietyp: ${batteryType}`);
  }

  return {
    is_electrical_equipment: isElectricalEquipment ? 1 : 0,
    weee_category: weeeCategory,
    contains_battery: containsBattery ? 1 : 0,
    battery_type: batteryType
  };
}

// Optionale Stückzahl/Jahr für den Material-Spar-Rechner (siehe
// lib/material-savings.js) - ohne gültigen Wert bleibt sie NULL, der
// Rechner zeigt dann nur die Ersparnis pro Stück statt pro Jahr.
function readEstimatedAnnualUnits(body = {}) {
  const value = Number(body.estimated_annual_units);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

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
// AUFFÄLLIGE MATERIALGEWICHTE (mögliche Tippfehler/Falschangaben)
//
// Siehe lib/sku-anomalies.js - vergleicht die Materialgewichte gegen den
// über ALLE Kunden gepoolten Median gleicher Icon/Material-Kombinationen,
// damit sowohl der Shop-Betreiber selbst als auch (siehe
// routes/representatives.js) der Bevollmächtigte offensichtliche
// Ausreißer sofort sehen, statt sie erst bei der Meldung zu bemerken.
// ============================================================
router.get('/anomalies', (req, res) => {
  try {
    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ?
    `).all(req.customer.sub);
    res.json(findAnomalousSkus(skus));
  } catch (error) {
    console.error('❌ Anomalie-Erkennungs-Fehler:', error);
    res.status(500).json({ error: 'Anomalie-Prüfung fehlgeschlagen.' });
  }
});

// ============================================================
// MATERIAL-SPAR-RECHNER
//
// Siehe lib/material-savings.js - rein informativ, schlägt keine
// konkreten Alternativmaterialien vor (physische Eignung kann das
// System nicht beurteilen), zeigt nur die €-Differenz einer vom
// Nutzer selbst gewählten Alternative.
// ============================================================
router.get('/material-rates', (req, res) => {
  try {
    res.json(getRates());
  } catch (error) {
    console.error('❌ Fehler beim Laden der Material-Lizenzsätze:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Lizenzsätze.' });
  }
});

router.get('/material-costs', (req, res) => {
  try {
    const skus = db.prepare(`SELECT * FROM product_packaging WHERE customer_id = ?`).all(req.customer.sub);
    const rates = getRates();
    res.json(skus.map(sku => computeSkuCost(sku, rates)));
  } catch (error) {
    console.error('❌ Fehler bei der Material-Kostenberechnung:', error);
    res.status(500).json({ error: 'Kostenberechnung fehlgeschlagen.' });
  }
});

router.post('/:id/simulate-material', (req, res) => {
  try {
    const sku = db.prepare('SELECT * FROM product_packaging WHERE id = ? AND customer_id = ?')
      .get(req.params.id, req.customer.sub);
    if (!sku) return res.status(404).json({ error: 'Produkt nicht gefunden.' });

    let materials;
    try { materials = JSON.parse(sku.materials_json); } catch (e) { materials = []; }
    const line = Array.isArray(materials) ? materials[req.body.materialIndex] : null;
    if (!line) return res.status(400).json({ error: 'Materialzeile nicht gefunden.' });

    const { altMaterial, altSubtype, altWeightGrams } = req.body;
    if (!altMaterial || !Number.isFinite(Number(altWeightGrams))) {
      return res.status(400).json({ error: 'Alternativmaterial und -gewicht sind erforderlich.' });
    }

    const rates = getRates();
    const result = simulateAlternative({
      currentWeightGrams: Number(line.weight_grams),
      currentMaterial: line.material,
      currentSubtype: line.material_subtype || null,
      altWeightGrams: Number(altWeightGrams),
      altMaterial,
      altSubtype: altSubtype || null,
      annualUnits: Number(sku.estimated_annual_units)
    }, rates);

    if (result.error) return res.status(422).json(result);
    res.json(result);
  } catch (error) {
    console.error('❌ Fehler bei der Material-Simulation:', error);
    res.status(500).json({ error: 'Simulation fehlgeschlagen.' });
  }
});

// ============================================================
// NEUEN SKU ANLEGEN
// ============================================================
router.post('/', (req, res) => {
  try {
    const { sku_name, icon, shopify_product_id, destination, materials } = req.body;
    const customer_id = req.customer.sub;

    if (!sku_name || !materials || materials.length === 0) {
      return res.status(400).json({ error: 'Produktname und Materialien sind erforderlich.' });
    }

    const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
    const materials_json = JSON.stringify(materials);
    const classification = readClassification(req.body);
    const estimatedAnnualUnits = readEstimatedAnnualUnits(req.body);

    const result = db.prepare(`
      INSERT INTO product_packaging
      (customer_id, sku_name, icon, shopify_product_id, destination, materials_json, total_weight_grams,
       is_electrical_equipment, weee_category, contains_battery, battery_type, estimated_annual_units)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer_id, sku_name, icon || null, shopify_product_id || null, destination || null, materials_json, total_weight,
      classification.is_electrical_equipment, classification.weee_category,
      classification.contains_battery, classification.battery_type, estimatedAnnualUnits
    );

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
    const { sku_name, icon, shopify_product_id, destination, materials } = req.body;
    const customer_id = req.customer.sub;

    // Prüfen, ob SKU existiert und dem Kunden gehört
    const existing = db.prepare('SELECT id FROM product_packaging WHERE id = ? AND customer_id = ?')
      .get(id, customer_id);
    if (!existing) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }

    const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
    const materials_json = JSON.stringify(materials);
    const classification = readClassification(req.body);
    const estimatedAnnualUnits = readEstimatedAnnualUnits(req.body);

    db.prepare(`
      UPDATE product_packaging
      SET sku_name = ?, icon = ?, shopify_product_id = ?, destination = ?, materials_json = ?, total_weight_grams = ?,
          is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
          estimated_annual_units = ?, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(
      sku_name, icon || null, shopify_product_id || null, destination || null, materials_json, total_weight,
      classification.is_electrical_equipment, classification.weee_category,
      classification.contains_battery, classification.battery_type,
      estimatedAnnualUnits,
      id, customer_id
    );

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
