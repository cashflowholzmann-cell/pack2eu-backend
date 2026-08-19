const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pack2eu.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  try {
    // 1. Schema ausführen
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    console.log('✅ Schema ausgeführt');

    // 2. Provider-Spalten nachträglich hinzufügen
    try {
      db.exec(`ALTER TABLE activations ADD COLUMN provider_id TEXT`);
      db.exec(`ALTER TABLE activations ADD COLUMN provider_epr_number TEXT`);
      db.exec(`ALTER TABLE activations ADD COLUMN provider_status TEXT DEFAULT 'pending'`);
      db.exec(`ALTER TABLE activations ADD COLUMN provider_data TEXT`);
      console.log('✅ Provider-Spalten zu activations hinzugefügt');
    } catch (err) {
      console.log('ℹ️ Provider-Spalten existieren bereits');
    }

    try {
      db.exec(`ALTER TABLE product_packaging ADD COLUMN provider_codes_json TEXT`);
      console.log('✅ provider_codes_json zu product_packaging hinzugefügt');
    } catch (err) {
      console.log('ℹ️ provider_codes_json existiert bereits');
    }

    // ⭐⭐⭐ NEU: Länder immer einfügen (nicht nur beim ersten Start)
    // Zuerst prüfen, ob Länder vorhanden sind
    const count = db.prepare('SELECT COUNT(*) AS n FROM countries').get().n;
    console.log(`ℹ️ ${count} Länder in der Datenbank gefunden`);

    // Länder einfügen (auch wenn schon vorhanden – mit INSERT OR IGNORE)
    const insert = db.prepare(`
      INSERT OR IGNORE INTO countries (code, name, register_body, labeling_reqs)
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

    // Länder einfügen
    const insertMany = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    insertMany(seed);
    console.log('✅ Länder wurden in die Datenbank eingefügt (oder existieren bereits)');

    console.log('✅ Datenbank-Initialisierung abgeschlossen');
  } catch (err) {
    console.error('❌ Fehler bei der Datenbank-Initialisierung:', err.message);
    throw err;
  }
}

// ⭐ Export
module.exports = db;
module.exports.init = init;
