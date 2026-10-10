const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { findAnomalousSkus } = require('../lib/sku-anomalies');
const { getRates, computeSkuCost, simulateAlternative } = require('../lib/material-savings');
const { estimatePackaging } = require('../lib/packaging-estimate');
const { buildClusters, clusterStats, runClusterImport } = require('../lib/cluster-import');
const { computeKnowledgeBase } = require('../lib/knowledge-base');

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
// Herkunft der Verpackungsdaten (siehe packaging_data_source in
// db/index.js): 'supplier' = Lieferanten-Datenblatt, 'preset' = noch
// unveränderter Startwert aus Vorlage/Wissensdatenbank, alles andere
// bedeutet "eigene Angabe" (NULL). Die Belegangabe ist nur zusammen mit
// einer Lieferanten-Angabe sinnvoll und wird sonst verworfen.
const PACKAGING_DATA_SOURCES = ['supplier', 'preset'];

// Produktart = Schlüssel aus der festen Vorlagen-Liste (PRODUCT_PRESETS im
// Dashboard). Nur das Format wird geprüft, damit neue Vorlagen im
// Frontend ohne Backend-Änderung funktionieren.
function readProductType(body = {}) {
  const value = String(body.product_type || '').trim();
  return /^[a-z0-9_]{1,40}$/.test(value) && value !== 'custom' ? value : null;
}

const DANGEROUS_GOODS_TYPES = ['aerosol', 'flammable_liquid'];

function readDangerousGoods(body = {}) {
  return DANGEROUS_GOODS_TYPES.includes(body.dangerous_goods) ? body.dangerous_goods : null;
}

function readPackagingDataSource(body = {}) {
  const source = PACKAGING_DATA_SOURCES.includes(body.packaging_data_source) ? body.packaging_data_source : null;
  const ref = source === 'supplier' && body.packaging_data_source_ref
    ? String(body.packaging_data_source_ref).trim().slice(0, 200) || null
    : null;
  return { packaging_data_source: source, packaging_data_source_ref: ref };
}

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
// ============================================================
// WISSENSDATENBANK (siehe lib/knowledge-base.js)
//
// Typische Verpackungsgewichte/-maße je Produktart über alle Kunden -
// nur aggregiert (Median, ab 3 Kunden), nie Einzelwerte. Der SKU-Editor
// schlägt daraus Werte vor, sobald eine Produktart gewählt ist.
// ============================================================
router.get('/knowledge-base', (req, res) => {
  try {
    res.json(computeKnowledgeBase());
  } catch (error) {
    console.error('❌ Fehler beim Laden der Wissensdatenbank:', error);
    res.status(500).json({ error: 'Wissensdatenbank konnte nicht geladen werden.' });
  }
});

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

// ============================================================
// KI-VERPACKUNGSSCHÄTZUNG (Kundenwunsch 10/2026)
//
// Liefert eine grobe Materialien-/Gewichtsschätzung für ein per Produkt-
// name benanntes Produkt, als Ergänzung zu den statischen Kategorie-
// Presets (NICHE_DEFAULT_MATERIALS in dashboard.html). Prompt/Schema/Aufruf
// leben in lib/packaging-estimate.js - dieselbe Logik nutzt auch der
// Cluster-Batch-Import (lib/cluster-import.js, siehe Bella-Rosa-
// Katalogimport), um nicht zweimal gepflegt werden zu müssen. Ergebnis
// wird hier NICHT gespeichert - der Kunde muss es im Formular aktiv
// übernehmen/anpassen, genau wie bei den Kategorie-Presets.
// ============================================================

// Kostet pro Aufruf einen echten KI-Request - großzügig, aber begrenzt
// gegen Missbrauch als kostenlosen Text-Generator.
const packagingEstimateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Schätzungs-Anfragen. Bitte in ein paar Minuten erneut versuchen.' }
});

