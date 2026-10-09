// lib/cluster-import.js
//
// Cluster-Batch-Import für Kunden mit sehr großen Produktkatalogen ohne
// eigene Verpackungsdaten (Auslöser: Bella Rosa, ~10.300 Artikel aus einem
// ERP-Export mit nur SKU/Name/Marke/Kategorie - ohne Gewicht, Material
// oder Maße). Einzeln anlegen+recherchieren wäre 10.300 KI-Aufrufe und
// 10.300 Zeilen Handarbeit; stattdessen werden Artikel mit vermutlich
// identischer Verpackung (gleiche Marke + Kategorie + Größenklasse) zu
// EINEM Cluster zusammengefasst, pro Cluster EINMAL per KI geschätzt
// (siehe lib/packaging-estimate.js - bewusst dieselbe, bereits
// produktiv genutzte Schätzlogik, kein Zweit-Prompt) und dann über die
// bestehende "Varianten verknüpfen"-Architektur (linked_to_sku_id, siehe
// routes/skus.js) verdrahtet: ein Mitglied pro Cluster wird zum
// Master-Artikel (bekommt die geschätzten Materialien), alle anderen
// werden als Varianten daran verknüpft - exakt dieselbe Logik wie beim
// manuellen "Nagellack in 20 Farben"-Fall, nur automatisiert.
//
// WICHTIG: Das ist eine Schätzung, keine recherchierten Fakten (siehe
// Begründung in lib/packaging-estimate.js) - Zweck ist, den Kunden
// schnell von "gar keine Daten" auf "plausible Richtwerte zum
// Nachjustieren" zu bringen, nicht auf "fertig und exakt". Jeder Cluster
// bleibt über die normale "Varianten verknüpfen"-UI im Dashboard
// nachträglich korrigierbar.

// ============================================================
// NORMALISIERUNG / CLUSTER-KEY
// ============================================================

function normalizeBrand(raw) {
  return raw ? String(raw).trim() : '';
}

// Das Kategoriefeld in ERP-Exports wie dem von Bella Rosa ist keine
// Hierarchie, sondern eine kommagetrennte Liste von Tags IN WECHSELNDER
// REIHENFOLGE (beobachtet: "A,B,C" und "C,A,B" für exakt dieselbe
// Kategorie, teils mit zusätzlichen Leerzeichen-Varianten). Rohes
// String-Matching würde identische Kategorien künstlich in mehrere
// Cluster aufspalten - deshalb: Tags einzeln trimmen, sortieren, wieder
// zusammenfügen. Kollabiert "A,B,C" und "C,A,B,  " auf denselben Key.
function normalizeCategory(raw) {
  if (!raw) return '';
  const tags = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .sort();
  return tags.join('|');
}

// Größe/Volumen ist der stärkste verbleibende Verpackungs-Treiber
// innerhalb einer (Marke, Kategorie) - eine 15ml-Reise-Flasche und eine
// 1L-Nachfüllflasche derselben Marke/Kategorie haben spürbar andere
// Verpackungsgewichte. Grobe Buckets statt exakter Werte, weil der
// Produktname selten mehr als eine Ballpark-Zahl hergibt.
const SIZE_BUCKETS = [
  { max: 50, label: 'xs(<=50)' },
  { max: 150, label: 's(50-150)' },
  { max: 500, label: 'm(150-500)' },
  { max: Infinity, label: 'l(>500)' }
];

const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(ml|milliliter|milliliters|g|gr|gramm|kg|kilogramm|l|liter|liters)\b/i;

function sizeBucketFromName(name) {
  if (!name) return 'unknown';
  const match = SIZE_PATTERN.exec(String(name));
  if (!match) return 'unknown';

  const value = parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return 'unknown';

  const unit = match[2].toLowerCase();
  // Alles auf eine gemeinsame "ml/g-äquivalent"-Skala normiert (für
  // Flüssigkeiten/Cremes ist Dichte ~1, reicht für eine grobe Bucket-
  // Einteilung völlig aus - keine Behauptung echter Präzision).
  let normalized = value;
  if (unit.startsWith('kg') || unit.startsWith('kilo')) normalized = value * 1000;
  if (unit === 'l' || unit.startsWith('liter')) normalized = value * 1000;

  const bucket = SIZE_BUCKETS.find(b => normalized <= b.max);
  return bucket ? bucket.label : 'unknown';
}

function buildClusterKey(brand, category, sizeBucket) {
  return `${brand.toLowerCase()}::${category.toLowerCase()}::${sizeBucket}`;
}

