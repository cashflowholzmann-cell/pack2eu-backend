const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ============================================================
// PACK2EU – ZENTRALE DATENBANK
// ============================================================

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
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(table);

  return !!row;
}


function columnInfo(table, column) {
  if (!tableExists(table)) {
    return null;
  }

  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all();

  return columns.find(c => c.name === column) || null;
}


function columnExists(table, column) {
  return !!columnInfo(table, column);
}


function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table)) {
    return;
  }

  if (columnExists(table, column)) {
    console.log(
      `ℹ️ Spalte ${table}.${column} existiert bereits`
    );
    return;
  }

  db.exec(`
    ALTER TABLE ${table}
    ADD COLUMN ${column} ${definition}
  `);

  console.log(
    `✅ Spalte ${table}.${column} hinzugefügt`
  );
}


// ============================================================
// LÄNDER
// ============================================================

const COUNTRIES = [

  ['AT', 'Österreich', '🇦🇹'],
  ['BE', 'Belgien', '🇧🇪'],
  ['BG', 'Bulgarien', '🇧🇬'],
  ['HR', 'Kroatien', '🇭🇷'],
  ['CY', 'Zypern', '🇨🇾'],
  ['CZ', 'Tschechien', '🇨🇿'],
  ['DE', 'Deutschland', '🇩🇪'],
  ['DK', 'Dänemark', '🇩🇰'],
  ['EE', 'Estland', '🇪🇪'],
  ['ES', 'Spanien', '🇪🇸'],
  ['FI', 'Finnland', '🇫🇮'],
  ['FR', 'Frankreich', '🇫🇷'],
  ['GR', 'Griechenland', '🇬🇷'],
  ['HU', 'Ungarn', '🇭🇺'],
  ['IE', 'Irland', '🇮🇪'],
  ['IT', 'Italien', '🇮🇹'],
  ['LT', 'Litauen', '🇱🇹'],
  ['LU', 'Luxemburg', '🇱🇺'],
  ['LV', 'Lettland', '🇱🇻'],
  ['MT', 'Malta', '🇲🇹'],
  ['NL', 'Niederlande', '🇳🇱'],
  ['PL', 'Polen', '🇵🇱'],
  ['PT', 'Portugal', '🇵🇹'],
  ['RO', 'Rumänien', '🇷🇴'],
  ['SE', 'Schweden', '🇸🇪'],
  ['SI', 'Slowenien', '🇸🇮'],
  ['SK', 'Slowakei', '🇸🇰'],

  // Schweiz zusätzlich
  ['CH', 'Schweiz', '🇨🇭']

];


// ============================================================
// EU-LÄNDER
// ============================================================

const EU_CODES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK'
]);


// ============================================================
// INIT
// ============================================================

