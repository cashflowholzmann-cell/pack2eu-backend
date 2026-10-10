const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')), 'test.db');
const { buildProfiles, MIN_CUSTOMERS } = require('../lib/knowledge-base');

const row = (customer_id, materials, extra = {}) => ({
  customer_id, product_type: 'hairspray', materials_json: JSON.stringify(materials),
  length_cm: null, width_cm: null, height_cm: null, packaging_data_source: null, ...extra
});

test('Produktart erscheint erst ab MIN_CUSTOMERS Kunden', () => {
  const rows = [row(1, [{ material: 'metall', weight_grams: 30 }]), row(2, [{ material: 'metall', weight_grams: 32 }])];
  assert.strictEqual(MIN_CUSTOMERS, 3);
  assert.deepStrictEqual(buildProfiles(rows), {});
});

test('Median je Material, Teile desselben Materials addiert, seltene Materialien weggelassen', () => {
  const rows = [
    row(1, [{ material: 'metall', material_subtype: 'aluminium', weight_grams: 30 }, { material: 'kunststoff', weight_grams: 4 }, { material: 'kunststoff', weight_grams: 2 }]),
    row(2, [{ material: 'metall', material_subtype: 'aluminium', weight_grams: 34 }, { material: 'kunststoff', weight_grams: 5 }]),
    row(3, [{ material: 'metall', weight_grams: 31 }, { material: 'papier', weight_grams: 3 }])
  ];
  const p = buildProfiles(rows).hairspray;
  assert.strictEqual(p.customers, 3);
  const metall = p.materials.find(m => m.material === 'metall');
  assert.strictEqual(metall.weight_grams, 31);
  assert.strictEqual(metall.material_subtype, 'aluminium');
  assert.strictEqual(p.materials.find(m => m.material === 'kunststoff').weight_grams, 5);
  assert.ok(!p.materials.some(m => m.material === 'papier'), 'Papier nur bei 1 von 3 Kunden');
});

test('Großkunde zählt nicht mehrfach, Lieferanten-Angaben wiegen mehr', () => {
  const many = Array.from({ length: 20 }, () => row(1, [{ material: 'glas', weight_grams: 500 }]));
  const rows = [...many,
    row(2, [{ material: 'glas', weight_grams: 100 }], { packaging_data_source: 'supplier' }),
    row(3, [{ material: 'glas', weight_grams: 110 }])];
  const p = buildProfiles(rows).hairspray;
  assert.strictEqual(p.materials[0].weight_grams, 100);
  assert.strictEqual(p.supplier_samples, 1);
});

test('Maße unabhängig von der Ausrichtung, nur ab 3 Kunden mit Maßen', () => {
  const m = [{ material: 'metall', weight_grams: 30 }];
  const rows = [
    row(1, m, { length_cm: 4, width_cm: 4, height_cm: 15 }),
    row(2, m, { length_cm: 15, width_cm: 4, height_cm: 4 }),
    row(3, m, { length_cm: 4.5, width_cm: 16, height_cm: 4.5 })
  ];
  assert.deepStrictEqual(buildProfiles(rows).hairspray.dimensions_cm, { l: 15, w: 4, h: 4 });
  rows[2] = row(3, m);
  assert.strictEqual(buildProfiles(rows).hairspray.dimensions_cm, null);
});