router.post('/estimate-packaging', packagingEstimateLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'KI-Schätzung ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
  }

  const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim().slice(0, 200) : '';
  if (!productName) {
    return res.status(400).json({ error: 'Bitte zuerst einen Produktnamen eingeben.' });
  }

  try {
    const { components, confidenceNote } = await estimatePackaging(productName);
    res.json({ components, confidenceNote });
  } catch (error) {
    console.error('❌ KI-Verpackungsschätzung-Fehler:', error);
    res.status(503).json({ error: 'KI-Schätzung gerade nicht verfügbar. Bitte später erneut versuchen.' });
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

// Excel speichert EAN-Spalten oft als Zahl statt Text - dabei entstehen
// Fließkomma-Artefakte wie "8809738316986.11" statt der echten EAN
// "8809738316986" (beobachtet in der Bella-Rosa-Quelldatei). Nimmt nur
// die führende Ziffernfolge, verwirft alles ab dem ersten
// Nicht-Ziffern-Zeichen. Werte unter 8 Ziffern sind keine echte EAN
// (z.B. Platzhalter wie "-" oder "0" in schlechten ERP-Exporten).
// Ausgelagert, damit findExistingSkuByEan() unten dieselbe Normalisierung
// vor dem Vergleich anwendet wie createSkuRow() vor dem Speichern -
// sonst würde "8809738316986.11" nie auf die gespeicherte "8809738316986"
// treffen und der Dublettenschutz im Cluster-Import liefe ins Leere.
function normalizeEan(raw) {
  const digits = raw ? String(raw).trim().match(/^\d+/)?.[0] : null;
  return digits && digits.length >= 8 ? digits.slice(0, 20) : null;
}

// Kern-Logik von POST / unten, ausgelagert in eine eigene Funktion, damit
// sie auch vom Cluster-Batch-Import (lib/cluster-import.js, siehe
// Bella-Rosa-Katalogimport) ohne Codeverdopplung genutzt werden kann -
// derselbe Aufbau wie bei linkSkuRow weiter unten. Wirft einen
// sprechenden Error statt eine Response zu schreiben.
function createSkuRow(customerId, data = {}) {
  const { sku_name, icon, shopify_product_id, baselinker_sku, destination, materials } = data;

  if (!sku_name || !materials || materials.length === 0) {
    const error = new Error('Produktname und Materialien sind erforderlich.');
    error.status = 400;
    throw error;
  }

  const total_weight = materials.reduce((sum, m) => sum + (m.weight_grams || 0), 0);
  const materials_json = JSON.stringify(materials);
  const classification = readClassification(data);
  const estimatedAnnualUnits = readEstimatedAnnualUnits(data);
  const productNiche = readProductNiche(data);
  const dimensions = readDimensions(data);
  // Nur vom Cluster-Batch-Import gesetzt (siehe lib/cluster-import.js) -
  // der normale SKU-Editor kennt diese Felder nicht, bleiben also NULL.
  const clusterKey = data.cluster_key ? String(data.cluster_key).trim().slice(0, 200) : null;
  // Excel speichert EAN-Spalten oft als Zahl statt Text - dabei entstehen
  // Fließkomma-Artefakte wie "8809738316986.11" statt der echten EAN
  // "8809738316986" (beobachtet in der Bella-Rosa-Quelldatei). Nimmt nur
  // die führende Ziffernfolge, verwirft alles ab dem ersten
  // Nicht-Ziffern-Zeichen. Werte unter 8 Ziffern sind keine echte EAN
  // (z.B. Platzhalter wie "-" oder "0" in schlechten ERP-Exporten).
  const ean = normalizeEan(data.ean);
  // Nur vom Cluster-Batch-Import gesetzt (siehe lib/cluster-import.js) -
  // der normale SKU-Editor kennt dieses Feld nicht, bleibt also NULL.
  const confidenceNote = data.confidence_note ? String(data.confidence_note).trim().slice(0, 300) || null : null;
  const dataSource = readPackagingDataSource(data);
  const productType = readProductType(data);
  const dangerousGoods = readDangerousGoods(data);

  const result = db.prepare(`
    INSERT INTO product_packaging
    (customer_id, sku_name, icon, shopify_product_id, baselinker_sku, destination, materials_json, total_weight_grams,
     is_electrical_equipment, weee_category, contains_battery, battery_type, estimated_annual_units, product_niche,
     length_cm, width_cm, height_cm, cluster_key, ean, confidence_note,
     packaging_data_source, packaging_data_source_ref, product_type, dangerous_goods)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customerId, sku_name, icon || null, shopify_product_id || null, baselinker_sku || null, destination || null, materials_json, total_weight,
    classification.is_electrical_equipment, classification.weee_category,
    classification.contains_battery, classification.battery_type, estimatedAnnualUnits, productNiche,
    dimensions.length_cm, dimensions.width_cm, dimensions.height_cm, clusterKey, ean, confidenceNote,
    dataSource.packaging_data_source, dataSource.packaging_data_source_ref, productType, dangerousGoods
  );

  return db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(result.lastInsertRowid);
}

// ============================================================
// NEUEN SKU ANLEGEN
// ============================================================
router.post('/', (req, res) => {
  try {
    const newSku = createSkuRow(req.customer.sub, req.body);
    res.status(201).json(newSku);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
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
    const existing = db.prepare('SELECT id, packaging_data_source, packaging_data_source_ref, product_type, dangerous_goods FROM product_packaging WHERE id = ? AND customer_id = ?')
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
    // Ältere Clients ohne das Feld sollen eine bestehende Lieferanten-
    // Angabe nicht stillschweigend löschen - nur ein explizit
    // mitgeschicktes Feld (auch null = "eigene Angabe") ändert sie.
    const dataSource = 'packaging_data_source' in req.body
      ? readPackagingDataSource(req.body)
      : { packaging_data_source: existing.packaging_data_source, packaging_data_source_ref: existing.packaging_data_source_ref };
    const productType = 'product_type' in req.body ? readProductType(req.body) : existing.product_type;
    const dangerousGoods = 'dangerous_goods' in req.body ? readDangerousGoods(req.body) : existing.dangerous_goods;

    // Ein direktes Bearbeiten der Materialien bedeutet immer "dieser
    // Artikel bekommt jetzt seine eigenen, unabhängigen Materialien" -
    // eine bestehende Verknüpfung (siehe /:id/link) wird dabei aufgelöst,
    // sonst stünde die Zeile widersprüchlich sowohl verknüpft als auch mit
    // abweichenden eigenen Werten da. Das Frontend bietet die
    // Materialfelder für verknüpfte Artikel ohnehin nicht zum Bearbeiten
    // an (siehe dashboard.html) - dies ist nur das Sicherheitsnetz.
    // Code-Review-Punkt 10/2026: manuelles Bearbeiten der Materialien gilt
    // als Bestätigung - eine evtl. vorhandene "unbestätigte KI-Schätzung"
    // (siehe confidence_note, vom Cluster-Import gesetzt) ist damit erledigt.
    db.prepare(`
      UPDATE product_packaging
      SET sku_name = ?, icon = ?, shopify_product_id = ?, baselinker_sku = ?, destination = ?, materials_json = ?, total_weight_grams = ?,
          is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
          estimated_annual_units = ?, product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?,
          packaging_data_source = ?, packaging_data_source_ref = ?, product_type = ?, dangerous_goods = ?,
          linked_to_sku_id = NULL, confidence_note = NULL, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(
      sku_name, icon || null, shopify_product_id || null, baselinker_sku || null, destination || null, materials_json, total_weight,
      classification.is_electrical_equipment, classification.weee_category,
      classification.contains_battery, classification.battery_type,
      estimatedAnnualUnits, productNiche,
      dimensions.length_cm, dimensions.width_cm, dimensions.height_cm,
      dataSource.packaging_data_source, dataSource.packaging_data_source_ref, productType, dangerousGoods,
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
      height_cm: dimensions.height_cm,
      packaging_data_source: dataSource.packaging_data_source,
      packaging_data_source_ref: dataSource.packaging_data_source_ref,
      product_type: productType,
      dangerous_goods: dangerousGoods
    });

    const updated = db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Aktualisieren des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Produkts: ' + error.message });
  }
});