// ============================================================
// CLUSTERING
//
// rows: [{ sku, name, brand, category }] - normalisierte Eingabe,
// plattformunabhängig (Mapping von konkreten ERP-Spalten auf dieses
// Format passiert im aufrufenden Script, siehe scripts/cluster-import-run.js).
// ============================================================
function buildClusters(rows) {
  const clusters = new Map();

  for (const row of rows) {
    const brand = normalizeBrand(row.brand);
    const category = normalizeCategory(row.category);
    const sizeBucket = sizeBucketFromName(row.name);
    const key = buildClusterKey(brand, category, sizeBucket);

    if (!clusters.has(key)) {
      clusters.set(key, { key, brand, category, sizeBucket, members: [] });
    }
    clusters.get(key).members.push({ sku: row.sku || null, name: row.name });
  }

  return Array.from(clusters.values());
}

function clusterStats(clusters) {
  const totalRows = clusters.reduce((sum, c) => sum + c.members.length, 0);
  const sorted = [...clusters].sort((a, b) => b.members.length - a.members.length);
  const coverage = [10, 25, 50, 100, 200, 500].map(n => {
    const covered = sorted.slice(0, n).reduce((sum, c) => sum + c.members.length, 0);
    return { topN: n, rows: covered, share: totalRows ? covered / totalRows : 0 };
  });

  return {
    totalRows,
    totalClusters: clusters.length,
    averageClusterSize: clusters.length ? totalRows / clusters.length : 0,
    topClusters: sorted.slice(0, 20).map(c => ({
      key: c.key, brand: c.brand, category: c.category, sizeBucket: c.sizeBucket, count: c.members.length
    })),
    coverage
  };
}

// ============================================================
// EINFACHER KONKURRENZ-LIMITER
//
// Kein neues npm-Package (p-limit o.ä.) für ein einmaliges Batch-Script -
// begrenzt, wie viele KI-Aufrufe gleichzeitig in Flight sind, damit
// mehrere tausend Cluster nicht streng sequenziell (zu langsam) aber auch
// nicht alle gleichzeitig (Rate-Limit/Kosten-Spitze) abgearbeitet werden.
// ============================================================
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ============================================================
// IMPORT AUSFÜHREN
//
// estimateFn/createSkuRowFn/linkSkuRowFn als Parameter statt fest
// importiert - macht den Kern testbar (siehe scripts/cluster-import-run.js:
// Dry-Run nutzt gar keine der drei, echter Lauf übergibt die echten
// Implementierungen aus lib/packaging-estimate.js und routes/skus.js).
// ============================================================
async function runClusterImport({ customerId, rows, estimateFn, createSkuRowFn, linkSkuRowFn, concurrency = 5, onClusterDone }) {
  const clusters = buildClusters(rows);
  const errors = [];
  let clustersProcessed = 0;
  let productsCreated = 0;

  await mapWithConcurrency(clusters, concurrency, async (cluster) => {
    try {
      const representative = cluster.members[0];
      const { components, confidenceNote } = await estimateFn(representative.name);
      const materials = components.map(c => ({
        material: c.material,
        material_subtype: c.material_subtype,
        weight_grams: c.weight_grams
      }));

      const masterRow = createSkuRowFn(customerId, {
        sku_name: representative.name,
        baselinker_sku: representative.sku || null,
        materials,
        cluster_key: cluster.key
      });
      productsCreated++;

      for (const member of cluster.members.slice(1)) {
        const placeholderRow = createSkuRowFn(customerId, {
          sku_name: member.name,
          baselinker_sku: member.sku || null,
          // Platzhalter - wird sofort darunter durch linkSkuRowFn mit den
          // echten Master-Werten überschrieben (gleiches Muster wie
          // createProductPickerVariantSku() im Frontend).
          materials: [{ material: 'karton', material_subtype: null, weight_grams: 1, is_recyclable: 1 }],
          cluster_key: cluster.key
        });
        linkSkuRowFn(customerId, placeholderRow.id, masterRow.id);
        productsCreated++;
      }

      clustersProcessed++;
      if (onClusterDone) {
        onClusterDone({ cluster, confidenceNote, masterId: masterRow.id, memberCount: cluster.members.length });
      }
    } catch (error) {
      errors.push({
        clusterKey: cluster.key,
        brand: cluster.brand,
        category: cluster.category,
        sizeBucket: cluster.sizeBucket,
        memberCount: cluster.members.length,
        sampleSku: cluster.members[0]?.sku || null,
        error: error.message
      });
    }
  });

  return {
    totalClusters: clusters.length,
    clustersProcessed,
    productsCreated,
    errors
  };
}

module.exports = {
  normalizeBrand,
  normalizeCategory,
  sizeBucketFromName,
  buildClusterKey,
  buildClusters,
  clusterStats,
  mapWithConcurrency,
  runClusterImport
};
