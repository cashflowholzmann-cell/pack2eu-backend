const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.DB_PATH ||
  path.join(__dirname, 'pack2eu.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');


// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function tableExists(table) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(table);
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;

  return db.prepare(`
    PRAGMA table_info(${table})
  `).all().some(c => c.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table)) return;

  if (!columnExists(table, column)) {
    db.exec(`
      ALTER TABLE ${table}
      ADD COLUMN ${column} ${definition}
    `);

    console.log(`✅ Spalte ${table}.${column} hinzugefügt`);
  }
}


// ============================================================
// INIT
// ============================================================

function init() {
  try {

    // --------------------------------------------------------
    // 1. GRUNDLEGENDE COMPLIANCE-TABELLEN
    // --------------------------------------------------------

    db.exec(`
      CREATE TABLE IF NOT EXISTS country_jurisdictions (
        code TEXT PRIMARY KEY,
        is_eu INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS compliance_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        origin_code TEXT NOT NULL,
        destination_code TEXT NOT NULL,

        registration_required INTEGER NOT NULL DEFAULT 1,
        representative_required INTEGER NOT NULL DEFAULT 0,
        notary_required INTEGER NOT NULL DEFAULT 0,

        status TEXT NOT NULL DEFAULT 'needs_review',

        legal_label TEXT NOT NULL DEFAULT 'Prüfung erforderlich',
        explanation TEXT,
        legal_basis TEXT,

        confidence TEXT NOT NULL DEFAULT 'needs_review',

        policy_version TEXT NOT NULL DEFAULT '2026-08-25',

        source_url TEXT,
        source_type TEXT NOT NULL DEFAULT 'internal',

        provider_available INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT,
        provider_cost_eur REAL,

        effective_from TEXT,

        active INTEGER NOT NULL DEFAULT 1,

        UNIQUE(origin_code, destination_code)
      );
    `);

    console.log('✅ Compliance-Tabellen vorhanden');


    // --------------------------------------------------------
    // 2. EU / NICHT-EU LÄNDER
    // --------------------------------------------------------

    const euCodes = [
      'AT','BE','BG','HR','CY','CZ','DE','DK','EE',
      'ES','FI','FR','GR','HU','IE','IT','LT','LU',
      'LV','MT','NL','PL','PT','RO','SE','SI','SK'
    ];

    const nonEuCodes = [
      'CH','US','CA','CN','TH','GB','JP','AU',
      'IN','NO','IS','LI'
    ];

    const insertJurisdiction = db.prepare(`
      INSERT OR IGNORE INTO country_jurisdictions
      (code, is_eu)
      VALUES (?, ?)
    `);

    const seedJurisdictions = db.transaction(() => {
      for (const code of euCodes) {
        insertJurisdiction.run(code, 1);
      }

      for (const code of nonEuCodes) {
        insertJurisdiction.run(code, 0);
      }
    });

    seedJurisdictions();


    // --------------------------------------------------------
    // 3. NORMALES SCHEMA
    // --------------------------------------------------------

    const schema = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8'
    );

    db.exec(schema);

    console.log('✅ Schema ausgeführt');


    // --------------------------------------------------------
    // 4. WICHTIGE MIGRATIONEN
    // --------------------------------------------------------

    // countries
    addColumnIfMissing(
      'countries',
      'data_status',
      "TEXT NOT NULL DEFAULT 'needs_verification'"
    );

    // activations
    addColumnIfMissing(
      'activations',
      'representative_name',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'representative_company',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'representative_email',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'provider_id',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'provider_epr_number',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'provider_status',
      "TEXT DEFAULT 'pending'"
    );

    addColumnIfMissing(
      'activations',
      'provider_data',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'provider_case_id',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'provider_error',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'lappa_representative_id',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'lappa_status',
      "TEXT DEFAULT 'pending'"
    );

    addColumnIfMissing(
      'activations',
      'lappa_data',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'compliance_status',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'registration_status',
      "TEXT DEFAULT 'not_started'"
    );

    addColumnIfMissing(
      'activations',
      'representative_status',
      "TEXT DEFAULT 'not_required'"
    );

    addColumnIfMissing(
      'activations',
      'compliance_snapshot',
      "TEXT DEFAULT '{}'"
    );

    addColumnIfMissing(
      'activations',
      'local_establishment',
      'INTEGER NOT NULL DEFAULT 0'
    );


    // product packaging
    addColumnIfMissing(
      'product_packaging',
      'provider_codes_json',
      'TEXT'
    );


    // --------------------------------------------------------
    // 5. COMPLIANCE CASES
    // --------------------------------------------------------

    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL
          REFERENCES countries(code),

        compliance_status TEXT NOT NULL,

        registration_status TEXT NOT NULL
          DEFAULT 'not_started',

        representative_status TEXT NOT NULL
          DEFAULT 'not_required',

        provider_id TEXT,
        provider_case_id TEXT,

        external_number TEXT,
        external_status TEXT,

        snapshot_json TEXT NOT NULL
          DEFAULT '{}',

        last_error TEXT,

        submitted_at TEXT,
        completed_at TEXT,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        UNIQUE(customer_id, country_code)
      );

      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_customer
      ON compliance_cases(customer_id);

      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_status
      ON compliance_cases(
        registration_status,
        representative_status
      );
    `);


    // --------------------------------------------------------
    // 6. WEITERE COMPLIANCE-FELDER
    // --------------------------------------------------------

    addColumnIfMissing(
      'compliance_rules',
      'explanation',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_rules',
      'legal_basis',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_rules',
      'confidence',
      "TEXT NOT NULL DEFAULT 'needs_review'"
    );

    addColumnIfMissing(
      'compliance_rules',
      'source_url',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_rules',
      'source_type',
      "TEXT NOT NULL DEFAULT 'internal'"
    );

    addColumnIfMissing(
      'compliance_rules',
      'provider_available',
      'INTEGER NOT NULL DEFAULT 0'
    );

    addColumnIfMissing(
      'compliance_rules',
      'provider_id',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_rules',
      'provider_cost_eur',
      'REAL'
    );

    addColumnIfMissing(
      'compliance_rules',
      'effective_from',
      'TEXT'
    );


    // --------------------------------------------------------
    // 7. LÄNDERDATEN
    // --------------------------------------------------------

    const countryCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM countries
    `).get().n;

    if (countryCount === 0) {

      const insertCountry = db.prepare(`
        INSERT INTO countries (
          code,
          name,
          register_body,
          labeling_reqs,
          requirements_json,
          labeling_json,
          eco_fee,
          steps_json,
          representative_required,
          notary_required,
          notary_cost,
          registration_url,
          flag,
          data_status
        )
        VALUES (
          @code,
          @name,
          @register_body,
          @labeling_reqs,
          @requirements_json,
          @labeling_json,
          @eco_fee,
          @steps_json,
          @representative_required,
          @notary_required,
          @notary_cost,
          @registration_url,
          @flag,
          @data_status
        )
      `);

      const countries = [

        {
          code: 'DE',
          name: 'Deutschland',
          register_body: 'LUCID / ZSVR',
          labeling_reqs: '[]',
          requirements_json: '[]',
          labeling_json: '[]',
          eco_fee: '',
          steps_json: '[]',
          representative_required: 0,
          notary_required: 0,
          notary_cost: '',
          registration_url: 'https://www.verpackungsregister.org/',
          flag: '🇩🇪',
          data_status: 'verified'
        },

        {
          code: 'PL',
          name: 'Polen',
          register_body: 'BDO',
          labeling_reqs: '[]',
          requirements_json: '[]',
          labeling_json: '[]',
          eco_fee: '',
          steps_json: '[]',
          representative_required: 0,
          notary_required: 0,
          notary_cost: '',
          registration_url: 'https://rejestr-bdo.mos.gov.pl/',
          flag: '🇵🇱',
          data_status: 'needs_verification'
        },

        {
          code: 'BE',
          name: 'Belgien',
          register_body: 'FPS Health',
          labeling_reqs: '[]',
          requirements_json: '[]',
          labeling_json: '[]',
          eco_fee: '',
          steps_json: '[]',
          representative_required: 0,
          notary_required: 0,
          notary_cost: '',
          registration_url: '',
          flag: '🇧🇪',
          data_status: 'needs_verification'
        },

        {
          code: 'CH',
          name: 'Schweiz',
          register_body: 'Schweizer Verpackungsrecht',
          labeling_reqs: '[]',
          requirements_json: '[]',
          labeling_json: '[]',
          eco_fee: '',
          steps_json: '[]',
          representative_required: 0,
          notary_required: 0,
          notary_cost: '',
          registration_url: '',
          flag: '🇨🇭',
          data_status: 'needs_verification'
        },

        {
          code: 'DK',
          name: 'Dänemark',
          register_body: 'DPA',
          labeling_reqs: '[]',
          requirements_json: '[]',
          labeling_json: '[]',
          eco_fee: '',
          steps_json: '[]',
          representative_required: 0,
          notary_required: 0,
          notary_cost: '',
          registration_url: 'https://www.dpa-system.dk/',
          flag: '🇩🇰',
          data_status: 'needs_verification'
        }
      ];

      const insertMany = db.transaction(rows => {
        for (const row of rows) {
          insertCountry.run(row);
        }
      });

      insertMany(countries);

      console.log('✅ Grund-Länder angelegt');
    }


    // --------------------------------------------------------
    // 8. SICHERHEITSINDEX
    // --------------------------------------------------------

    db.exec(`
      CREATE INDEX IF NOT EXISTS
      idx_activations_customer
      ON activations(customer_id);

      CREATE INDEX IF NOT EXISTS
      idx_activations_country
      ON activations(country_code);

      CREATE INDEX IF NOT EXISTS
      idx_activations_mode
      ON activations(mode);

      CREATE INDEX IF NOT EXISTS
      idx_product_packaging_customer
      ON product_packaging(customer_id);
    `);


    console.log('✅ Datenbank-Initialisierung abgeschlossen');

  } catch (error) {

    console.error(
      '❌ Fehler bei der Datenbank-Initialisierung:',
      error
    );

    throw error;
  }
}


module.exports = db;
module.exports.init = init;
