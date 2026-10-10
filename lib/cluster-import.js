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
//
// Die oberste Stufe war früher nach oben offen (">500") - an den echten
// Bella-Rosa-Daten zeigte sich, dass darunter sowohl 600ml-Flaschen als
// auch echte Profi-Großgebinde (z.B. "Shampoo 5000ml", "Conditioner
// 10000ml") landeten und dieselbe Schätzung bekommen hätten. Der
// FlaschenKÖRPER wiegt bei so einem Größenunterschied spürbar mehr (nicht
// proportional zum Volumen, aber auch nicht vernachlässigbar) - nur
// Deckel/Verschluss bleiben über Größen hinweg ungefähr gleich
// (Baukastenprinzip nach Gewinde-Norm, nicht nach Flaschenvolumen).
// Deshalb hier zusätzliche Stufen oberhalb von 500ml statt eines
// einzigen offenen Catch-All.
const SIZE_BUCKETS = [
  { max: 50, label: 'xs(<=50)' },
  { max: 150, label: 's(50-150)' },
  { max: 500, label: 'm(150-500)' },
  { max: 1000, label: 'l(500-1000)' },
  { max: 3000, label: 'xl(1000-3000)' },
  { max: Infinity, label: 'xxl(>3000)' }
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
    clusters.get(key).members.push({ sku: row.sku || null, name: row.name, ean: row.ean || null });
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
async function runClusterImport({ customerId, rows, estimateFn, createSkuRowFn, linkSkuRowFn, concurrency = 5, onClusterDone, lookupSharedClusterFn, findExistingByEanFn, withTransactionFn = (fn) => fn() }) {
  const clusters = buildClusters(rows);
  const errors = [];
  let clustersProcessed = 0;
  let productsCreated = 0;
  let reusedFromSharedData = 0;
  let skippedAsDuplicate = 0;

  await mapWithConcurrency(clusters, concurrency, async (cluster) => {
    try {
      // EAN ist der stärkste verfügbare Dublettenschutz (global eindeutig,
      // dieselbe Eskalationslogik wie beim EAN-Shop-Produkt-Abgleich im
      // Dashboard) - bevor ein Mitglied neu angelegt wird, prüfen ob für
      // DIESEN Kunden schon ein Artikel mit exakt dieser EAN existiert
      // (z.B. aus Shop-Sync, manuellem Anlegen oder einem früheren/
      // überlappenden Cluster-Import). Ohne diese Prüfung würde ein
      // erneuter oder teilweise überlappender Katalog-Import Dubletten/
      // Tripletten anlegen statt den bestehenden Artikel unangetastet zu
      // lassen (Kundenwunsch: "das keine Dopplungen Dreifachungen
      // vorkommen").
      const memberChecks = cluster.members.map(member => ({
        member,
        existing: member.ean && findExistingByEanFn ? findExistingByEanFn(customerId, member.ean) : null
      }));
      const newMembers = memberChecks.filter(m => !m.existing).map(m => m.member);
      const duplicateCount = memberChecks.length - newMembers.length;
      skippedAsDuplicate += duplicateCount;

      if (newMembers.length === 0) {
        // Jedes Mitglied existiert schon (EAN-Treffer) - nichts anzulegen,
        // kein KI-Aufruf/keine Sammeldatenbank-Abfrage nötig.
        clustersProcessed++;
        if (onClusterDone) {
          onClusterDone({ cluster, confidenceNote: null, masterId: null, memberCount: cluster.members.length, createdCount: 0, wasReused: false, duplicateCount });
        }
        return;
      }

      const representative = newMembers[0];
      // "Sammeldatenbank"-Wiederverwendung (Kundenwunsch, Brainstorming
      // nach Bella Rosa): derselbe Cluster-Key (Marke+Kategorie+Größe,
      // siehe buildClusterKey()) kann bei JEDEM Kosmetik-/Beauty-Kunden
      // wieder auftauchen, nicht nur bei dem, der ihn zuerst anlegt -
      // bevor ein neuer, echter KI-Aufruf bezahlt wird, erst prüfen, ob
      // IRGENDEIN Kunde diesen Cluster schon recherchiert hat
      // (lookupSharedClusterFn ist absichtlich kundenübergreifend, siehe
      // Implementierung in routes/skus.js/routes/admin.js - KEIN Scoping
      // auf customerId hier). Spart echtes Geld und wird mit jedem
      // erfolgreichen Lauf wertvoller.
      let materials = lookupSharedClusterFn ? lookupSharedClusterFn(cluster.key) : null;
      let confidenceNote = null;
      let wasReused = false;
      if (materials) {
        wasReused = true;
        reusedFromSharedData++;
      } else {
        const estimate = await estimateFn(representative.name);
        confidenceNote = estimate.confidenceNote;
        materials = estimate.components.map(c => ({
          material: c.material,
          material_subtype: c.material_subtype,
          weight_grams: c.weight_grams
        }));
      }

      const masterRow = createSkuRowFn(customerId, {
        sku_name: representative.name,
        baselinker_sku: representative.sku || null,
        materials,
        cluster_key: cluster.key,
        ean: representative.ean || null,
        confidence_note: confidenceNote
      });
      productsCreated++;

      for (const member of newMembers.slice(1)) {
        // withTransactionFn (echter DB-Lauf: db.transaction()) stellt
        // sicher, dass die Platzhalterzeile (material_subtype: null, 1g
        // Dummy-Gewicht) niemals isoliert liegen bleibt, falls linkSkuRowFn
        // aus irgendeinem Grund wirft - sonst bliebe ein unvollständiges
        // Produkt ohne jede Markierung in der DB stehen (Code-Review 10/2026,
        // aktuell im Normalfall nicht auslösbar, aber strukturell ungeschützt
        // ohne diesen Wrap).
        withTransactionFn(() => {
          const placeholderRow = createSkuRowFn(customerId, {
            sku_name: member.name,
            baselinker_sku: member.sku || null,
            // Platzhalter - wird sofort darunter durch linkSkuRowFn mit den
            // echten Master-Werten überschrieben (gleiches Muster wie
            // createProductPickerVariantSku() im Frontend). ean bleibt
            // ARTIKEL-EIGEN (jede Variante hat ihre eigene EAN) - wird NICHT
            // vom Master überschrieben, anders als die Verpackungsdaten.
            materials: [{ material: 'karton', material_subtype: null, weight_grams: 1, is_recyclable: 1 }],
            cluster_key: cluster.key,
            ean: member.ean || null
          });
          linkSkuRowFn(customerId, placeholderRow.id, masterRow.id);
        });
        productsCreated++;
      }

      clustersProcessed++;
      if (onClusterDone) {
        onClusterDone({ cluster, confidenceNote, masterId: masterRow.id, memberCount: cluster.members.length, createdCount: newMembers.length, wasReused, duplicateCount });
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
    skippedAsDuplicate,
    reusedFromSharedData,
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
