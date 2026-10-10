// lib/knowledge-base.js
//
// Wissensdatenbank für Verpackungsgewichte und -maße (Kundenwunsch 10/2026):
// typische Werte je Produktart (product_packaging.product_type, Schlüssel
// aus der festen Vorlagen-Liste PRODUCT_PRESETS im Dashboard), gebildet aus
// den Artikeln ALLER Kunden. Wächst mit jedem Kunden von selbst - eine
// offene externe Quelle mit Gewichten UND Maßen gibt es nicht (Open Food/
// Beauty Facts hat keine Maße und für Kosmetik praktisch keine Gewichte,
// GVM ist kostenpflichtig).
//
// Datenqualität:
// - Gewicht 3: Lieferanten-Datenblatt (packaging_data_source = 'supplier')
// - Gewicht 1: eigene Angabe des Händlers
// - gar nicht: unbestätigte KI-Schätzungen (confidence_note gesetzt) und
//   unveränderte Startwerte aus Vorlage/Wissensdatenbank ('preset') - sonst
//   bestätigt sich die Datenbank nur selbst.
// - verknüpfte Varianten (linked_to_sku_id) zählen nicht extra, sie sind
//   Kopien ihres Hauptartikels.
// Jeder Kunde zählt höchstens mit seinem Qualitätsgewicht, egal wie viele
// Artikel derselben Produktart er hat (Gewicht wird auf seine Artikel
// verteilt) - ein Großkunde mit 200 Nagellacken soll den Wert nicht allein
// bestimmen.
//
// Datenschutz: eine Produktart erscheint erst ab MIN_CUSTOMERS
// verschiedenen Kunden, und es werden nur Mediane ausgegeben, nie
// Einzelwerte oder Kundennamen.
const { db } = require('../db');

const MIN_CUSTOMERS = 3;
const SUPPLIER_WEIGHT = 3;
const OWN_WEIGHT = 1;
// Ein Material gehört zum typischen Profil, wenn es in mindestens der Hälfte
// der (gewichteten) Artikel vorkommt - ein Einzelfall mit Zusatz-Beipack-
// zettel soll nicht in jeden Vorschlag rutschen.
const MIN_MATERIAL_SHARE = 0.5;