// ============================================================
// EXTERNE PRODUKT-ID SETZEN (Produkt-Picker, siehe dashboard.html)
//
// Kundenwunsch 10/2026: statt die Shop-Produkt-ID manuell ins SKU-Formular
// einzutippen, soll man sie aus einer geholten Produktliste des jeweils
// verbundenen Shops auswählen können (zuerst Shopify/WooCommerce, weitere
// Plattformen folgen). Eine Spalte pro Plattform (siehe db/index.js) -
// Mapping bewusst hart codiert (keine dynamische Spalten-Namen aus
// Nutzereingaben), gleiches Sicherheitsprinzip wie MARKETPLACE_SKU_FIELDS
// in lib/marketplace-auto-sku.js.
const EXTERNAL_LINK_FIELDS = {
  shopify: 'shopify_product_id',
  woocommerce: 'woocommerce_product_id',
  kaufland: 'kaufland_product_id',
  emag: 'emag_product_id',
  baselinker: 'baselinker_sku',
  skroutz: 'skroutz_shop_uid',
  etsy: 'etsy_listing_id',
  amazon: 'amazon_sku',
  ebay: 'ebay_item_id',
  shein: 'shein_product_id',
  temu: 'temu_product_id'
};

// ============================================================
// NUR MASSE SETZEN (Kundenwunsch 10/2026: fehlende Maße direkt im
// Bestell-Dialog nachtragen, siehe renderOrderBoxRecommendation()).
// Eigener Endpunkt statt PUT /:id, weil PUT den kompletten Artikel
// erwartet und fehlende Felder sonst überschreiben würde. Verknüpfte
// Varianten bekommen die Maße wie bei PUT mit.
// ============================================================
router.patch('/:id/dimensions', (req, res) => {
  try {
    const customerId = req.customer.sub;
    const dims = readDimensions(req.body);
    if (dims.length_cm === null || dims.width_cm === null || dims.height_cm === null) {
      return res.status(400).json({ error: 'Bitte alle drei Maße (Länge, Breite, Höhe in cm) angeben.' });
    }
    const result = db.prepare(`
      UPDATE product_packaging SET length_cm = ?, width_cm = ?, height_cm = ?, updated_at = datetime('now')
      WHERE id = ? AND customer_id = ?
    `).run(dims.length_cm, dims.width_cm, dims.height_cm, req.params.id, customerId);
    if (result.changes === 0) return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    db.prepare(`
      UPDATE product_packaging SET length_cm = ?, width_cm = ?, height_cm = ?, updated_at = datetime('now')
      WHERE customer_id = ? AND linked_to_sku_id = ?
    `).run(dims.length_cm, dims.width_cm, dims.height_cm, customerId, req.params.id);
    res.json(db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(req.params.id));
  } catch (error) {
    console.error('❌ Fehler beim Speichern der Maße:', error);
    res.status(500).json({ error: 'Maße konnten nicht gespeichert werden.' });
  }
});

