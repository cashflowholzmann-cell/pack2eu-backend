const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ============================================================
// DATENBANK
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

function tableExists(tableName) {
  const row = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `)
    .get(tableName);

  return !!row;
}


function columnExists(tableName, columnName) {
  if (!tableExists(tableName)) {
    return false;
  }

  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all();

  return columns.some(
    column => column.name === columnName
  );
}


function columnInfo(tableName, columnName) {
  if (!tableExists(tableName)) {
    return null;
  }

  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .find(column => column.name === columnName) || null;
}


function addColumnIfMissing(
  tableName,
  columnName,
  definition
) {
  if (columnExists(tableName, columnName)) {
    return;
  }

  db.exec(`
    ALTER TABLE ${tableName}
    ADD COLUMN ${columnName} ${definition}
  `);

  console.log(
    `✅ Spalte ${tableName}.${columnName} hinzugefügt`
  );
}


// ============================================================
// LÄNDER
// ============================================================

const EU_COUNTRIES = [

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
  ['SK', 'Slowakei', '🇸🇰']

];

const NON_EU_COUNTRIES = [

  ['CH', 'Schweiz', '🇨🇭'],
  ['GB', 'Vereinigtes Königreich', '🇬🇧'],
  ['NO', 'Norwegen', '🇳🇴'],
  ['IS', 'Island', '🇮🇸'],
  ['LI', 'Liechtenstein', '🇱🇮'],
  ['US', 'USA', '🇺🇸'],
  ['CA', 'Kanada', '🇨🇦'],
  ['CN', 'China', '🇨🇳'],
  ['JP', 'Japan', '🇯🇵'],
  ['AU', 'Australien', '🇦🇺'],
  ['IN', 'Indien', '🇮🇳'],
  ['TH', 'Thailand', '🇹🇭']

];

const ALL_COUNTRIES = [
  ...EU_COUNTRIES,
  ...NON_EU_COUNTRIES
];

const EU_CODES = new Set(
  EU_COUNTRIES.map(country => country[0])
);


// ============================================================
// INITIALISIERUNG
// ============================================================

function init() {

  try {

    console.log('');
    console.log('==============================================');
    console.log('🗄️ PACK2EU DATENBANK INITIALISIERUNG');
    console.log('==============================================');


    // ========================================================
    // 1. BASIS-SCHEMA
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

    console.log('✅ Schema ausgeführt');


    // ========================================================
    // 2. CUSTOMERS – SICHERSTELLEN
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_number TEXT UNIQUE NOT NULL,

        company_name TEXT NOT NULL,

        origin_country TEXT NOT NULL,

        contact_name TEXT,

        email TEXT UNIQUE NOT NULL,

        password_hash TEXT NOT NULL,

        plan TEXT NOT NULL DEFAULT 'M',

        is_eu INTEGER NOT NULL DEFAULT 1,

        stripe_customer_id TEXT UNIQUE,

        stripe_subscription_id TEXT UNIQUE,

        subscription_status TEXT NOT NULL
          DEFAULT 'inactive',

        shopify_shop_domain TEXT UNIQUE,

        shopify_access_token TEXT,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );
    `);


    addColumnIfMissing(
      'customers',
      'origin_country',
      "TEXT NOT NULL DEFAULT 'DE'"
    );

    addColumnIfMissing(
      'customers',
      'contact_name',
      'TEXT'
    );

    addColumnIfMissing(
      'customers',
      'plan',
      "TEXT NOT NULL DEFAULT 'M'"
    );

    addColumnIfMissing(
      'customers',
      'is_eu',
      'INTEGER NOT NULL DEFAULT 1'
    );

    addColumnIfMissing(
      'customers',
      'subscription_status',
      "TEXT NOT NULL DEFAULT 'inactive'"
    );

    addColumnIfMissing(
      'customers',
      'stripe_customer_id',
      'TEXT'
    );

    addColumnIfMissing(
      'customers',
      'stripe_subscription_id',
      'TEXT'
    );

    addColumnIfMissing(
      'customers',
      'shopify_shop_domain',
      'TEXT'
    );

    addColumnIfMissing(
      'customers',
      'shopify_access_token',
      'TEXT'
    );

    addColumnIfMissing(
      'customers',
      'created_at',
      "TEXT NOT NULL DEFAULT (datetime('now'))"
    );

    addColumnIfMissing(
      'customers',
      'updated_at',
      "TEXT NOT NULL DEFAULT (datetime('now'))"
    );


    // ========================================================
    // 3. COUNTRIES
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS countries (

        code TEXT PRIMARY KEY,

        name TEXT NOT NULL,

        register_body TEXT NOT NULL,

        labeling_reqs TEXT NOT NULL DEFAULT '[]',

        requirements_json TEXT NOT NULL DEFAULT '[]',

        labeling_json TEXT NOT NULL DEFAULT '[]',

        eco_fee TEXT,

        steps_json TEXT NOT NULL DEFAULT '[]',

        representative_required
          INTEGER NOT NULL DEFAULT 0,

        notary_required
          INTEGER NOT NULL DEFAULT 0,

        notary_cost TEXT,

        registration_url TEXT,

        flag TEXT DEFAULT '🌍'

      );
    `);


    addColumnIfMissing(
      'countries',
      'data_status',
      "TEXT NOT NULL DEFAULT 'needs_verification'"
    );


    // ========================================================
    // 4. ALLE LÄNDER SICHERSTELLEN
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


    const seedCountries =
      db.transaction(() => {

        for (
          const [
            code,
            name,
            flag
          ]
          of ALL_COUNTRIES
        ) {

          insertCountry.run(
            code,
            name,
            'National register – Pack2EU verification',
            flag
          );

        }

      });


    seedCountries();

    console.log(
      `✅ Länder geprüft: ${ALL_COUNTRIES.length}`
    );


    // ========================================================
    // 5. BEKANNTE REGISTER
    // ========================================================

    db.prepare(`
      UPDATE countries
      SET
        register_body = 'LUCID / ZSVR',
        registration_url =
          'https://lucid.verpackungsregister.org'
      WHERE code = 'DE'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'ADEME / SYDEREP',
        registration_url =
          'https://syderep.ademe.fr/'
      WHERE code = 'FR'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'EDM-Portal / ARA'
      WHERE code = 'AT'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Register / EPR-System'
      WHERE code = 'BE'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Register / EPR-System'
      WHERE code = 'PL'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Register / EPR-System'
      WHERE code = 'CH'
    `).run();


    // ========================================================
    // 6. JURISDIKTIONEN
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS country_jurisdictions (

        code TEXT PRIMARY KEY,

        is_eu INTEGER NOT NULL DEFAULT 0

      );
    `);


    const insertJurisdiction =
      db.prepare(`
        INSERT OR IGNORE INTO
        country_jurisdictions (
          code,
          is_eu
        )
        VALUES (?, ?)
      `);


    const seedJurisdictions =
      db.transaction(() => {

        for (
          const [
            code
          ]
            of ALL_COUNTRIES
        ) {

          insertJurisdiction.run(
            code,
            EU_CODES.has(code)
              ? 1
              : 0
          );

        }

      });


    seedJurisdictions();

    console.log(
      '✅ Länder-Jurisdiktionen geprüft'
    );


    // ========================================================
    // 7. COMPLIANCE RULES
    // ========================================================

    db.exec(`
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

        active INTEGER NOT NULL DEFAULT 1,

        UNIQUE(
          origin_code,
          destination_code
        )

      );
    `);


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


    // ========================================================
    // 8. PROVIDER
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_providers (

        id TEXT PRIMARY KEY,

        name TEXT NOT NULL,

        kind TEXT NOT NULL,

        base_url TEXT,

        active INTEGER NOT NULL DEFAULT 1,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );
    `);


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
    // 9. COMPLIANCE CASES
    // ========================================================
    //
    // WICHTIG:
    //
    // compliance_status MUSS einen DEFAULT haben.
    //
    // Genau hier lag dein letzter Fehler:
    //
    // NOT NULL constraint failed:
    // compliance_cases.compliance_status
    //
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

      // ======================================================
      // EXISTIERENDE TABELLE PRÜFEN
      // ======================================================

      const statusInfo =
        columnInfo(
          'compliance_cases',
          'compliance_status'
        );


      // Alte Version:
      //
      // compliance_status TEXT NOT NULL
      //
      // ohne DEFAULT
      //
      // Diese Version muss repariert werden.

      if (
        statusInfo &&
        Number(statusInfo.notnull) === 1 &&
        statusInfo.dflt_value === null
      ) {

        console.log(
          '⚠️ Alte compliance_cases-Struktur erkannt.'
        );

        console.log(
          '🔧 Repariere compliance_cases...'
        );


        db.pragma(
          'foreign_keys = OFF'
        );


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


        const oldColumns =
          db
            .prepare(
              `PRAGMA table_info(compliance_cases_old)`
            )
            .all()
            .map(
              column => column.name
            );


        const hasOld =
          name =>
            oldColumns.includes(name);


        const expression =
          (
            name,
            fallback
          ) => {

            if (!hasOld(name)) {
              return fallback;
            }

            return name;
          };


        const complianceExpression =
          hasOld('compliance_status')
            ? `COALESCE(
                compliance_status,
                'needs_review'
              )`
            : `'needs_review'`;


        const registrationExpression =
          hasOld('registration_status')
            ? `COALESCE(
                registration_status,
                'not_started'
              )`
            : `'not_started'`;


        const representativeExpression =
          hasOld('representative_status')
            ? `COALESCE(
                representative_status,
                'not_required'
              )`
            : `'not_required'`;


        const providerExpression =
          expression(
            'provider_id',
            'NULL'
          );


        const providerCaseExpression =
          expression(
            'provider_case_id',
            'NULL'
          );


        const externalNumberExpression =
          expression(
            'external_number',
            'NULL'
          );


        const externalStatusExpression =
          expression(
            'external_status',
            'NULL'
          );


        const snapshotExpression =
          hasOld('snapshot_json')
            ? `COALESCE(
                snapshot_json,
                '{}'
              )`
            : `'{}'`;


        const lastErrorExpression =
          expression(
            'last_error',
            'NULL'
          );


        const submittedExpression =
          expression(
            'submitted_at',
            'NULL'
          );


        const completedExpression =
          expression(
            'completed_at',
            'NULL'
          );


        const createdExpression =
          hasOld('created_at')
            ? `COALESCE(
                created_at,
                datetime('now')
              )`
            : `datetime('now')`;


        const updatedExpression =
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

            customer_id,
            country_code,

            ${complianceExpression},
            ${registrationExpression},
            ${representativeExpression},

            ${providerExpression},
            ${providerCaseExpression},

            ${externalNumberExpression},
            ${externalStatusExpression},

            ${snapshotExpression},
            ${lastErrorExpression},

            ${submittedExpression},
            ${completedExpression},

            ${createdExpression},
            ${updatedExpression}

          FROM compliance_cases_old

          WHERE customer_id IS NOT NULL
            AND country_code IS NOT NULL
        `);


        db.exec(`
          DROP TABLE compliance_cases_old
        `);


        db.pragma(
          'foreign_keys = ON'
        );


        console.log(
          '✅ compliance_cases erfolgreich repariert'
        );

      }

      // Fehlende Spalten absichern

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
        "TEXT DEFAULT '{}'"
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

    }


    // ========================================================
    // 10. ACTIVATIONS
    // ========================================================

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
      'mode_updated_at',
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
      'INTEGER NOT NULL DEFAULT 0'
    );


    // ========================================================
    // 11. PRODUCT PACKAGING
    // ========================================================

    addColumnIfMissing(
      'product_packaging',
      'provider_codes_json',
      'TEXT'
    );

    addColumnIfMissing(
      'product_packaging',
      'destination',
      'TEXT'
    );


    // ========================================================
    // 12. OAUTH STATES
    // ========================================================

    db.exec(`
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
    `);


    // ========================================================
    // 13. PROVIDER TRANSACTIONS
    // ========================================================

    db.exec(`
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


    // ========================================================
    // 14. MONTHLY REPORTS
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS monthly_reports (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL
          REFERENCES countries(code),

        period TEXT NOT NULL,

        totals_json TEXT NOT NULL DEFAULT '{}',

        status TEXT NOT NULL DEFAULT 'draft',

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
    `);


    // ========================================================
    // 15. REPRESENTATIVES
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS representatives (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        country_code TEXT NOT NULL
          REFERENCES countries(code),

        name TEXT NOT NULL,

        email TEXT UNIQUE NOT NULL,

        password_hash TEXT NOT NULL,

        company TEXT,

        active INTEGER NOT NULL DEFAULT 1,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now'))

      );
    `);


    // ========================================================
    // 16. NULL-WERTE BEREINIGEN
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
    // 17. INDIZES
    // ========================================================

    db.exec(`

      CREATE INDEX IF NOT EXISTS
      idx_product_packaging_customer

      ON product_packaging(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_shopify_orders_customer

      ON shopify_orders(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_activations_customer

      ON activations(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_activations_mode

      ON activations(mode);


      CREATE INDEX IF NOT EXISTS
      idx_activations_country

      ON activations(country_code);


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
    // 18. ABSCHLUSS-CHECK
    // ========================================================

    const countryCount =
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM countries`
        )
        .get()
        .n;


    const customerColumns =
      db
        .prepare(
          `PRAGMA table_info(customers)`
        )
        .all()
        .map(
          column => column.name
        );


    const activationColumns =
      db
        .prepare(
          `PRAGMA table_info(activations)`
        )
        .all()
        .map(
          column => column.name
        );


    const complianceColumns =
      db
        .prepare(
          `PRAGMA table_info(compliance_cases)`
        )
        .all()
        .map(
          column => column.name
        );


    console.log('');
    console.log('==============================================');
    console.log('✅ DATENBANK-CHECK');
    console.log('==============================================');

    console.log(
      `🌍 Länder: ${countryCount}`
    );

    console.log(
      `👤 customers: ${customerColumns.length} Spalten`
    );

    console.log(
      `🌍 activations: ${activationColumns.length} Spalten`
    );

    console.log(
      `⚖️ compliance_cases: ${complianceColumns.length} Spalten`
    );


    // ========================================================
    // KRITISCHE TABELLEN
    // ========================================================

    const requiredTables = [

      'customers',
      'countries',
      'activations',
      'product_packaging',
      'orders',
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


    // ========================================================
    // KRITISCHE SPALTEN
    // ========================================================

    const criticalColumns = [

      ['customers', 'customer_number'],
      ['customers', 'company_name'],
      ['customers', 'origin_country'],
      ['customers', 'email'],
      ['customers', 'password_hash'],
      ['customers', 'plan'],
      ['customers', 'is_eu'],

      ['countries', 'code'],
      ['countries', 'name'],

      ['activations', 'customer_id'],
      ['activations', 'country_code'],
      ['activations', 'status'],

      ['compliance_cases', 'customer_id'],
      ['compliance_cases', 'country_code'],
      ['compliance_cases', 'compliance_status'],
      ['compliance_cases', 'registration_status'],
      ['compliance_cases', 'representative_status']

    ];


    for (
      const [
        table,
        column
      ]
        of criticalColumns
    ) {

      if (
        !columnExists(
          table,
          column
        )
      ) {

        throw new Error(
          `Erforderliche Spalte fehlt: ${table}.${column}`
        );

      }

    }


    console.log(
      '✅ Alle kritischen Tabellen vorhanden'
    );

    console.log(
      '✅ Alle kritischen Spalten vorhanden'
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
