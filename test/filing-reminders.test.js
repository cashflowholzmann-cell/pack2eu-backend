const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'test.db');
const { db, init } = require('../db');
init();
const { computeNextFilingDate, findDueReminders } = require('../lib/filing-reminders');

const now = new Date(2026, 9, 10, 12); // 10.10.2026

test('Fristregeln: jährlich, feste Termine, Quartal mit Karenztagen', () => {
  assert.deepStrictEqual(computeNextFilingDate({ type: 'annual', month: 10, day: 20 }, now), new Date(2026, 9, 20));
  assert.deepStrictEqual(computeNextFilingDate({ type: 'annual', month: 3, day: 31 }, now), new Date(2027, 2, 31));
  assert.deepStrictEqual(computeNextFilingDate({ type: 'fixed_dates', dates: [{ month: 1, day: 15 }, { month: 10, day: 15 }] }, now), new Date(2026, 9, 15));
  // Q3 endet 30.9. + 25 Tage = 25.10.
  assert.deepStrictEqual(computeNextFilingDate({ type: 'periodic', period: 'quarter', offsetDays: 25 }, now), new Date(2026, 9, 25));
  assert.strictEqual(computeNextFilingDate(null, now), null);
});

test('Erinnerung nur für fällige, nicht erinnerte, nicht gemeldete Länder aktiver Kunden', () => {
  const mk = (n, status, enabled = 1) => db.prepare(`INSERT INTO customers (customer_number, company_name, origin_country, email, password_hash, subscription_status, filing_reminders_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run('FR' + n, 'c', 'DE', 'fr' + n + '@x.de', 'x', status, enabled).lastInsertRowid;
  const activate = (c, code) => db.prepare(`INSERT INTO activations (customer_id, country_code, status) VALUES (?, ?, 'active')`).run(c, code);
  db.prepare(`UPDATE countries SET next_filing_rule_json = ?, reporting_frequency = 'annually' WHERE code = 'SE'`).run(JSON.stringify({ type: 'annual', month: 10, day: 20 }));
  db.prepare(`UPDATE countries SET next_filing_rule_json = ?, reporting_frequency = 'annually' WHERE code = 'FI'`).run(JSON.stringify({ type: 'annual', month: 12, day: 31 }));
  const due = mk(1, 'active'); activate(due, 'SE'); activate(due, 'FI');
  const optedOut = mk(2, 'active', 0); activate(optedOut, 'SE');
  const unpaid = mk(3, 'inactive'); activate(unpaid, 'SE');
  const reported = mk(4, 'active'); activate(reported, 'SE');
  db.prepare(`INSERT INTO submissions (customer_id, destination, length_cm, width_cm, height_cm, materials_json, total_weight_kg, status, created_at) VALUES (?, 'SE', 1, 1, 1, '[]', 1, 'received', datetime('now', '-3 days'))`).run(reported);

  let reminders = findDueReminders(now);
  assert.deepStrictEqual(reminders.map(r => r.customerId), [due]);
  assert.deepStrictEqual(reminders[0].items.map(i => i.countryCode), ['SE'], 'FI erst in über 14 Tagen');

  db.prepare(`INSERT INTO filing_reminders_sent (customer_id, country_code, deadline) VALUES (?, 'SE', '2026-10-20')`).run(due);
  assert.deepStrictEqual(findDueReminders(now), [], 'dieselbe Frist nie doppelt');
});