router.post('/:id/external-link', (req, res) => {
  try {
    const { id } = req.params;
    const { platform, externalId, imageUrl } = req.body || {};
    const customer_id = req.customer.sub;

    const column = EXTERNAL_LINK_FIELDS[platform];
    if (!column) {
      return res.status(400).json({ error: 'Unbekannte Plattform.' });
    }

    const existing = db.prepare('SELECT id FROM product_packaging WHERE id = ? AND customer_id = ?').get(id, customer_id);
    if (!existing) {
      return res.status(404).json({ error: 'Produkt nicht gefunden.' });
    }

    const value = String(externalId || '').trim() || null;
    // Produktbild nur übernehmen, wenn tatsächlich verknüpft wird (value
    // gesetzt) UND der Connector eins mitgeschickt hat - beim Entlinken
    // (value === null) bleibt ein bereits übernommenes Bild bewusst
    // stehen, es ist kein Bestandteil der Verknüpfung selbst.
    if (value && imageUrl) {
      db.prepare(`UPDATE product_packaging SET ${column} = ?, image_url = ?, updated_at = datetime('now') WHERE id = ? AND customer_id = ?`)
        .run(value, String(imageUrl).trim() || null, id, customer_id);
    } else {
      db.prepare(`UPDATE product_packaging SET ${column} = ?, updated_at = datetime('now') WHERE id = ? AND customer_id = ?`)
        .run(value, id, customer_id);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Fehler beim Verknüpfen der externen Produkt-ID:', error);
    res.status(500).json({ error: 'Fehler beim Verknüpfen.' });
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
        product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?, confidence_note = NULL,
        packaging_data_source = ?, packaging_data_source_ref = ?, product_type = ?, dangerous_goods = ?, updated_at = datetime('now')
    WHERE customer_id = ? AND linked_to_sku_id = ?
  `).run(
    data.materials_json, data.total_weight,
    data.is_electrical_equipment, data.weee_category, data.contains_battery, data.battery_type,
    data.product_niche, data.length_cm, data.width_cm, data.height_cm,
    data.packaging_data_source, data.packaging_data_source_ref, data.product_type, data.dangerous_goods,
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
// Kern-Logik von POST /:id/link, ausgelagert in eine eigene Funktion, die
// einen sprechenden Error wirft statt eine Response zu schreiben - damit
// sie sowohl von der Einzel-Route unten als auch von POST /bulk-link
// (Massen-Verknüpfung per CSV, siehe dort) ohne Codeverdopplung genutzt
// werden kann.
function linkSkuRow(customerId, sourceId, targetId) {
  if (targetId === sourceId) {
    throw new Error('Ein Artikel kann nicht mit sich selbst verknüpft werden.');
  }

  const self = db.prepare('SELECT id FROM product_packaging WHERE id = ? AND customer_id = ?').get(sourceId, customerId);
  if (!self) throw new Error('Produkt nicht gefunden.');

  let target = db.prepare('SELECT * FROM product_packaging WHERE id = ? AND customer_id = ?').get(targetId, customerId);
  if (!target) throw new Error('Zielartikel nicht gefunden.');

  // Keine Verknüpfungsketten (A→B→C) - zeigt der gewählte Zielartikel
  // selbst schon auf einen anderen, wird direkt dessen Hauptartikel
  // verwendet. Hält die Auflösung beim Lesen überall einstufig.
  if (target.linked_to_sku_id) {
    const root = db.prepare('SELECT * FROM product_packaging WHERE id = ? AND customer_id = ?')
      .get(target.linked_to_sku_id, customerId);
    if (root) target = root;
  }
  if (target.id === sourceId) {
    throw new Error('Ein Artikel kann nicht mit sich selbst verknüpft werden.');
  }

  db.prepare(`
    UPDATE product_packaging
    SET linked_to_sku_id = ?, materials_json = ?, total_weight_grams = ?,
        is_electrical_equipment = ?, weee_category = ?, contains_battery = ?, battery_type = ?,
        product_niche = ?, length_cm = ?, width_cm = ?, height_cm = ?, confidence_note = ?,
        packaging_data_source = ?, packaging_data_source_ref = ?, product_type = ?, dangerous_goods = ?, updated_at = datetime('now')
    WHERE id = ? AND customer_id = ?
  `).run(
    target.id, target.materials_json, target.total_weight_grams,
    target.is_electrical_equipment, target.weee_category, target.contains_battery, target.battery_type,
    target.product_niche, target.length_cm, target.width_cm, target.height_cm, target.confidence_note,
    target.packaging_data_source, target.packaging_data_source_ref, target.product_type, target.dangerous_goods,
    sourceId, customerId
  );

  return db.prepare('SELECT * FROM product_packaging WHERE id = ?').get(sourceId);
}

router.post('/:id/link', (req, res) => {
  try {
    const { id } = req.params;
    const customer_id = req.customer.sub;
    const targetId = Number(req.body.target_sku_id);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Zielartikel fehlt.' });
    }

    const updated = linkSkuRow(customer_id, Number(id), targetId);
    res.json(updated);
  } catch (error) {
    if (error.message === 'Produkt nicht gefunden.' || error.message === 'Zielartikel nicht gefunden.') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Ein Artikel kann nicht mit sich selbst verknüpft werden.') {
      return res.status(400).json({ error: error.message });
    }
    console.error('❌ Fehler beim Verknüpfen des SKUs:', error);
    res.status(500).json({ error: 'Fehler beim Verknüpfen: ' + error.message });
  }
});

// ============================================================
// SKUS IN MASSE VERKNÜPFEN (CSV-Import)
//
// Kundenwunsch: bei einigen tausend Artikeln (Obergruppen + Farb-
// varianten, z.B. "Nagellack Jade" in 20 Farben) ist Einzel-Verknüpfung
// über die UI nicht praktikabel. Jede CSV-Zeile nennt eine Variante und
// ihren Hauptartikel - beide werden wahlweise über die bereits
// hinterlegte Base/BaseLinker-SKU ODER den Produktnamen aufgelöst (siehe
// resolveSkuByIdentifier()), damit ein Export direkt aus Base/BaseLinker
// (wo die Artikel ohnehin schon stehen) ohne Umbenennen als Vorlage für
// die Verknüpfungs-CSV dient - der Händler muss die Artikel dafür nicht
// erst in Pack2EU-Begriffe übersetzen.
// ============================================================
function resolveSkuByIdentifier(customerId, identifier) {
  const bySkuCode = db.prepare(`
    SELECT * FROM product_packaging WHERE customer_id = ? AND baselinker_sku = ?
  `).get(customerId, identifier);
  if (bySkuCode) return bySkuCode;

  // Fallback auf den Produktnamen (case-insensitive, da von Hand
  // übertragen/exportiert wird und Groß-/Kleinschreibung leicht abweicht).
  return db.prepare(`
    SELECT * FROM product_packaging WHERE customer_id = ? AND LOWER(sku_name) = LOWER(?)
  `).get(customerId, identifier);
}

router.post('/bulk-link', (req, res) => {
  try {
    const customer_id = req.customer.sub;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Keine Zeilen zum Verarbeiten übermittelt.' });
    }

    let linked = 0;
    const errors = [];

    rows.forEach((row, index) => {
      const rowNumber = index + 2; // Zeile 1 ist der CSV-Header
      const articleIdentifier = String(row.artikel || '').trim();
      const mainArticleIdentifier = String(row.hauptartikel || '').trim();

      if (!articleIdentifier || !mainArticleIdentifier) {
        errors.push({ row: rowNumber, error: 'Spalte "artikel" oder "hauptartikel" fehlt.' });
        return;
      }

      const article = resolveSkuByIdentifier(customer_id, articleIdentifier);
      if (!article) {
        errors.push({ row: rowNumber, error: `Artikel "${articleIdentifier}" nicht gefunden.` });
        return;
      }
      const mainArticle = resolveSkuByIdentifier(customer_id, mainArticleIdentifier);
      if (!mainArticle) {
        errors.push({ row: rowNumber, error: `Hauptartikel "${mainArticleIdentifier}" nicht gefunden.` });
        return;
      }

      try {
        linkSkuRow(customer_id, article.id, mainArticle.id);
        linked++;
      } catch (linkError) {
        errors.push({ row: rowNumber, error: linkError.message });
      }
    });

    res.json({
      success: true,
      linked,
      errors,
      total: rows.length,
      message: errors.length === 0
        ? `✅ ${linked} Artikel erfolgreich verknüpft!`
        : `⚠️ ${linked} Artikel verknüpft, ${errors.length} Fehler gefunden.`
    });
  } catch (error) {
    console.error('❌ Massen-Verknüpfung Fehler:', error);
    res.status(500).json({ error: 'Massen-Verknüpfung fehlgeschlagen: ' + error.message });
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

// ============================================================
// SELF-SERVICE CLUSTER-IMPORT (Kundenwunsch, Brainstorming nach Bella
// Rosa: "wir haben doch alles gebaut, nur jetzt als Self-Service")
//
// Exakt dieselbe lib/cluster-import.js-Logik wie beim Admin-gesteuerten
// Import (siehe routes/admin.js POST /customers/:id/cluster-import/*),
// nur kundenbezogen statt admin-ausgelöst: req.customer.sub statt einer
// Admin-übergebenen :id. Zusätzlich: kundenübergreifende "Sammel-
// datenbank"-Wiederverwendung (lookupSharedClusterMaterials) - jeder
// erfolgreiche Lauf, admin- oder kundenausgelöst, macht künftige Läufe
// für ALLE Kunden potenziell billiger.
// ============================================================

// Kundenübergreifend absichtlich OHNE customer_id-Filter - der ganze
// Witz der "Sammeldatenbank"-Idee (siehe cluster_key-Spalte,
// Kundenwunsch-Kommentar in db/index.js) ist, dass ein bei Kunde A schon
// recherchierter Cluster (z.B. "Schwarzkopf Haarfarbe 60ml") bei Kunde B
// kostenlos wiederverwendet wird, statt ein zweites Mal bezahlt zu
// werden. Nimmt bewusst die ÄLTESTE Zeile (ORDER BY created_at ASC) -
// die zuerst recherchierte gilt als die "Quelle", nicht eine beliebige
// spätere. Ausnahme (Kundenwunsch 10/2026): eine Zeile mit Lieferanten-
// Angabe (packaging_data_source = 'supplier') hat Vorrang vor älteren
// KI-Schätzungen desselben Clusters. Die Lieferanten-Markierung selbst
// wird bewusst NICHT mitkopiert - der übernehmende Kunde hat das
// Datenblatt nicht selbst vorliegen.
function lookupSharedClusterMaterials(clusterKey) {
  if (!clusterKey) return null;
  const row = db.prepare(`
    SELECT materials_json FROM product_packaging
    WHERE cluster_key = ? AND materials_json IS NOT NULL AND materials_json != '[]'
    ORDER BY (packaging_data_source = 'supplier') DESC, created_at ASC LIMIT 1
  `).get(clusterKey);
  if (!row) return null;
  try {
    const materials = JSON.parse(row.materials_json);
    return Array.isArray(materials) && materials.length ? materials : null;
  } catch (e) {
    return null;
  }
}

// Dublettenschutz für den Cluster-Import (Kundenwunsch: "das keine
// Dopplungen Dreifachungen vorkommen" - konkret: ein Katalog-Import darf
// keinen zweiten Artikel für ein Produkt anlegen, das für DIESEN Kunden
// schon existiert, egal ob es per Shop-Sync-Verknüpfung, manuell oder in
// einem früheren Cluster-Import entstanden ist). ANDERS als
// lookupSharedClusterMaterials() bewusst auf customerId gescoped - die
// EAN ist zwar global eindeutig, aber ob Kunde B's Artikel mit derselben
// EAN wie Kunde A "derselbe Artikel" ist, ist nicht unsere Entscheidung
// (z.B. Großhändler, die an mehrere Pack2EU-Kunden verkaufen).
function findExistingSkuByEan(customerId, rawEan) {
  const ean = normalizeEan(rawEan);
  if (!ean) return null;
  return db.prepare('SELECT id FROM product_packaging WHERE customer_id = ? AND ean = ? LIMIT 1').get(customerId, ean) || null;
}

// Großzügig genug für einen echten Großkatalog-Import, aber begrenzt
// gegen versehentliche/missbräuchliche Massen-KI-Kosten durch einen
// einzelnen Self-Service-Aufruf (anders als beim admin-gesteuerten
// Import, wo ein Mensch aus dem eigenen Team die Größenordnung vorher
// sieht).
const MAX_SELF_SERVICE_CLUSTERS = 5000;

// Eigener, großzügigerer Rate-Limiter als der Rest von /skus - ein
// echter Großkatalog-Import ist naturgemäß selten pro Kunde, aber die
// übliche kurze Fenster-Begrenzung würde hier eher stören als schützen.
const clusterImportStartLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Import-Starts. Bitte in ein paar Stunden erneut versuchen oder den Support kontaktieren.' }
});

router.post('/cluster-import/preview', (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.filter(r => r && r.name) : [];
    if (!rows.length) return res.status(400).json({ error: 'Keine verwertbaren Zeilen (Produktname fehlt überall).' });

    const clusters = buildClusters(rows);
    res.json(clusterStats(clusters));
  } catch (error) {
    console.error('❌ Cluster-Vorschau-Fehler:', error.message);
    res.status(500).json({ error: 'Vorschau fehlgeschlagen: ' + error.message });
  }
});

router.post('/cluster-import/start', clusterImportStartLimiter, (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'KI-Schätzung ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
    }

    const customerId = req.customer.sub;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.filter(r => r && r.name) : [];
    if (!rows.length) return res.status(400).json({ error: 'Keine verwertbaren Zeilen (Produktname fehlt überall).' });

    const clusters = buildClusters(rows);
    if (clusters.length > MAX_SELF_SERVICE_CLUSTERS) {
      return res.status(400).json({
        error: `${clusters.length} Cluster überschreiten das Self-Service-Limit von ${MAX_SELF_SERVICE_CLUSTERS}. Bitte Support kontaktieren.`
      });
    }

    const jobResult = db.prepare(`
      INSERT INTO cluster_import_jobs (customer_id, total_clusters, triggered_by) VALUES (?, ?, 'customer')
    `).run(customerId, clusters.length);
    const jobId = jobResult.lastInsertRowid;

    // Kundenwunsch: Admin soll Self-Service-Läufe sehen, nicht nur still
    // im Hintergrund ablaufen lassen - landet als normale Aufgabe in der
    // bestehenden Admin-Aufgabenliste (siehe /admin/tasks), kein eigenes
    // neues Panel nötig.
    const customer = db.prepare('SELECT company_name, customer_number FROM customers WHERE id = ?').get(customerId);
    db.prepare(`
      INSERT INTO admin_tasks (title, status) VALUES (?, 'open')
    `).run(`📦 Self-Service Cluster-Import gestartet: ${customer?.company_name || 'Kunde #' + customerId} (${customer?.customer_number || ''}) - ${clusters.length} Cluster`);

    res.json({ jobId, totalClusters: clusters.length });

    runClusterImport({
      customerId,
      rows,
      estimateFn: estimatePackaging,
      createSkuRowFn: createSkuRow,
      linkSkuRowFn: linkSkuRow,
      lookupSharedClusterFn: lookupSharedClusterMaterials,
      findExistingByEanFn: findExistingSkuByEan,
      withTransactionFn: (fn) => db.transaction(fn)(),
      concurrency: 5,
      onClusterDone: ({ createdCount, wasReused, duplicateCount }) => {
        db.prepare(`
          UPDATE cluster_import_jobs
          SET clusters_processed = clusters_processed + 1,
              products_created = products_created + ?,
              clusters_reused = clusters_reused + ?,
              duplicates_skipped = duplicates_skipped + ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(createdCount, wasReused ? 1 : 0, duplicateCount || 0, jobId);
      }
    }).then(result => {
      db.prepare(`
        UPDATE cluster_import_jobs
        SET status = 'done', errors_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(result.errors), jobId);
    }).catch(error => {
      console.error('❌ Self-Service-Cluster-Import-Fehler:', error.message);
      db.prepare(`
        UPDATE cluster_import_jobs
        SET status = 'failed', errors_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify([{ error: error.message }]), jobId);
    });
  } catch (error) {
    console.error('❌ Self-Service-Cluster-Import-Start-Fehler:', error.message);
    res.status(500).json({ error: 'Import konnte nicht gestartet werden: ' + error.message });
  }
});