function weightedMedian(entries) {
  const sorted = entries.filter(e => Number.isFinite(e.value) && e.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  if (total === 0) return null;
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= total / 2) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// rows: [{ customer_id, product_type, materials_json, length_cm, width_cm,
// height_cm, packaging_data_source, dangerous_goods }] - bereits nach
// Qualität gefiltert.
function buildProfiles(rows) {
  const byType = {};
  rows.forEach(r => (byType[r.product_type] || (byType[r.product_type] = [])).push(r));

  const profiles = {};
  for (const [type, typeRows] of Object.entries(byType)) {
    const rowsPerCustomer = {};
    typeRows.forEach(r => { rowsPerCustomer[r.customer_id] = (rowsPerCustomer[r.customer_id] || 0) + 1; });
    const customers = Object.keys(rowsPerCustomer).length;
    if (customers < MIN_CUSTOMERS) continue;

    const samples = [];
    typeRows.forEach(r => {
      let materials;
      try { materials = JSON.parse(r.materials_json); } catch (e) { return; }
      if (!Array.isArray(materials) || materials.length === 0) return;
      const quality = r.packaging_data_source === 'supplier' ? SUPPLIER_WEIGHT : OWN_WEIGHT;
      samples.push({ row: r, materials, weight: quality / rowsPerCustomer[r.customer_id] });
    });
    const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight === 0) continue;

    // Gewicht je Material: Teile desselben Materials innerhalb eines
    // Artikels werden addiert (Flasche + Deckel aus Kunststoff = ein Wert).
    const perMaterial = {};
    samples.forEach(s => {
      const sums = {};
      const subtypes = {};
      s.materials.forEach(m => {
        const grams = Number(m && m.weight_grams);
        if (!m || !m.material || !Number.isFinite(grams) || grams <= 0) return;
        sums[m.material] = (sums[m.material] || 0) + grams;
        if (m.material_subtype && m.material_subtype !== 'unbekannt') {
          subtypes[m.material] = subtypes[m.material] || m.material_subtype;
        }
      });
      for (const [material, grams] of Object.entries(sums)) {
        const bucket = perMaterial[material] || (perMaterial[material] = { entries: [], subtypeWeights: {} });
        bucket.entries.push({ value: grams, weight: s.weight });
        if (subtypes[material]) {
          bucket.subtypeWeights[subtypes[material]] = (bucket.subtypeWeights[subtypes[material]] || 0) + s.weight;
        }
      }
    });

    const materials = Object.entries(perMaterial)
      .map(([material, bucket]) => {
        const share = bucket.entries.reduce((sum, e) => sum + e.weight, 0) / totalWeight;
        const subtype = Object.entries(bucket.subtypeWeights).sort((a, b) => b[1] - a[1])[0];
        return {
          material,
          material_subtype: subtype ? subtype[0] : null,
          weight_grams: Math.round(weightedMedian(bucket.entries)),
          share: Math.round(share * 100) / 100
        };
      })
      .filter(m => m.share >= MIN_MATERIAL_SHARE && m.weight_grams > 0)
      .sort((a, b) => b.weight_grams - a.weight_grams);

    // Maße nur, wenn genug Kunden welche angegeben haben (gleiche
    // Mindestzahl wie für die Produktart selbst).
    const withDims = samples.filter(s => [s.row.length_cm, s.row.width_cm, s.row.height_cm].every(v => Number(v) > 0));
    const dimCustomers = new Set(withDims.map(s => s.row.customer_id)).size;
    let dimensions = null;
    if (dimCustomers >= MIN_CUSTOMERS) {
      // Maße pro Artikel absteigend sortiert, damit "4 x 4 x 15" und
      // "15 x 4 x 4" als dasselbe Produkt zählen.
      const sortedDims = withDims.map(s => ({
        dims: [s.row.length_cm, s.row.width_cm, s.row.height_cm].map(Number).sort((a, b) => b - a),
        weight: s.weight
      }));
      dimensions = {
        l: round1(weightedMedian(sortedDims.map(d => ({ value: d.dims[0], weight: d.weight })))),
        w: round1(weightedMedian(sortedDims.map(d => ({ value: d.dims[1], weight: d.weight })))),
        h: round1(weightedMedian(sortedDims.map(d => ({ value: d.dims[2], weight: d.weight }))))
      };
    }

    // Gefahrgut: typisch, wenn mindestens die Hälfte (gewichtet) der Artikel
    // dieser Produktart so markiert ist - z.B. "Haarspray ist meist eine
    // Spraydose".
    const dgWeights = {};
    samples.forEach(s => { if (s.row.dangerous_goods) dgWeights[s.row.dangerous_goods] = (dgWeights[s.row.dangerous_goods] || 0) + s.weight; });
    const topDg = Object.entries(dgWeights).sort((a, b) => b[1] - a[1])[0];
    const dangerousGoods = topDg && topDg[1] / totalWeight >= MIN_MATERIAL_SHARE ? topDg[0] : null;

    profiles[type] = {
      customers,
      samples: samples.length,
      supplier_samples: samples.filter(s => s.row.packaging_data_source === 'supplier').length,
      materials,
      dimensions_cm: dimensions,
      dangerous_goods: dangerousGoods
    };
  }
  return profiles;
}

function computeKnowledgeBase() {
  const rows = db.prepare(`
    SELECT customer_id, product_type, materials_json, length_cm, width_cm, height_cm, packaging_data_source, dangerous_goods
    FROM product_packaging
    WHERE product_type IS NOT NULL
      AND linked_to_sku_id IS NULL
      AND confidence_note IS NULL
      AND (packaging_data_source IS NULL OR packaging_data_source = 'supplier')
  `).all();
  return buildProfiles(rows);
}

module.exports = { computeKnowledgeBase, buildProfiles, MIN_CUSTOMERS };
