// test/cluster-import.test.js
//
// Deckt die reinen, parametrisierten Funktionen aus lib/cluster-import.js
// mit Fixture-Daten ab - ohne KI-Aufruf oder Datenbank (siehe Code-Review
// 10/2026: diese Funktionen waren trotz einfacher Testbarkeit ungetestet).
// Lauf: node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCategory,
  sizeBucketFromName,
  buildClusterKey,
  buildClusters
} = require('../lib/cluster-import');

test('normalizeCategory: kollabiert dieselben Tags in anderer Reihenfolge auf denselben Key', () => {
  assert.equal(normalizeCategory('A,B,C'), normalizeCategory('C,A,B'));
  assert.equal(normalizeCategory('A, B ,C'), 'A|B|C');
});

test('normalizeCategory: leerer/fehlender Wert ergibt leeren String', () => {
  assert.equal(normalizeCategory(''), '');
  assert.equal(normalizeCategory(null), '');
  assert.equal(normalizeCategory(undefined), '');
});

test('sizeBucketFromName: erkennt ml/g/l/kg und ordnet den richtigen Bucket zu', () => {
  assert.equal(sizeBucketFromName('Essie Nagellack 13.5ml'), 'xs(<=50)');
  assert.equal(sizeBucketFromName('Schwarzkopf Haarfarbe 60ml'), 's(50-150)');
  assert.equal(sizeBucketFromName('Shampoo 250ml'), 'm(150-500)');
  assert.equal(sizeBucketFromName('Conditioner 750ml'), 'l(500-1000)');
  assert.equal(sizeBucketFromName('Entwickler 1000ml'), 'l(500-1000)');
  assert.equal(sizeBucketFromName('Entwickler 1500ml'), 'xl(1000-3000)');
  assert.equal(sizeBucketFromName('Fass 5kg'), 'xxl(>3000)');
  assert.equal(sizeBucketFromName('Nachfüllpack 1 Liter'), 'l(500-1000)');
});

test('sizeBucketFromName: ohne erkennbare Größenangabe -> "unknown"', () => {
  assert.equal(sizeBucketFromName('Reuzel Haarwachs'), 'unknown');
  assert.equal(sizeBucketFromName(''), 'unknown');
  assert.equal(sizeBucketFromName(null), 'unknown');
});

test('buildClusterKey: Marke/Kategorie werden kleingeschrieben, Bucket bleibt wie übergeben', () => {
  assert.equal(
    buildClusterKey('CND', 'Βερνίκια Νυχιών', 'xs(<=50)'),
    'cnd::βερνίκια νυχιών::xs(<=50)'
  );
});

test('buildClusters: gruppiert nach Marke+Kategorie+Größenbucket, unabhängig von Tag-Reihenfolge', () => {
  const rows = [
    { sku: '1', name: 'CND Nagellack 15ml', brand: 'CND', category: 'Βερνίκια Νυχιών,Νύχια' },
    { sku: '2', name: 'CND Nagellack 15ml Rot', brand: 'CND', category: 'Νύχια,Βερνίκια Νυχιών' },
    { sku: '3', name: 'CND Nagellack 60ml', brand: 'CND', category: 'Βερνίκια Νυχιών,Νύχια' },
    { sku: '4', name: 'Essie Nagellack 13.5ml', brand: 'Essie', category: 'Βερνίκια Νυχιών,Νύχια' }
  ];
  const clusters = buildClusters(rows);

  // Die ersten beiden Zeilen sind trotz unterschiedlicher Tag-Reihenfolge
  // derselbe Cluster (gleiche Marke, gleiche Kategorie-Tags, gleicher
  // Größenbucket).
  const cndSmall = clusters.find(c => c.brand === 'CND' && c.sizeBucket === 'xs(<=50)');
  assert.ok(cndSmall);
  assert.equal(cndSmall.members.length, 2);

  // Die 60ml-Variante ist ein ANDERER Cluster (anderer Größenbucket).
  const cndMedium = clusters.find(c => c.brand === 'CND' && c.sizeBucket === 's(50-150)');
  assert.ok(cndMedium);
  assert.equal(cndMedium.members.length, 1);

  // Andere Marke ist immer ein eigener Cluster.
  const essie = clusters.find(c => c.brand === 'Essie');
  assert.ok(essie);
  assert.equal(essie.members.length, 1);

  assert.equal(clusters.length, 3);
});

test('buildClusters: fehlende EAN/SKU führen nicht zum Absturz, Reihenfolge der Mitglieder bleibt erhalten', () => {
  const rows = [
    { name: 'Produkt A', brand: 'X', category: 'Y' },
    { name: 'Produkt B', brand: 'X', category: 'Y' }
  ];
  const clusters = buildClusters(rows);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.map(m => m.name), ['Produkt A', 'Produkt B']);
  assert.equal(clusters[0].members[0].sku, null);
  assert.equal(clusters[0].members[0].ean, null);
});
