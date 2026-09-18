// lib/sku-anomalies.js
//
// Erkennt Materialgewichte in Produkten (product_packaging), die stark
// vom Üblichen abweichen - typischerweise ein Tippfehler (z. B. "100"
// statt "10" Gramm) oder ein Versuch, Öko-Gebühren durch zu niedrig
// angegebene Mengen zu drücken. Entstand aus einem Gespräch mit einem
// Bevollmächtigten, der genau solche Ausreißer von Hand suchen musste.
//
// Zwei Baseline-Quellen, in dieser Reihenfolge:
// 1. Gepoolter Median über ALLE Kunden hinweg, gruppiert nach (Icon,
//    Material) - das Icon dient dabei als grobe, bereits vorhandene
//    Produktart-Angabe. Wird erst ab MIN_SAMPLE_SIZE Vergleichswerten
//    genutzt und wird mit wachsender echter Nutzung von selbst
//    aussagekräftiger.
// 2. Fällt die echte Datenlage (noch) zu dünn aus: PRESET_BASELINES -
//    dieselben recherchierten Branchendurchschnitte, die dashboard.html
//    schon als Startwerte im Produkt-Konfigurator anbietet
//    (PRODUCT_PRESETS dort), hier auf (Icon, Material) -> Median-Gramm
//    reduziert. So funktioniert die Erkennung von Tag 1 an, statt erst,
//    sobald genug eigene Kunden-Daten vorliegen.
//
// PRESET_BASELINES muss von Hand synchron gehalten werden, falls sich
// PRODUCT_PRESETS in dashboard.html ändert (kein automatischer Import,
// da Frontend/Backend getrennte Auslieferung sind).
const { db } = require('../db');

const MIN_SAMPLE_SIZE = 5;

// Weniger als 1/3 oder mehr als das 3-fache der Baseline gilt als
// auffällig - großzügig genug, um normale Schwankungen zwischen
// Produkten nicht ständig fälschlich zu markieren.
const DEVIATION_FACTOR = 3;

const PRESET_BASELINES = {"🧥":{"kunststoff":30},"👕":{"kunststoff":20},"👖":{"kunststoff":35},"🧦":{"kunststoff":10},"👟":{"karton":350},"👗":{"karton":70,"kunststoff":15},"🩳":{"kunststoff":18},"🎽":{"kunststoff":15},"🧣":{"kunststoff":10},"🩱":{"kunststoff":12},"🧼":{"papier":40},"🧴":{"karton":50,"kunststoff":20},"🌿":{"glas":120,"metall":10},"🌸":{"glas":80,"karton":90},"💄":{"kunststoff":12,"karton":20},"💅":{"kunststoff":15,"karton":15},"☕":{"karton":220,"kunststoff":25,"papier":20},"🕯️":{"karton":150},"🖼️":{"karton":90},"🏺":{"karton":250,"papier":30},"🛋️":{"kunststoff":25,"karton":60},"🪑":{"karton":800,"holz":200},"🧶":{"kunststoff":20,"karton":50},"📱":{"karton":80,"kunststoff":15},"🎧":{"karton":150,"kunststoff":20},"🔌":{"karton":40,"kunststoff":10},"⌚":{"karton":95,"kunststoff":15},"🔋":{"karton":90,"kunststoff":15},"🧸":{"karton":120,"kunststoff":17.5},"👶":{"kunststoff":30,"karton":100},"🍼":{"kunststoff":20,"karton":60},"🧱":{"karton":300,"kunststoff":20},"🐻":{"kunststoff":15,"karton":40},"🧘":{"kunststoff":30,"karton":40},"🥤":{"kunststoff":25},"⛺":{"karton":400,"kunststoff":30},"🏋️":{"karton":60,"kunststoff":10},"🚲":{"karton":120,"kunststoff":20},"🥾":{"karton":400},"🍯":{"glas":400,"kunststoff":20},"🍓":{"glas":250,"metall":15},"🍫":{"papier":30,"kunststoff":15},"🍷":{"glas":500,"karton":120},"🧂":{"glas":100,"metall":10},"🍵":{"karton":60,"papier":10},"📚":{"karton":200},"✏️":{"papier":25},"📓":{"papier":15,"karton":30},"🖊️":{"karton":15,"kunststoff":5},"🗓️":{"karton":250},"💌":{"papier":15},"💍":{"karton":45,"kunststoff":10},"👜":{"karton":180,"kunststoff":20},"🕶️":{"karton":60,"kunststoff":20},"👛":{"karton":50,"kunststoff":10},"🎀":{"kunststoff":8,"karton":15},"🦴":{"kunststoff":15,"papier":10},"🐕":{"kunststoff":15,"karton":30},"🦮":{"karton":40,"kunststoff":10},"🐈":{"kunststoff":20,"karton":50},"🛏️":{"karton":300,"kunststoff":30}};