function init() {

  try {

    console.log('');
    console.log('==============================================');
    console.log('🗄️ PACK2EU DATENBANK INITIALISIERUNG');
    console.log('==============================================');


    // ========================================================
    // 1. BASISSCHEMA
    // ========================================================

    const schemaPath =
      path.join(__dirname, 'schema.sql');

    if (!fs.existsSync(schemaPath)) {
      throw new Error(
        'db/schema.sql wurde nicht gefunden.'
      );
    }

    const schema =
      fs.readFileSync(
        schemaPath,
        'utf8'
      );

    db.exec(schema);

    console.log(
      '✅ Schema ausgeführt'
    );


    // ========================================================
    // 2. COMPLIANCE BASIS-TABELLEN
    // ========================================================

    db.exec(`

      CREATE TABLE IF NOT EXISTS country_jurisdictions (

        code TEXT PRIMARY KEY,

        is_eu INTEGER NOT NULL DEFAULT 0

      );


      CREATE TABLE IF NOT EXISTS compliance_rules (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        origin_code TEXT NOT NULL,

        destination_code TEXT NOT NULL,

        registration_required
          INTEGER NOT NULL DEFAULT 1,

        representative_required
          INTEGER NOT NULL DEFAULT 0,

        notary_required
          INTEGER NOT NULL DEFAULT 0,

        status TEXT NOT NULL
          DEFAULT 'needs_review',

        legal_label TEXT NOT NULL
          DEFAULT 'Prüfung erforderlich',

        explanation TEXT,

        legal_basis TEXT,

        confidence TEXT NOT NULL
          DEFAULT 'needs_review',

        policy_version TEXT NOT NULL
          DEFAULT '2026-08-25',

        source_url TEXT,

        source_type TEXT NOT NULL
          DEFAULT 'internal',

        provider_available
          INTEGER NOT NULL DEFAULT 0,

        provider_id TEXT,

        provider_cost_eur REAL,

        effective_from TEXT,

        active INTEGER NOT NULL
          DEFAULT 1,

        UNIQUE(
          origin_code,
          destination_code
        )

      );


      CREATE TABLE IF NOT EXISTS compliance_providers (

        id TEXT PRIMARY KEY,

        name TEXT NOT NULL,

        kind TEXT NOT NULL,

        base_url TEXT,

        active INTEGER NOT NULL DEFAULT 1,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );


      CREATE TABLE IF NOT EXISTS monthly_reports (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL,

        period TEXT NOT NULL,

        totals_json TEXT NOT NULL
          DEFAULT '{}',

        status TEXT NOT NULL
          DEFAULT 'draft',

        created_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        UNIQUE(
          customer_id,
          country_code,
          period
        )

      );


      CREATE TABLE IF NOT EXISTS oauth_states (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        provider TEXT NOT NULL,

        state TEXT UNIQUE NOT NULL,

        shop_domain TEXT,

        expires_at TEXT NOT NULL,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );


      CREATE TABLE IF NOT EXISTS provider_transactions (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL
          REFERENCES countries(code),

        provider TEXT NOT NULL,

        transaction_type TEXT NOT NULL,

        amount_eur REAL NOT NULL DEFAULT 0,

        currency TEXT NOT NULL DEFAULT 'EUR',

        status TEXT NOT NULL DEFAULT 'pending',

        external_id TEXT,

        metadata_json TEXT NOT NULL DEFAULT '{}',

        created_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );

    `);

    console.log(
      '✅ Compliance-Basistabellen geprüft'
    );


    // ========================================================
    // 3. COMPLIANCE CASES
    // ========================================================
    //
    // WICHTIG:
    // Diese Tabelle ist die Ursache für deinen aktuellen
    // NOT NULL Fehler.
    //
    // Wir sorgen dafür, dass compliance_status IMMER einen
    // gültigen Default besitzt.
    // ========================================================

    if (!tableExists('compliance_cases')) {

      db.exec(`

        CREATE TABLE compliance_cases (

          id INTEGER PRIMARY KEY AUTOINCREMENT,

          customer_id INTEGER NOT NULL
            REFERENCES customers(id)
            ON DELETE CASCADE,

          country_code TEXT NOT NULL
            REFERENCES countries(code),

          compliance_status TEXT NOT NULL
            DEFAULT 'needs_review',

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

          UNIQUE(
            customer_id,
            country_code
          )

        );

      `);

      console.log(
        '✅ compliance_cases neu erstellt'
      );

    } else {

      console.log(
        'ℹ️ compliance_cases existiert bereits'
      );

    }


    // ========================================================
    // 4. COMPLIANCE CASES – FEHLENDE SPALTEN
    // ========================================================

    addColumnIfMissing(
      'compliance_cases',
      'compliance_status',
      "TEXT NOT NULL DEFAULT 'needs_review'"
    );

    addColumnIfMissing(
      'compliance_cases',
      'registration_status',
      "TEXT NOT NULL DEFAULT 'not_started'"
    );

    addColumnIfMissing(
      'compliance_cases',
      'representative_status',
      "TEXT NOT NULL DEFAULT 'not_required'"
    );

    addColumnIfMissing(
      'compliance_cases',
      'provider_id',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'provider_case_id',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'external_number',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'external_status',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'snapshot_json',
      "TEXT NOT NULL DEFAULT '{}'"
    );

    addColumnIfMissing(
      'compliance_cases',
      'last_error',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'submitted_at',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'completed_at',
      'TEXT'
    );

    addColumnIfMissing(
      'compliance_cases',
      'created_at',
      "TEXT NOT NULL DEFAULT (datetime('now'))"
    );

    addColumnIfMissing(
      'compliance_cases',
      'updated_at',
      "TEXT NOT NULL DEFAULT (datetime('now'))"
    );


    // ========================================================
    // 5. WICHTIG:
    // ALTE compliance_cases-TABELLE REPARIEREN
    // ========================================================
    //
    // Falls die alte Datenbank eine Spalte
    //
    // compliance_status TEXT NOT NULL
    //
    // OHNE DEFAULT besitzt, hilft ALTER TABLE nicht.
    //
    // Deshalb prüfen wir die Definition.
    // ========================================================

    const complianceStatusInfo =
      columnInfo(
        'compliance_cases',
        'compliance_status'
      );

    if (
      complianceStatusInfo &&
      Number(complianceStatusInfo.notnull) === 1 &&
      complianceStatusInfo.dflt_value === null
    ) {

      console.log(
        '⚠️ Alte compliance_cases-Struktur erkannt.'
      );

      console.log(
        '🔧 Repariere compliance_cases...'
      );


      // Foreign Keys kurz deaktivieren
      db.pragma('foreign_keys = OFF');


      db.exec(`
        ALTER TABLE compliance_cases
        RENAME TO compliance_cases_old
      `);


      db.exec(`

        CREATE TABLE compliance_cases (

          id INTEGER PRIMARY KEY AUTOINCREMENT,

          customer_id INTEGER NOT NULL
            REFERENCES customers(id)
            ON DELETE CASCADE,

          country_code TEXT NOT NULL
            REFERENCES countries(code),

          compliance_status TEXT NOT NULL
            DEFAULT 'needs_review',

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

          UNIQUE(
            customer_id,
            country_code
          )

        );

      `);


      // Vorhandene Daten übernehmen.
      //
      // COALESCE verhindert NULL-Probleme bei alten
      // Datensätzen.

      const oldColumns =
        db
          .prepare(
            `PRAGMA table_info(compliance_cases_old)`
          )
          .all()
          .map(c => c.name);


      const hasOld = name =>
        oldColumns.includes(name);


      const customerIdExpression =
        hasOld('customer_id')
          ? 'customer_id'
          : 'NULL';


      const countryCodeExpression =
        hasOld('country_code')
          ? 'country_code'
          : 'NULL';


      const complianceStatusExpression =
        hasOld('compliance_status')
          ? `COALESCE(
              compliance_status,
              'needs_review'
            )`
          : `'needs_review'`;


      const registrationStatusExpression =
        hasOld('registration_status')
          ? `COALESCE(
              registration_status,
              'not_started'
            )`
          : `'not_started'`;


      const representativeStatusExpression =
        hasOld('representative_status')
          ? `COALESCE(
              representative_status,
              'not_required'
            )`
          : `'not_required'`;


      const providerIdExpression =
        hasOld('provider_id')
          ? 'provider_id'
          : 'NULL';


      const providerCaseIdExpression =
        hasOld('provider_case_id')
          ? 'provider_case_id'
          : 'NULL';


      const externalNumberExpression =
        hasOld('external_number')
          ? 'external_number'
          : 'NULL';


      const externalStatusExpression =
        hasOld('external_status')
          ? 'external_status'
          : 'NULL';


      const snapshotExpression =
        hasOld('snapshot_json')
          ? `COALESCE(
              snapshot_json,
              '{}'
            )`
          : `'{}'`;


      const lastErrorExpression =
        hasOld('last_error')
          ? 'last_error'
          : 'NULL';


      const submittedAtExpression =
        hasOld('submitted_at')
          ? 'submitted_at'
          : 'NULL';


      const completedAtExpression =
        hasOld('completed_at')
          ? 'completed_at'
          : 'NULL';


      const createdAtExpression =
        hasOld('created_at')
          ? `COALESCE(
              created_at,
              datetime('now')
            )`
          : `datetime('now')`;


      const updatedAtExpression =
        hasOld('updated_at')
          ? `COALESCE(
              updated_at,
              datetime('now')
            )`
          : `datetime('now')`;


      db.exec(`

        INSERT OR IGNORE INTO compliance_cases (

          customer_id,

          country_code,

          compliance_status,

          registration_status,

          representative_status,

          provider_id,

          provider_case_id,

          external_number,

          external_status,

          snapshot_json,

          last_error,

          submitted_at,

          completed_at,

          created_at,

          updated_at

        )

        SELECT

          ${customerIdExpression},

          ${countryCodeExpression},

          ${complianceStatusExpression},

          ${registrationStatusExpression},

          ${representativeStatusExpression},

          ${providerIdExpression},

          ${providerCaseIdExpression},

          ${externalNumberExpression},

          ${externalStatusExpression},

          ${snapshotExpression},

          ${lastErrorExpression},

          ${submittedAtExpression},

          ${completedAtExpression},

          ${createdAtExpression},

          ${updatedAtExpression}

        FROM compliance_cases_old

        WHERE customer_id IS NOT NULL
          AND country_code IS NOT NULL

      `);


      db.exec(`
        DROP TABLE compliance_cases_old
      `);


      db.pragma('foreign_keys = ON');


      console.log(
        '✅ compliance_cases erfolgreich repariert'
      );

    }


    // ========================================================
    // 6. INDIZES
    // ========================================================

    db.exec(`

      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_customer

      ON compliance_cases(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_status

      ON compliance_cases(
        registration_status,
        representative_status
      );


      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_compliance

      ON compliance_cases(
        compliance_status
      );


      CREATE INDEX IF NOT EXISTS
      idx_oauth_states_state

      ON oauth_states(state);


      CREATE INDEX IF NOT EXISTS
      idx_provider_transactions_customer

      ON provider_transactions(customer_id);

    `);


    // ========================================================
    // 7. COUNTRIES – DATA STATUS
    // ========================================================

    addColumnIfMissing(
      'countries',
      'data_status',
      "TEXT NOT NULL DEFAULT 'needs_verification'"
    );


    // ========================================================
    // 8. ACTIVATIONS – ALLE BENÖTIGTEN FELDER
    // ========================================================

    addColumnIfMissing(
      'activations',
      'mode_updated_at',
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
      'compliance_status',
      "TEXT DEFAULT 'needs_review'"
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
      "INTEGER NOT NULL DEFAULT 0"
    );


    // ========================================================
    // 9. PRODUCT PACKAGING
    // ========================================================

    addColumnIfMissing(
      'product_packaging',
      'provider_codes_json',
      'TEXT'
    );


    // ========================================================
    // 10. JURISDIKTIONEN
    // ========================================================

    const insertJurisdiction =
      db.prepare(`

        INSERT OR IGNORE INTO
        country_jurisdictions (

          code,
          is_eu

        )

        VALUES (?, ?)

      `);


    const jurisdictionTransaction =
      db.transaction(() => {

        for (
          const [code] of COUNTRIES
        ) {

          insertJurisdiction.run(
            code,
            EU_CODES.has(code) ? 1 : 0
          );

        }

      });


    jurisdictionTransaction();


    console.log(
      '✅ Länder-Jurisdiktionen geprüft'
    );


    // ========================================================
    // 11. ALLE 27 EU-LÄNDER + CH SICHERSTELLEN
    // ========================================================
    //
    // NICHT nur wenn countries leer ist!
    //
    // Genau das war vorher ein Problem.
    // Wenn bereits 5 Länder vorhanden sind, werden die
    // restlichen Länder trotzdem eingefügt.
    // ========================================================

    const insertCountry =
      db.prepare(`

        INSERT OR IGNORE INTO countries (

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

          ?,

          ?,

          ?,

          '[]',

          '[]',

          '[]',

          NULL,

          '[]',

          0,

          0,

          NULL,

          NULL,

          ?,

          'needs_verification'

        )

      `);


    const countryTransaction =
      db.transaction(() => {

        for (
          const [
            code,
            name,
            flag
          ]
          of COUNTRIES
        ) {

          insertCountry.run(

            code,

            name,

            'National register – Pack2EU verification',

            flag

          );

        }

      });


    countryTransaction();


    // ========================================================
    // 12. BEKANNTE REGISTER
    // ========================================================

    db.prepare(`

      UPDATE countries

      SET

        register_body =
          'LUCID / ZSVR',

        registration_url =
          'https://www.verpackungsregister.org/'

      WHERE code = 'DE'

    `).run();


    db.prepare(`

      UPDATE countries

      SET

        register_body =
          'ADEME / SYDEREP',

        registration_url =
          'https://syderep.ademe.fr/'

      WHERE code = 'FR'

    `).run();


    // ========================================================
    // 13. LAPPA PROVIDER
    // ========================================================

    db.prepare(`

      INSERT OR IGNORE INTO compliance_providers (

        id,

        name,

        kind,

        base_url

      )

      VALUES (

        'lappa',

        'Lappa',

        'epr_provider',

        ?

      )

    `).run(

      process.env.LAPPA_BASE_URL || null

    );


    // ========================================================
    // 14. COMPLIANCE RULES – FEHLENDE SPALTEN
    // ========================================================

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
      "INTEGER NOT NULL DEFAULT 0"
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


    // ========================================================
    // 15. ALTE NULL-WERTE BEREINIGEN
    // ========================================================

    db.prepare(`

      UPDATE compliance_cases

      SET compliance_status =
        'needs_review'

      WHERE compliance_status IS NULL

    `).run();


    db.prepare(`

      UPDATE compliance_cases

      SET registration_status =
        'not_started'

      WHERE registration_status IS NULL

    `).run();


    db.prepare(`

      UPDATE compliance_cases

      SET representative_status =
        'not_required'

      WHERE representative_status IS NULL

    `).run();


    db.prepare(`

      UPDATE compliance_cases

      SET snapshot_json =
        '{}'

      WHERE snapshot_json IS NULL

    `).run();


    // ========================================================
    // 16. AKTIVIERUNGEN – ALTE NULL-WERTE BEREINIGEN
    // ========================================================

    db.prepare(`

      UPDATE activations

      SET compliance_status =
        'needs_review'

      WHERE compliance_status IS NULL

    `).run();


    db.prepare(`

      UPDATE activations

      SET registration_status =
        'not_started'

      WHERE registration_status IS NULL

    `).run();


    db.prepare(`

      UPDATE activations

      SET representative_status =
        'not_required'

      WHERE representative_status IS NULL

    `).run();


    db.prepare(`

      UPDATE activations

      SET compliance_snapshot =
        '{}'

      WHERE compliance_snapshot IS NULL

    `).run();


    // ========================================================
    // 17. ABSCHLUSS-CHECK
    // ========================================================

    const countryCount =
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM countries`
        )
        .get().n;


    const complianceCaseColumns =
      db
        .prepare(
          `PRAGMA table_info(compliance_cases)`
        )
        .all()
        .map(c => c.name);


    console.log(
      `✅ Länder in Datenbank: ${countryCount}`
    );


    console.log(
      '✅ compliance_cases Spalten:',
      complianceCaseColumns.join(', ')
    );


    // ========================================================
    // 18. SICHERHEITSCHECK
    // ========================================================

    const requiredTables = [

      'customers',
      'countries',
      'activations',
      'product_packaging',
      'shopify_orders',
      'submissions',
      'representatives',
      'country_jurisdictions',
      'compliance_rules',
      'compliance_providers',
      'compliance_cases',
      'monthly_reports',
      'oauth_states',
      'provider_transactions'

    ];


    for (
      const table
      of requiredTables
    ) {

      if (!tableExists(table)) {

        throw new Error(
          `Erforderliche Tabelle fehlt: ${table}`
        );

      }

    }


    console.log(
      '✅ Alle erforderlichen Tabellen vorhanden'
    );


    console.log(
      '=============================================='
    );

    console.log(
      '✅ DATENBANK-INITIALISIERUNG ABGESCHLOSSEN'
    );

    console.log(
      '=============================================='
    );

    console.log('');

  } catch (error) {

    console.error('');
    console.error(
      '❌ DATENBANK-INITIALISIERUNG FEHLGESCHLAGEN'
    );

    console.error(
      error
    );

    console.error('');

    throw error;
  }
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {
  db,
  init
};
