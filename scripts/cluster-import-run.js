#!/usr/bin/env node
// scripts/cluster-import-run.js
//
// CLI für den Cluster-Batch-Import (siehe lib/cluster-import.js für die
// Begründung des Ansatzes - Auslöser: Bella Rosa, ~10.300 Artikel ohne
// eigene Verpackungsdaten). Nimmt eine JSON-Datei mit normalisierten
// Zeilen [{sku, name, brand, category}] entgegen (Mapping der konkreten
// ERP-Spalten passiert VOR diesem Script, z.B. per einmaligem
// Python-Export aus dem Originalformat - bewusst nicht Teil dieses
// Scripts, damit es für jeden Kunden mit eigenem ERP-Exportformat
// wiederverwendbar bleibt, ohne Spaltennamen hart zu codieren).
//
// Nutzung:
//   node scripts/cluster-import-run.js --customer-id=<ID> --file=<rows.json> --dry-run
//   node scripts/cluster-import-run.js --customer-id=<ID> --file=<rows.json> --sample=50
//   node scripts/cluster-import-run.js --customer-id=<ID> --file=<rows.json>
//
// --dry-run   : nur Cluster-Statistik, KEINE KI-Aufrufe, KEINE DB-Schreibvorgänge.
// --sample=N  : verarbeitet nur die ersten N Cluster (für einen kleinen
//               echten Testlauf, bevor der volle Katalog durchläuft).
// ohne Flags  : voller echter Lauf gegen ALLE Cluster - kostet pro
//               Cluster einen echten KI-Request (siehe lib/packaging-estimate.js)
//               und schreibt echte SKU-Zeilen für den angegebenen Kunden.
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { dryRun: false, sample: null, customerId: null, file: null, concurrency: 5 };
  for (const raw of argv) {
    if (raw === '--dry-run') { args.dryRun = true; continue; }
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'customer-id') args.customerId = Number(value);
    if (key === 'file') args.file = value;
    if (key === 'sample') args.sample = Number(value);
    if (key === 'concurrency') args.concurrency = Number(value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('❌ --file=<rows.json> ist erforderlich.');
    process.exit(1);
  }
  const absFile = path.resolve(args.file);
  if (!fs.existsSync(absFile)) {
    console.error(`❌ Datei nicht gefunden: ${absFile}`);
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(absFile, 'utf8'))
    .filter(r => r && r.name); // Zeilen ohne Produktname sind nicht clusterbar

  const { buildClusters, clusterStats, runClusterImport } = require('../lib/cluster-import');

  // ========================================================
  // DRY-RUN: nur Statistik, kein KI-Call, kein DB-Zugriff
  // ========================================================
  if (args.dryRun) {
    const clusters = buildClusters(rows);
    const stats = clusterStats(clusters);
    console.log('==============================================');
    console.log('CLUSTER-ANALYSE (Dry-Run, keine Kosten/Schreibvorgänge)');
    console.log('==============================================');
    console.log(`Zeilen gesamt:        ${stats.totalRows}`);
    console.log(`Cluster gesamt:       ${stats.totalClusters}`);
    console.log(`Ø Artikel/Cluster:    ${stats.averageClusterSize.toFixed(2)}`);
    console.log('');
    console.log('Abdeckung nach größten Clustern:');
    stats.coverage.forEach(c => console.log(`  Top ${String(c.topN).padStart(4)} Cluster decken ${c.rows.toString().padStart(6)} Zeilen ab (${(c.share * 100).toFixed(1)}%)`));
    console.log('');
    console.log('Größte 15 Cluster:');
    stats.topClusters.slice(0, 15).forEach(c => {
      console.log(`  ${String(c.count).padStart(4)}  ${c.brand || '(ohne Marke)'} / ${(c.category || '(ohne Kategorie)').slice(0, 50)} / ${c.sizeBucket}`);
    });
    console.log('');
    console.log(`=> Geschätzte Anzahl KI-Aufrufe für vollen Lauf: ${stats.totalClusters}`);
    return;
  }

  // ========================================================
  // ECHTER LAUF: braucht Kunden-ID + DB + Anthropic API Key
  // ========================================================
  if (!args.customerId) {
    console.error('❌ --customer-id=<ID> ist für einen echten Lauf erforderlich (ohne --dry-run).');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY fehlt - für echte KI-Schätzungen erforderlich.');
    process.exit(1);
  }

  const { db } = require('../db');
  const customer = db.prepare('SELECT id, company_name FROM customers WHERE id = ?').get(args.customerId);
  if (!customer) {
    console.error(`❌ Kunde mit ID ${args.customerId} nicht gefunden.`);
    process.exit(1);
  }

  const { estimatePackaging } = require('../lib/packaging-estimate');
  const { createSkuRow, linkSkuRow } = require('../routes/skus');

  let clusters = buildClusters(rows);
  if (args.sample) {
    clusters = clusters.slice(0, args.sample);
    console.log(`⚠️  --sample=${args.sample}: nur die ersten ${clusters.length} Cluster werden verarbeitet.`);
  }

  // runClusterImport erwartet Rows, keine fertigen Cluster - bei --sample
  // bauen wir die Eingabe-Rows aus den (ggf. gekürzten) Clustern zurück,
  // damit dieselbe Funktion für Sample- und Volllauf genutzt wird.
  const effectiveRows = clusters.flatMap(c => c.members.map(m => ({
    sku: m.sku, name: m.name, brand: c.brand, category: c.category
  })));

  console.log('==============================================');
  console.log(`CLUSTER-IMPORT: ${customer.company_name} (Kunde #${customer.id})`);
  console.log(`${clusters.length} Cluster, ${effectiveRows.length} Artikel`);
  console.log('==============================================');

  let done = 0;
  const startedAt = Date.now();

  const result = await runClusterImport({
    customerId: args.customerId,
    rows: effectiveRows,
    estimateFn: estimatePackaging,
    createSkuRowFn: createSkuRow,
    linkSkuRowFn: linkSkuRow,
    concurrency: args.concurrency,
    onClusterDone: ({ cluster, memberCount }) => {
      done++;
      if (done % 10 === 0 || done === clusters.length) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(`  [${done}/${clusters.length}] ... (${elapsedSec}s) zuletzt: ${cluster.brand || '(ohne Marke)'} / ${memberCount} Artikel`);
      }
    }
  });

  console.log('');
  console.log('==============================================');
  console.log('FERTIG');
  console.log('==============================================');
  console.log(`Cluster verarbeitet:  ${result.clustersProcessed}/${result.totalClusters}`);
  console.log(`Artikel angelegt:     ${result.productsCreated}`);
  console.log(`Fehler:               ${result.errors.length}`);
  if (result.errors.length) {
    const errFile = path.join(path.dirname(absFile), `cluster-import-errors-${Date.now()}.json`);
    fs.writeFileSync(errFile, JSON.stringify(result.errors, null, 2));
    console.log(`Fehlerdetails geschrieben nach: ${errFile}`);
  }
}

main().catch(err => {
  console.error('❌ Unerwarteter Fehler:', err);
  process.exit(1);
});
