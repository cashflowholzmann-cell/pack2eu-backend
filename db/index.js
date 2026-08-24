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
// HILFSFUNKTION
// Prüft, ob eine Spalte bereits existiert
// ============================================================

function columnExists(table, column) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all();

  return columns.some(
    c => c.name === column
  );
}


// ============================================================
// SICHERE MIGRATION
// ============================================================

function addColumnIfMissing(
  table,
  column,
  definition
) {
  if (!columnExists(table, column)) {

    db.exec(`
      ALTER TABLE ${table}
      ADD COLUMN ${column} ${definition}
    `);

    console.log(
      `✅ Spalte ${table}.${column} hinzugefügt`
    );

  } else {

    console.log(
      `ℹ️ Spalte ${table}.${column} existiert bereits`
    );
  }
}


// ============================================================
// INIT
// ============================================================

function init() {

  try {

    // --------------------------------------------------------
    // 1. SCHEMA
    // --------------------------------------------------------

    const schema =
      fs.readFileSync(
        path.join(__dirname, 'schema.sql'),
        'utf8'
      );

    db.exec(schema);

    console.log(
      '✅ Schema ausgeführt'
    );


    // --------------------------------------------------------
    // 2. ACTIVATIONS – PROVIDER
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // 3. ACTIVATIONS – LAPPA
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // 4. ACTIVATIONS – VORHANDENER BEVOLLMÄCHTIGTER
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // 5. PRODUCT PACKAGING
    // --------------------------------------------------------

    addColumnIfMissing(
      'product_packaging',
      'provider_codes_json',
      'TEXT'
    );


    // --------------------------------------------------------
    // 6. LÄNDER SEEDEN
    // --------------------------------------------------------

    const count =
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM countries'
        )
        .get().n;


    if (count === 0) {

      const insert =
        db.prepare(`
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
            flag
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
            @flag
          )
        `);


      const seed = [

        {
          code: 'DE',
          name: 'Deutschland',
          register_body: 'LUCID / ZSVR',

          labeling_reqs:
            '["Grüner Punkt (optional)", "Materialkennzeichnung (z.B. PAP 21)"]',

          requirements_json:
            '["Registrierung im LUCID-Verpackungsregister (kostenlos)", "Systembeteiligung bei einem dualen System (z.B. Grüner Punkt)", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Grüner Punkt (optional)", "Materialkennzeichnung (z.B. PAP 21)"]',

          eco_fee:
            'ca. 0,85 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die LUCID-Registrierung für dich", "✅ Wir schließen den Vertrag mit dem dualen System ab", "✅ Wir melden deine Verpackungsmengen jährlich"]',

          representative_required: 0,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://lucid.verpackungsregister.org',

          flag: '🇩🇪'
        },


        {
          code: 'AT',
          name: 'Österreich',
          register_body: 'EDM-Portal / ARA',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht", "Materialkennzeichnung empfohlen"]',

          requirements_json:
            '["Registrierung im EDM-Portal (kostenlos)", "Verpackungslizenzierung bei ARA oder Reclay", "NOTARIELLE BEGLAUBIGUNG der Vollmacht!", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht", "Materialkennzeichnung empfohlen"]',

          eco_fee:
            'ca. 0,80 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die EDM-Registrierung für dich", "✅ Wir kümmern uns um die NOTARIELLE BEGLAUBIGUNG", "✅ Wir schließen den ARA-Lizenzvertrag ab", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 1,
          notary_cost: 'ca. 45 € (digital)',

          registration_url:
            'https://www.ara.at',

          flag: '🇦🇹'
        },


        {
          code: 'FR',
          name: 'Frankreich',
          register_body: 'ADEME / CITEO',

          labeling_reqs:
            '["Triman-Logo", "Sortieranweisung (Consigne de tri)", "Materialkennzeichnung"]',

          requirements_json:
            '["Registrierung bei CITEO oder LEKO", "Triman-Logo auf Verpackung oder Beipackzettel", "Sortieranweisung (Consigne de tri) angeben", "Jährliche Mengenmeldung an CITEO"]',

          labeling_json:
            '["Triman-Logo", "Sortieranweisung (Consigne de tri)", "Materialkennzeichnung"]',

          eco_fee:
            'ca. 1,20 €/kg Pappe',

          steps_json:
            '["✅ Wir schließen den CITEO-Vertrag für dich ab", "✅ Wir kümmern uns um das Triman-Logo", "✅ Wir melden deine Mengen jährlich an CITEO"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.citeo.com',

          flag: '🇫🇷'
        },


        {
          code: 'IT',
          name: 'Italien',
          register_body: 'CONAI',

          labeling_reqs:
            '["CONAI-Materialcode (z.B. C/PAP 21)", "Materialkennzeichnung pro Fraktion"]',

          requirements_json:
            '["Registrierung bei CONAI", "CONAI-Materialcode angeben (z.B. C/PAP 21)", "Getrennte Materialkennzeichnung pro Fraktion", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["CONAI-Materialcode (z.B. C/PAP 21)", "Materialkennzeichnung pro Fraktion"]',

          eco_fee:
            'ca. 0,95 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die CONAI-Registrierung für dich", "✅ Wir kümmern uns um die Materialcodes", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.conai.org',

          flag: '🇮🇹'
        },


        {
          code: 'ES',
          name: 'Spanien',
          register_body: 'Ecoembes / MITERD',

          labeling_reqs:
            '["Punto Verde-Symbol (empfohlen)", "Materialcode bei kompostierbaren Anteilen"]',

          requirements_json:
            '["Registrierung im staatlichen Register (MITERD)", "Vertrag mit Ecoembes", "Punto Verde-Symbol empfohlen", "Materialcode bei kompostierbaren Anteilen"]',

          labeling_json:
            '["Punto Verde-Symbol (empfohlen)", "Materialcode bei kompostierbaren Anteilen"]',

          eco_fee:
            'ca. 0,75 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die MITERD-Registrierung für dich", "✅ Wir schließen den Ecoembes-Vertrag ab", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.ecoembes.com',

          flag: '🇪🇸'
        },


        {
          code: 'BE',
          name: 'Belgien',
          register_body: 'FPS Health',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht"]',

          requirements_json:
            '["Registrierung bei FPS Health", "Nur 11 Pflichtfelder (einfachstes System)", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht"]',

          eco_fee:
            'ca. 0,90 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die FPS Health-Registrierung für dich", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.health.belgium.be',

          flag: '🇧🇪'
        },


        {
          code: 'NL',
          name: 'Niederlande',
          register_body: 'Eigenes System',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht"]',

          requirements_json:
            '["Registrierung im niederländischen System", "Bagatellgrenze 50t bis Ende 2026", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht"]',

          eco_fee:
            'ca. 0,85 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die niederländische Registrierung für dich", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 0,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.verpakkingen.nl',

          flag: '🇳🇱'
        },


        {
          code: 'PL',
          name: 'Polen',
          register_body: 'BDO',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht"]',

          requirements_json:
            '["Registrierung im BDO-System", "Nationale e-Identity erforderlich", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht"]',

          eco_fee:
            'ca. 0,65 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die BDO-Registrierung für dich", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://bdo.mos.gov.pl',

          flag: '🇵🇱'
        },


        {
          code: 'SE',
          name: 'Schweden',
          register_body: 'Naturvårdsverket',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht"]',

          requirements_json:
            '["Registrierung bei Naturvårdsverket", "21 Pflichtfelder (die meisten!)", "Nationale e-Identity erforderlich", "Jährliche Mengenmeldung"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht"]',

          eco_fee:
            'ca. 0,95 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die Naturvårdsverket-Registrierung für dich", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.naturvardsverket.se',

          flag: '🇸🇪'
        },


        {
          code: 'DK',
          name: 'Dänemark',
          register_body: 'Dansk Producentansvar',

          labeling_reqs:
            '["Keine spezielle Kennzeichnungspflicht"]',

          requirements_json:
            '["Registrierung im dänischen System", "Jährliche Mengenmeldung", "Dänische Steuernummer erforderlich"]',

          labeling_json:
            '["Keine spezielle Kennzeichnungspflicht"]',

          eco_fee:
            'ca. 0,70 €/kg Pappe',

          steps_json:
            '["✅ Wir beantragen die dänische Registrierung für dich", "✅ Wir melden deine Mengen jährlich"]',

          representative_required: 1,
          notary_required: 0,
          notary_cost: '',

          registration_url:
            'https://www.dpa-system.dk',

          flag: '🇩🇰'
        }

      ];


      const insertMany =
        db.transaction(rows => {

          rows.forEach(row =>
            insert.run(row)
          );

        });


      insertMany(seed);

      console.log(
        '✅ Länder mit allen Details wurden in die Datenbank eingefügt'
      );
    }


    console.log(
      '✅ Datenbank-Initialisierung abgeschlossen'
    );


  } catch (err) {

    console.error(
      '❌ Fehler bei der Datenbank-Initialisierung:',
      err.message
    );

    throw err;
  }
}


module.exports = db;

module.exports.init = init;