function computeMaterialBaselines() {
  const rows = db.prepare(`
    SELECT icon, materials_json FROM product_packaging WHERE icon IS NOT NULL AND icon != ''
  `).all();

  const buckets = {};
  rows.forEach(row => {
    let materials;
    try { materials = JSON.parse(row.materials_json); } catch (e) { return; }
    if (!Array.isArray(materials)) return;
    materials.forEach(m => {
      const weight = Number(m && m.weight_grams);
      if (!m || !m.material || !Number.isFinite(weight) || weight <= 0) return;
      const key = row.icon + '|' + m.material;
      (buckets[key] || (buckets[key] = [])).push(weight);
    });
  });

  const baselines = {};
  for (const [key, weights] of Object.entries(buckets)) {
    if (weights.length < MIN_SAMPLE_SIZE) continue;
    const sorted = [...weights].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    baselines[key] = { median, sampleSize: weights.length, source: 'pooled' };
  }

  // Presets nur als Lücken-Füller, wo die echte Datenlage (noch) zu
  // dünn ist - echte, gepoolte Kundendaten haben immer Vorrang.
  for (const [icon, materials] of Object.entries(PRESET_BASELINES)) {
    for (const [material, weight] of Object.entries(materials)) {
      const key = icon + '|' + material;
      if (!baselines[key]) {
        baselines[key] = { median: weight, sampleSize: null, source: 'preset' };
      }
    }
  }

  return baselines;
}

// Prüft die Materialzeilen EINES Produkts gegen die Baselines.
function flagAnomalies(sku, baselines) {
  if (!sku.icon) return [];
  let materials;
  try { materials = JSON.parse(sku.materials_json); } catch (e) { return []; }
  if (!Array.isArray(materials)) return [];

  const flagged = [];
  materials.forEach((m, materialIndex) => {
    const weight = Number(m && m.weight_grams);
    if (!m || !m.material || !Number.isFinite(weight) || weight <= 0) return;
    const baseline = baselines[sku.icon + '|' + m.material];
    if (!baseline) return;
    const ratio = weight / baseline.median;
    if (ratio >= DEVIATION_FACTOR || ratio <= 1 / DEVIATION_FACTOR) {
      flagged.push({
        materialIndex,
        material: m.material,
        weight_grams: weight,
        baselineMedian: Math.round(baseline.median * 100) / 100,
        sampleSize: baseline.sampleSize,
        source: baseline.source,
        direction: ratio >= DEVIATION_FACTOR ? 'high' : 'low'
      });
    }
  });
  return flagged;
}

// Baselines + Flags für eine Liste von SKUs in einem Rutsch - vermeidet,
// die (kundenübergreifende) Baseline-Abfrage pro SKU zu wiederholen.
function findAnomalousSkus(skus) {
  const baselines = computeMaterialBaselines();
  return skus
    .map(sku => ({
      sku_id: sku.id,
      sku_name: sku.sku_name,
      icon: sku.icon,
      anomalies: flagAnomalies(sku, baselines)
    }))
    .filter(r => r.anomalies.length > 0);
}

module.exports = { computeMaterialBaselines, flagAnomalies, findAnomalousSkus, MIN_SAMPLE_SIZE, DEVIATION_FACTOR };