router.get('/cluster-import/:jobId/status', (req, res) => {
  const job = db.prepare('SELECT * FROM cluster_import_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden.' });
  // Kein Zugriff auf fremde Jobs - anders als im Admin-Panel ist dieser
  // Endpunkt kundenauthentifiziert, nicht admin-authentifiziert.
  if (job.customer_id !== req.customer.sub) {
    return res.status(404).json({ error: 'Job nicht gefunden.' });
  }
  res.json({
    id: job.id,
    status: job.status,
    totalClusters: job.total_clusters,
    clustersProcessed: job.clusters_processed,
    productsCreated: job.products_created,
    clustersReused: job.clusters_reused,
    duplicatesSkipped: job.duplicates_skipped,
    errors: JSON.parse(job.errors_json || '[]')
  });
});

module.exports = router;
// Für die Base-Katalog-Auto-Verknüpfung (siehe routes/baselinker.js) -
// nutzt dieselbe Verknüpfungslogik wie der Einzel- und CSV-Massen-Link,
// statt sie ein drittes Mal zu duplizieren.
module.exports.linkSkuRow = linkSkuRow;
// Für den CSV-Bestellungs-Bulk-Import (siehe routes/orders.js) - löst
// einen Artikel-Identifier genauso auf wie der CSV-Massen-Link oben
// (Base/BaseLinker-SKU oder Produktname), damit Kunden dieselbe
// Export-Vorlage für beide CSV-Importe verwenden können.
module.exports.resolveSkuByIdentifier = resolveSkuByIdentifier;
// Für den Cluster-Batch-Import (siehe lib/cluster-import.js, Bella-Rosa-
// Katalogimport) - legt den Master-SKU pro Cluster über dieselbe Logik an
// wie POST / oben, statt das INSERT ein zweites Mal zu pflegen.
module.exports.createSkuRow = createSkuRow;
// Für den admin-gesteuerten Cluster-Import (siehe routes/admin.js) -
// dieselbe kundenübergreifende Wiederverwendung wie beim Self-Service-
// Import, statt sie zweimal zu pflegen.
module.exports.lookupSharedClusterMaterials = lookupSharedClusterMaterials;
// Dito für den EAN-Dublettenschutz - derselbe Scoping-Mechanismus soll
// beim admin-gesteuerten Import gelten wie beim Self-Service.
module.exports.findExistingSkuByEan = findExistingSkuByEan;
