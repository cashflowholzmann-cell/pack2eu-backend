const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');


// ============================================================
// DATENBANK
// ============================================================

const DB_PATH =
  process.env.DB_PATH ||
  path.join(__dirname, 'pack2eu.db');


const db =
  new Database(DB_PATH);


db.pragma(
  'journal_mode = WAL'
);

db.pragma(
  'foreign_keys = ON'
);


// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function tableExists(table) {

  const row =
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `).get(table);

  return Boolean(row);
}


function columnExists(
  table,
  column
) {

  if (!tableExists(table)) {
    return false;
  }

  const columns =
    db.prepare(
      `PRAGMA table_info(${table})`
    ).all();

  return columns.some(
    columnInfo =>
      columnInfo.name === column
  );
}


function addColumnIfMissing(
  table,
  column,
  definition
) {

  if (
    tableExists(table) &&
    !columnExists(table, column)
  ) {

    db.exec(`
      ALTER TABLE ${table}
      ADD COLUMN ${column} ${definition}
    `);

    console.log(
      `✅ Spalte ${table}.${column} hinzugefügt`
    );
  }
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

  // Schweiz für Pack2EU
  ['CH', 'Schweiz', '🇨🇭']

];


// ============================================================
// INIT
// ============================================================

function init() {

  try {

    // --------------------------------------------------------
    // 1. BASISSCHEMA AUSFÜHREN
    // --------------------------------------------------------

    const schemaPath =
      path.join(
        __dirname,
        'schema.sql'
      );


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


    // --------------------------------------------------------
    // 2. COMPLIANCE BASIS-TABELLEN
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


      CREATE TABLE IF NOT EXISTS compliance_cases (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL
          REFERENCES countries(code),

        provider_id TEXT,

        provider_case_id TEXT,

        representative_status TEXT
          DEFAULT 'not_required',

        external_status TEXT,

        external_number TEXT,

        last_error TEXT,

        created_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        UNIQUE(
          customer_id,
          country_code
        )
      );


      CREATE TABLE IF NOT EXISTS monthly_reports (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        customer_id INTEGER NOT NULL
          REFERENCES customers(id)
          ON DELETE CASCADE,

        country_code TEXT NOT NULL,

        period TEXT NOT NULL,

        totals_json TEXT NOT NULL,

        status TEXT NOT NULL
          DEFAULT 'draft',

        updated_at TEXT NOT NULL
          DEFAULT (datetime('now')),

        UNIQUE(
          customer_id,
          country_code,
          period
        )
      );

    `);


    // --------------------------------------------------------
    // 3. LÄNDER-METADATEN
    // --------------------------------------------------------

    addColumnIfMissing(
      'countries',
      'data_status',
      "TEXT NOT NULL DEFAULT 'needs_verification'"
    );


    // --------------------------------------------------------
    // 4. ACTIVATIONS – ALLE BENÖTIGTEN FELDER
    // --------------------------------------------------------

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
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'registration_status',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'representative_status',
      'TEXT'
    );

    addColumnIfMissing(
      'activations',
      'compliance_snapshot',
      'TEXT'
    );


    // --------------------------------------------------------
    // 5. PRODUCT PACKAGING
    // --------------------------------------------------------

    addColumnIfMissing(
      'product_packaging',
      'provider_codes_json',
      'TEXT'
    );


    // --------------------------------------------------------
    // 6. EU JURISDICTIONEN
    // --------------------------------------------------------

    const euCodes = COUNTRIES
      .filter(
        ([code]) =>
          code !== 'CH'
      )
      .map(
        ([code]) => code
      );


    const insertJurisdiction =
      db.prepare(`
        INSERT OR IGNORE INTO
        country_jurisdictions
        (code, is_eu)
        VALUES (?, ?)
      `);


    const jurisdictionTransaction =
      db.transaction(
        () => {

          for (
            const code
            of euCodes
          ) {

            insertJurisdiction.run(
              code,
              1
            );
          }


          insertJurisdiction.run(
            'CH',
            0
          );
        }
      );


    jurisdictionTransaction();


    // --------------------------------------------------------
    // 7. ALLE LÄNDER SICHERSTELLEN
    // --------------------------------------------------------

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
      db.transaction(
        () => {

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
        }
      );


    countryTransaction();


    // --------------------------------------------------------
    // 8. BEKANNTE REGISTER-DATEN
    // --------------------------------------------------------

    db.prepare(`
      UPDATE countries
      SET
        register_body = 'LUCID / ZSVR',
        registration_url =
          'https://www.verpackungsregister.org/'
      WHERE code = 'DE'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body =
          'ADEME / SYDEREP'
      WHERE code = 'FR'
    `).run();


    // --------------------------------------------------------
    // 9. PROVIDER
    // --------------------------------------------------------

    db.prepare(`
      INSERT OR IGNORE INTO
      compliance_providers
      (
        id,
        name,
        kind,
        base_url
      )
      VALUES
      (
        'lappa',
        'Lappa',
        'epr_provider',
        ?
      )
    `).run(
      process.env.LAPPA_BASE_URL ||
      null
    );


    // --------------------------------------------------------
    // 10. COMPLIANCE REGELN
    // --------------------------------------------------------
    //
    // Nur Regeln verwenden, die bereits in der bisherigen
    // Pack2EU-Logik als Primary Source verifiziert waren.
    //
    // Alles andere bleibt needs_review.
    // --------------------------------------------------------

    const upsertRule =
      db.prepare(`
        INSERT INTO compliance_rules (

          origin_code,

          destination_code,

          registration_required,

          representative_required,

          notary_required,

          status,

          legal_label,

          explanation,

          legal_basis,

          confidence,

          policy_version,

          source_url,

          source_type,

          provider_available,

          provider_id,

          provider_cost_eur,

          effective_from,

          active

        )

        VALUES (

          @origin,

          @destination,

          @registration,

          @representative,

          @notary,

          @status,

          @label,

          @explanation,

          @basis,

          @confidence,

          @version,

          @sourceUrl,

          @sourceType,

          @providerAvailable,

          @providerId,

          @providerCostEur,

          @effectiveFrom,

          1

        )

        ON CONFLICT(
          origin_code,
          destination_code
        )

        DO UPDATE SET

          registration_required =
            excluded.registration_required,

          representative_required =
            excluded.representative_required,

          notary_required =
            excluded.notary_required,

          status =
            excluded.status,

          legal_label =
            excluded.legal_label,

          explanation =
            excluded.explanation,

          legal_basis =
            excluded.legal_basis,

          confidence =
            excluded.confidence,

          policy_version =
            excluded.policy_version,

          source_url =
            excluded.source_url,

          source_type =
            excluded.source_type,

          provider_available =
            excluded.provider_available,

          provider_id =
            excluded.provider_id,

          provider_cost_eur =
            excluded.provider_cost_eur,

          effective_from =
            excluded.effective_from,

          active = 1
      `);


    const origins =
      COUNTRIES.map(
        ([code]) => code
      );


    const verifiedRules = [];


    // --------------------------------------------------------
    // DEUTSCHLAND
    // --------------------------------------------------------

    for (
      const origin
      of origins
    ) {

      const domestic =
        origin === 'DE';


      verifiedRules.push({

        origin,

        destination:
          'DE',

        registration:
          1,

        representative:
          domestic
            ? 0
            : 1,

        notary:
          0,

        status:
          domestic
            ? 'registration_required'
            : 'representative_required',

        label:
          domestic
            ? 'Registrierung erforderlich'
            : 'Bevollmächtigter erforderlich',

        explanation:
          domestic

            ? 'Für deutsche Unternehmen bleibt die Registrierung im LUCID-Verpackungsregister erforderlich.'

            : 'Für Unternehmen mit Sitz außerhalb Deutschlands ist für die betroffenen EPR-Pflichten ein Bevollmächtigter in Deutschland erforderlich.',

        basis:
          'VerpackG / ZSVR; Regulation (EU) 2025/40',

        confidence:
          'primary_source_verified',

        version:
          '2026-08-25-primary-source',

        sourceUrl:
          'https://www.verpackungsregister.org/en/knowledge-bases/authorising-a-representative',

        sourceType:
          'national_authority',

        providerAvailable:
          domestic
            ? 0
            : 1,

        providerId:
          domestic
            ? null
            : 'lappa',

        providerCostEur:
          null,

        effectiveFrom:
          '2026-08-12'
      });
    }


    // --------------------------------------------------------
    // FRANKREICH
    // --------------------------------------------------------

    for (
      const origin
      of origins
    ) {

      const domestic =
        origin === 'FR';


      verifiedRules.push({

        origin,

        destination:
          'FR',

        registration:
          1,

        representative:
          domestic
            ? 0
            : 1,

        notary:
          0,

        status:
          domestic
            ? 'registration_required'
            : 'representative_required',

        label:
          domestic
            ? 'Registrierung erforderlich'
            : 'Bevollmächtigter erforderlich',

        explanation:
          domestic

            ? 'Für in Frankreich etablierte Unternehmen gelten die französischen EPR-Registrierungs- und Meldepflichten.'

            : 'Für Unternehmen ohne Niederlassung in Frankreich kann bei französischen EPR-Pflichten ein in Frankreich ansässiger Bevollmächtigter erforderlich sein.',

        basis:
          'Code de l’environnement, Article L541-10-9-1; Regulation (EU) 2025/40',

        confidence:
          'primary_source_verified',

        version:
          '2026-08-25-primary-source',

        sourceUrl:
          'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000054403121/2026-07-17',

        sourceType:
          'national_law',

        providerAvailable:
          domestic
            ? 0
            : 1,

        providerId:
          domestic
            ? null
            : 'lappa',

        providerCostEur:
          null,

        effectiveFrom:
          '2026-07-10'
      });
    }


    const ruleTransaction =
      db.transaction(
        () => {

          for (
            const rule
            of verifiedRules
          ) {

            upsertRule.run(
              rule
            );
          }
        }
      );


    ruleTransaction();


    // --------------------------------------------------------
    // 11. DE/FR ALS VERIFIZIERT MARKIEREN
    // --------------------------------------------------------

    db.prepare(`
      UPDATE countries
      SET data_status = 'verified'
      WHERE code IN ('DE', 'FR')
    `).run();


    // --------------------------------------------------------
    // 12. INDIZES
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
      idx_compliance_rules_pair
      ON compliance_rules(
        origin_code,
        destination_code,
        active
      );


      CREATE INDEX IF NOT EXISTS
      idx_compliance_cases_customer
      ON compliance_cases(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_product_packaging_customer
      ON product_packaging(customer_id);


      CREATE INDEX IF NOT EXISTS
      idx_shopify_orders_customer
      ON shopify_orders(customer_id);

    `);


    console.log(
      '✅ Länder mit allen Details wurden in die Datenbank eingefügt'
    );

    console.log(
      '✅ Compliance-Regeln initialisiert'
    );

    console.log(
      '✅ Datenbank-Initialisierung abgeschlossen'
    );

  } catch (error) {

    console.error(
      '❌ Datenbank-Initialisierung fehlgeschlagen:',
      error
    );

    throw error;
  }
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  prepare: (...args) =>
    db.prepare(...args),

  exec: (...args) =>
    db.exec(...args),

  transaction: (...args) =>
    db.transaction(...args),

  pragma: (...args) =>
    db.pragma(...args),

  init,

  db
};
