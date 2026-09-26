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

// Produkt-Nische aus dem Konfigurator (siehe PRODUCT_PRESETS/
// ONBOARDING_NICHES in dashboard.html) - rein informell, keine feste
// Liste im Backend (die Nischen-Definition lebt im Frontend), daher nur
// getrimmt und auf Länge begrenzt statt gegen eine Tabelle validiert.
function readProductNiche(body = {}) {
  const value = body.product_niche ? String(body.product_niche).trim().slice(0, 40) : null;
  return value || null;
}

// Kundenwunsch (Brainstorming): Produktmaße als Grundlage für eine
// künftige automatische Versandkarton-Auswahl (Gewicht allein reicht
// nicht - eine leichte Babyflasche ist deutlich größer als ein
// schwereres Parfum-Flakon). Bewusst KEINE Pflichtangabe wie bei den
// Verpackungsmaterialien - fehlt ein Wert oder ist er ungültig, bleibt
// er einfach NULL, ohne Validierungsfehler.
function readDimensions(body = {}) {
  function readOne(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return {
    length_cm: readOne(body.length_cm),
    width_cm: readOne(body.width_cm),
    height_cm: readOne(body.height_cm)
  };
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

// Länder mit stark nach Material-Unterklasse gestaffelten Öko-Beiträgen
// (aktuell nur Italien/CONAI) - siehe eco_fee_material_bands_json in
// db/index.js. Bewusst hinter demselben Login/Abo wie die restliche
// Spar-Rechner-Logik, NICHT über den öffentlichen /public-eco-fees-
// Endpoint erreichbar (siehe Kommentar dort zum recherchierten USP).
router.get('/eco-fee-bands/:countryCode', (req, res) => {
  try {
    const code = String(req.params.countryCode || '').trim().toUpperCase();
    const row = db.prepare('SELECT eco_fee_material_bands_json FROM countries WHERE code = ?').get(code);
    res.json(row && row.eco_fee_material_bands_json ? JSON.parse(row.eco_fee_material_bands_json) : null);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Material-Fasce-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Fasce-Daten.' });
  }
});

// Klassifizierungs-Assistent (aktuell nur Italien) - siehe
// eco_fee_classification_guide_json in db/index.js. Optionaler
// ?category=-Filter (z. B. "clothing", "beverage"), damit das Dashboard
// nur die für den jeweiligen Kunden-Produkttyp relevanten Einträge zeigen
// kann, ohne die volle Liste clientseitig filtern zu müssen - "category"
// ist rein informell und nicht abschließend, daher tolerant (kein Fehler
// bei unbekanntem Wert, einfach leeres Ergebnis).
router.get('/eco-fee-classification/:countryCode', (req, res) => {
  try {
    const code = String(req.params.countryCode || '').trim().toUpperCase();
    const row = db.prepare('SELECT eco_fee_classification_guide_json FROM countries WHERE code = ?').get(code);
    const guide = row && row.eco_fee_classification_guide_json ? JSON.parse(row.eco_fee_classification_guide_json) : null;
    if (!guide) return res.json(null);

    const category = req.query.category ? String(req.query.category).trim().toLowerCase() : null;
    if (!category) return res.json(guide);

    res.json({
      ...guide,
      eintraege: guide.eintraege.filter(e => e.category === category || e.category === 'general')
    });
  } catch (error) {
    console.error('❌ Fehler beim Laden der Klassifizierungs-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Klassifizierungs-Daten.' });
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
    const { sku_name, icon, shopify_product_id, baselinker_sku, destination, materials } = req.body;
    const customer_id = req.customer.sub;

    if (!sku_name || !materials || materials.length === 0) {
      return res.status(400).json({ error: 'Produktname und Materialien sind erforderlich.' });
    }

    const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
    const materials_json = JSON.stringify(materials);
    const classification = readClassification(req.body);
    const estimatedAnnualUnits = readEstimatedAnnualUnits(req.body);
    const productNiche = readProductNiche(req.body);
    const dimensions = readDimensions(req.body);

    const result = db.prepare(`
      INSERT INTO product_packaging
      (customer_id, sku_name, icon, shopify_product_id, baselinker_sku, destination, materials_json, total_weight_grams,
       is_electrical_equipment, weee_category, contains_battery, battery_type, estimated_annual_units, product_niche,
       length_cm, width_cm, height_cm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer_id, sku_name, icon || null, shopify_product_id || null, baselinker_sku || null, destination || null, materials_json, total_weight,
      classification.is_electrical_equipment, classification.weee_category,
      classification.contains_battery, classification.battery_type, estimatedAnnualUnits, productNiche,
      dimensions.length_cm, dimensions.width_cm, dimensions.height_cm
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
    const { sku_name, icon, shopify_product_id, baselinker_sku, destination, materials } = req.body;
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
    const productNiche = readProductNiche(req.body);
    const dimensions = readDimensions(req.body);

    // Ein direktes Bearbeiten der Materialien bedeutet immer "dieser
    // Artikel bekommt jetzt seine eigenen, unabhängigen Materialien" -
    // eine bestehende Verknüpfung (siehe /:id/link) wird dabei aufgelöst,
    // sonst stünde die Zeile widersprüchlich sowohl verknüpft als auch mit
    // abweichenden eigenen Werten da. Das Frontend bietet die
    // Materialfelder für verknüpfte Artikel ohnehin nicht zum Bearbeiten
    // an (siehe dashboard.html) - dies ist nur das Sicherheitsnetz.
    db.prepare(`
      UPDATE product_packaging
      SET sku_name = ?, icon = ?, shopify_product_id = ?, baselinker_sku = ?, destination = ?, materials_json = ?, total_weight_grams = ?,
          is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
          estimated_annual_units = ?, product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?,
          linked_to_sku_id = NULL, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(
      sku_name, icon || null, shopify_product_id || null, baselinker_sku || null, destination || null, materials_json, total_weight,
      classification.is_electrical_equipment, classification.weee_category,
      classification.contains_battery, classification.battery_type,
      estimatedAnnualUnits, productNiche,
      dimensions.length_cm, dimensions.width_cm, dimensions.height_cm,
      id, customer_id
    );

    cascadeToLinkedVariants(customer_id, id, {
      materials_json, total_weight,
      is_electrical_equipment: classification.is_electrical_equipment,
      weee_category: classification.weee_category,
      contains_battery: classification.contains_battery,
      battery_type: classification.battery_type,
      product_niche: productNiche,
      length_cm: dimensions.length_cm,
      width_cm: dimensions.width_cm,
      height_cm: dimensions.height_cm
    });

    const updated = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Aktualisieren des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Produkts: ' + error.message });
  }
});

// Aktualisiert alle Varianten, die über linked_to_sku_id auf sourceId
// verweisen (siehe Kommentar bei product_packaging.linked_to_sku_id in
// db/index.js) - hält z.B. alle Farbvarianten eines Nagellacks bei einer
// späteren Korrektur der Verpackung automatisch synchron.
function cascadeToLinkedVariants(customerId, sourceId, data) {
  db.prepare(`
    UPDATE product_packaging
    SET materials_json = ?, total_weight_grams = ?,
        is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
        product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?, updated_at = datetime('now')
    WHERE customer_id = ? AND linked_to_sku_id = ?
  `).run(
    data.materials_json, data.total_weight,
    data.is_electrical_equipment, data.weee_category, data.contains_battery, data.battery_type,
    data.product_niche, data.length_cm, data.width_cm, data.height_cm,
    customerId, sourceId
  );
}

// ============================================================
// SKU MIT BESTEHENDEM ARTIKEL VERKNÜPFEN
//
// Kundenwunsch (Brainstorming): Farbvarianten desselben Produkts (z.B.
// Nagellack in 20 Farben) teilen sich fast immer dieselbe Verpackung,
// haben aber oft eigene Marktplatz-SKUs. Statt jede Farbe einzeln zu
// klassifizieren, verknüpft der Nutzer sie bewusst mit einem bereits
// erfassten "Hauptartikel" - dessen Material-/Klassifizierungsdaten
// werden übernommen und bei jeder späteren Änderung des Hauptartikels
// automatisch nachgezogen (siehe cascadeToLinkedVariants oben).
// ============================================================
router.post('/:id/link', (req, res) => {
  try {
    const { id } = req.params;
    const customer_id = req.customer.sub;
    const targetId = Number(req.body.target_sku_id);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Zielartikel fehlt.' });
    }
    if (targetId === Number(id)) {
      return res.status(400).json({ error: 'Ein Artikel kann nicht mit sich selbst verknüpft werden.' });
    }

    const self = db.prepare('SELECT id FROM product_packaging WHERE id = ? AND customer_id = ?').get(id, customer_id);
    if (!self) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }

    let target = db.prepare('SELECT * FROM product_packaging WHERE id = ? AND customer_id = ?').get(targetId, customer_id);
    if (!target) {
      return res.status(404).json({ error: 'Zielartikel nicht gefunden.' });
    }

    // Keine Verknüpfungsketten (A→B→C) - zeigt der gewählte Zielartikel
    // selbst schon auf einen anderen, wird direkt dessen Hauptartikel
    // verwendet. Hält die Auflösung beim Lesen überall einstufig.
    if (target.linked_to_sku_id) {
      const root = db.prepare('SELECT * FROM product_packaging WHERE id = ? AND customer_id = ?')
        .get(target.linked_to_sku_id, customer_id);
      if (root) target = root;
    }
    if (target.id === Number(id)) {
      return res.status(400).json({ error: 'Ein Artikel kann nicht mit sich selbst verknüpft werden.' });
    }

    db.prepare(`
      UPDATE product_packaging
      SET linked_to_sku_id = ?, materials_json = ?, total_weight_grams = ?,
          is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
          product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(
      target.id, target.materials_json, target.total_weight_grams,
      target.is_electrical_equipment, target.weee_category, target.contains_battery, target.battery_type,
      target.product_niche, target.length_cm, target.width_cm, target.height_cm,
      id, customer_id
    );

    const updated = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Verknüpfen des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Verknüpfen: ' + error.message });
  }
});

router.post('/:id/unlink', (req, res) => {
  try {
    const { id } = req.params;
    const customer_id = req.customer.sub;

    const result = db.prepare(`
      UPDATE product_packaging SET linked_to_sku_id = NULL, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(id, customer_id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }

    const updated = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Trennen der Verknüpfung:', error);
    res.status(500).json({ error: 'Fehler beim Trennen der Verknüpfung: ' + error.message });
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
