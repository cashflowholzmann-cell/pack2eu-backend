const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pack2eu.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  // 1. Schema ausführen
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // 2. Lappa-Spalten nachträglich hinzufügen
  try {
    db.exec(`ALTER TABLE activations ADD COLUMN lappa_epr_number TEXT`);
    db.exec(`ALTER TABLE activations ADD COLUMN lappa_status TEXT DEFAULT 'pending'`);
    db.exec(`ALTER TABLE activations ADD COLUMN lappa_data TEXT`);
    console.log('✅ Lappa-Spalten zu activations hinzugefügt');
  } catch (err) {
    console.log('ℹ️ Lappa-Spalten existieren bereits');
  }

  // 3. Länder seeden
  const count = db.prepare('SELECT COUNT(*) AS n FROM countries').get().n;
  if (count === 0) {
    const insert = db.prepare(`
      INSERT INTO countries (code, name, register_body, labeling_reqs)
      VALUES (@code, @name, @register_body, @labeling_reqs)
    `);
    const seed = [
      { code: 'DE', name: 'Deutschland', register_body: 'LUCID / ZSVR', labeling_reqs: '[]' },
      { code: 'FR', name: 'Frankreich', register_body: 'ADEME / CITEO', labeling_reqs: '[]' },
      { code: 'IT', name: 'Italien', register_body: 'CONAI', labeling_reqs: '[]' },
      { code: 'ES', name: 'Spanien', register_body: 'Ecoembes / MITERD', labeling_reqs: '[]' },
      { code: 'AT', name: 'Österreich', register_body: 'EDM-Portal / ARA', labeling_reqs: '[]' },
      { code: 'BE', name: 'Belgien', register_body: 'FPS Health', labeling_reqs: '[]' },
      { code: 'NL', name: 'Niederlande', register_body: 'Eigenes System', labeling_reqs: '[]' },
      { code: 'PL', name: 'Polen', register_body: 'BDO', labeling_reqs: '[]' },
      { code: 'SE', name: 'Schweden', register_body: 'Naturvårdsverket', labeling_reqs: '[]' },
      { code: 'DK', name: 'Dänemark', register_body: 'Dansk Producentansvar', labeling_reqs: '[]' }
    ];
    const insertMany = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    insertMany(seed);
    console.log('✅ Länder wurden in die Datenbank eingefügt');
  }
}

// ⭐⭐⭐ DAS IST DER WICHTIGE TEIL:
// Exportiere die Datenbank-Instanz direkt, nicht als Objekt!
module.exports = db;          // <-- DAS IST DIE ÄNDERUNG!
module.exports.init = init;   // <-- init als separate Funktion
