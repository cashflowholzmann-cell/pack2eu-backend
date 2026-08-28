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

    addColumnIfMissing(
      'countries',
      'representative_provider_name',
      'TEXT'
    );

    addColumnIfMissing(
      'countries',
      'representative_provider_url',
      'TEXT'
    );

    addColumnIfMissing(
      'countries',
      'representative_data_status',
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
        registration_url = 'https://lucid.verpackungsregister.org',
        requirements_json = ?,
        labeling_json = ?,
        eco_fee = 'Lizenzentgelt je nach Material/Gewicht beim gewählten dualen System (Systembeteiligung); die Registrierung bei LUCID selbst ist kostenlos.',
        representative_provider_name = 'REP-Germany',
        representative_provider_url = 'https://rep-germany.de/bestellen/',
        representative_data_status = 'verified',
        data_status = 'verified'
      WHERE code = 'DE'
    `).run(
      JSON.stringify([
        'Registrierungspflicht im Verpackungsregister LUCID für jedes Unternehmen, das verpackte Ware erstmals in Deutschland in Verkehr bringt – unabhängig von Menge oder Unternehmensgröße.',
        'Systembeteiligung (Lizenzierung) bei einem dualen System für alle mit Ware befüllten Verkaufsverpackungen.',
        'Bevollmächtigter in Deutschland zwingend erforderlich für Unternehmen ohne Sitz in Deutschland, seit 12.08.2026 (VerpackDG/PPWR).'
      ]),
      JSON.stringify([
        'Herstellerkennzeichnung (Name, Postanschrift) auf der Verpackung.',
        'Kennzeichnungspflichten zur Recyclingfähigkeit gemäß PPWR (stufenweise Einführung).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'ADEME / SYDEREP',
        registration_url = 'https://syderep.ademe.fr/',
        requirements_json = ?,
        labeling_json = ?,
        eco_fee = 'Éco-contribution an das gewählte Eco-organisme, gestaffelt nach Material, Gewicht und Recyclingfähigkeit.',
        representative_provider_name = 'EPR Representative (France)',
        representative_provider_url = 'https://eprrepresentative.com/fr/mandataire-rep-france',
        representative_data_status = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'FR'
    `).run(
      JSON.stringify([
        'Mandataire (Bevollmächtigter) in Frankreich zwingend seit 10.07.2026 für Unternehmen ohne Sitz in Frankreich.',
        'Mitgliedschaft bei einem Eco-organisme und jährliche Meldung der Verpackungsmengen über SYDEREP/ADEME.',
        'Eindeutige REP-Kennung (identifiant unique) erforderlich.'
      ]),
      JSON.stringify([
        'Triman-Logo und Sortieranweisung (Info-tri) auf Verkaufsverpackungen vorgeschrieben.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'EDM-Portal / ARA',
        registration_url = 'https://edm.gv.at/edm_portal/cms.do?get=%2Fportal%2Finformationen%2Fanwendungenthemen%2Fverpackung.main',
        requirements_json = ?,
        eco_fee = 'Lizenzentgelt beim gewählten Sammel-/Verwertungssystem (z. B. ARA), abhängig von Material und Menge.',
        representative_data_status = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'AT'
    `).run(
      JSON.stringify([
        'Einmalige Registrierung im elektronischen Verpackungsregister (EDM), z. B. über das Unternehmensserviceportal (USP).',
        'Systembeteiligung/Lizenzierung über ein genehmigtes Sammel- und Verwertungssystem wie ARA.',
        'Bevollmächtigter in Österreich bereits vor PPWR für ausländische Erstinverkehrbringer verpflichtend.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'CONAI (Übergang – nationales PPWR-Produzentenregister RENAP für Verpackungen noch nicht vollständig aktiv)',
        registration_url = 'https://www.conai.org',
        requirements_json = ?,
        eco_fee = 'CONAI-Umweltbeitrag (Contributo Ambientale CONAI, CAC), materialabhängig gestaffelt.',
        data_status = 'needs_verification'
      WHERE code = 'IT'
    `).run(
      JSON.stringify([
        'Stand 08/2026: Die EPR-Pflichten für Verpackungen laufen weiterhin über CONAI; ein eigenständiges PPWR-Produzentenregister (RENAP) ist für Verpackungen noch nicht vollständig in Betrieb.',
        'Paralleler Weiterbetrieb von CONAI und PPWR-System voraussichtlich bis 11.08.2028 vorgesehen.',
        'Nationale Durchführungsbestimmungen zu Registrierung und Bevollmächtigten werden im Laufe 2026 erwartet – noch nicht final.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Registro de Productores de Envases (RPE) / MITECO',
        registration_url = 'https://www.miteco.gob.es/es/calidad-y-evaluacion-ambiental/temas/prevencion-y-gestion-residuos/prevencion-y-gestion-residuos/registro-productores-producto-seccion-envases.html',
        requirements_json = ?,
        eco_fee = 'Beitrag an das gewählte SCRAP (z. B. Ecoembes), material- und mengenabhängig.',
        representative_provider_name = 'Heura',
        representative_provider_url = 'https://heura.net/representante-autorizado-en-espana-ppwr/',
        representative_data_status = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'ES'
    `).run(
      JSON.stringify([
        'Zweistufige Registrierung: Eintragung im RPE (MITECO) und Beitritt zu einem SCRAP (Sistema Colectivo, z. B. Ecoembes).',
        'Jährliche Meldung der Verpackungsmengen bis 31. März.',
        'Bevollmächtigter in Spanien bereits seit 1.1.2023 für Unternehmen ohne Sitz in Spanien verpflichtend.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Verpact (Übergang – eigenständiges nationales Produzentenregister erst für 2027/2028 vorgesehen)',
        registration_url = 'https://www.verpact.nl',
        requirements_json = ?,
        eco_fee = 'Afvalbeheersbijdrage an Verpact, material- und mengenabhängig.',
        data_status = 'needs_verification'
      WHERE code = 'NL'
    `).run(
      JSON.stringify([
        'Registrierungspflicht bei Verpact derzeit ab 50.000 kg Verpackung/Jahr; diese Schwelle könnte künftig gesenkt werden.',
        'Ein eigenständiges nationales Produzentenregister ist erst für 2027/2028 vorgesehen.',
        'Stand 08/2026 war noch offen, wie die Bevollmächtigten-Pflicht für EU-Händler in den Niederlanden konkret ausgestaltet wird.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'EPRiBEL / Fost Plus',
        registration_url = 'https://www.fostplus.be',
        requirements_json = ?,
        eco_fee = 'Beitrag an Fost Plus (Haushaltsverpackungen) bzw. Valipac (Transport-/B2B-Verpackungen), material- und mengenabhängig.',
        data_status = 'needs_verification'
      WHERE code = 'BE'
    `).run(
      JSON.stringify([
        'Registrierung im nationalen Produzentenregister über EPRiBEL Pflicht für alle Unternehmen, die Verpackungen auf dem belgischen Markt in Verkehr bringen.',
        'Mitglieder von Fost Plus (Haushaltsverpackungen) bzw. Valipac (Transport-/B2B-Verpackungen) lassen die Registrierung meist kollektiv über ihre PRO abwickeln.',
        'Ausländische Unternehmen ohne Sitz in Belgien benötigen seit 12.08.2026 einen bei EPRiBEL registrierten Bevollmächtigten (Vertegenwoordiger voor EPR) in Belgien.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'BDO (Baza Danych o Odpadach)',
        registration_url = 'https://bdo.mos.gov.pl',
        requirements_json = ?,
        eco_fee = 'Recyclingbeitrag über das gewählte Rückgewinnungssystem, material- und mengenabhängig.',
        data_status = 'verified'
      WHERE code = 'PL'
    `).run(
      JSON.stringify([
        'Registrierungspflicht in der BDO-Datenbank (Baza Danych o Odpadach) für jedes Unternehmen, das Verpackungen auf dem polnischen Markt in Verkehr bringt – auch ausländische Fernabsatzhändler.',
        'Jährliche Verpackungsmeldung sowie Einstufung der Recyclingfähigkeit (Klassen A–E) erforderlich.',
        'Bevollmächtigter mit Sitz in Polen (oder einem anderen EU-Land) für Unternehmen ohne Sitz in Polen erforderlich.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Naturvårdsverket + Producentansvarsorganisation (NPA / TMR)',
        registration_url = 'https://www.naturvardsverket.se/vagledning-och-stod/producentansvar/eu-forordningen-om-forpackningar-ppwr/',
        requirements_json = ?,
        eco_fee = 'Beitrag an die gewählte Producentansvarsorganisation (NPA oder TMR), material- und mengenabhängig.',
        data_status = 'verified'
      WHERE code = 'SE'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung bei der schwedischen Umweltbehörde Naturvårdsverket erforderlich.',
        'Anschluss an eine anerkannte Produzentenverantwortungsorganisation, z. B. Näringslivets Producentansvar (NPA) oder Tailor-Made Responsibility (TMR).',
        'Detailliertere neue Meldepflichten gelten voraussichtlich erstmals 2028 für das Berichtsjahr 2027.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Dansk Producentansvar (DPA)',
        registration_url = 'https://producentansvar.dk',
        requirements_json = ?,
        eco_fee = 'Beitrag an Dansk Producentansvar (DPA), material- und mengenabhängig.',
        data_status = 'verified'
      WHERE code = 'DK'
    `).run(
      JSON.stringify([
        'Registrierungspflicht im nationalen Produzentenregister bei Dansk Producentansvar (DPA) für alle Unternehmen, die Verpackungen in Dänemark in Verkehr bringen.',
        'Meldung der erwarteten Verpackungsmengen und -arten sowie Finanzierung der Abfallbewirtschaftung.',
        'Erweiterte Herstellerverantwortung für Verpackungen gilt in Dänemark bereits seit 1.10.2025, ergänzt durch die PPWR-Vorgaben ab 12.08.2026.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Repak',
        registration_url = 'https://www.repak.ie',
        requirements_json = ?,
        eco_fee = 'Lizenzentgelt an Repak, material- und mengenabhängig.',
        data_status = 'verified'
      WHERE code = 'IE'
    `).run(
      JSON.stringify([
        'Registrierung und Systembeteiligung bei Repak, der einzigen staatlich anerkannten Produzentenverantwortungsorganisation für Verpackungen in Irland.',
        'Für ausländische Unternehmen ohne Sitz in Irland ist seit 12.08.2026 ein Bevollmächtigter zwingend – die Schwelle dafür liegt bei Fernabsatzhändlern faktisch bei null.',
        'PRL (Producer Register Limited) ist NICHT für Verpackungen zuständig, sondern für Elektrogeräte/Batterien/Reifen – für Verpackungen ist Repak die richtige Stelle.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Sociedade Ponto Verde (SPV) / SILiAmb (Übergang – eigenständiges nationales Produzentenregister erst für Ende 2027/Anfang 2028 geplant)',
        registration_url = 'https://www.pontoverde.pt/clientes-embaladores/adira-ao-sistema-ponto-verde/',
        requirements_json = ?,
        eco_fee = 'Beitrag an die Sociedade Ponto Verde (SPV), material- und mengenabhängig.',
        data_status = 'needs_verification'
      WHERE code = 'PT'
    `).run(
      JSON.stringify([
        'Stand 08/2026: Meldung und Registrierung laufen über die bestehende Sociedade Ponto Verde (SPV) und die SILiAmb-Plattform der portugiesischen Umweltagentur (APA).',
        'Ein eigenständiges nationales PPWR-Produzentenregister ist erst für Ende 2027/Anfang 2028 vorgesehen.',
        'Meldung der in Verkehr gebrachten Verpackungsmengen erforderlich.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Register / EPR-System'
      WHERE code = 'CH'
    `).run();


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (noch im Aufbau – EU-weiter Durchführungsrechtsakt für das Registrierungsformat war Stand 08/2026 noch in öffentlicher Konsultation)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'GR'
    `).run(
      JSON.stringify([
        'Jährliche Meldung der Verpackungsmengen an das zuständige nationale Register bis zum 1. Juni des Folgejahres vorgesehen.',
        'Der EU-weite Durchführungsrechtsakt, der das einheitliche Format für Produzentenregister und Meldungen festlegt, befand sich Stand 08/2026 noch in öffentlicher Konsultation (6.8.–10.9.2026).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Bestehendes tschechisches EPR-System (PPWR-spezifisches Produzentenregister Stand 08/2026 noch nicht mit konkreter Stelle bestätigt)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'CZ'
    `).run(
      JSON.stringify([
        'PPWR-Pflichten gelten zusätzlich zu den bestehenden tschechischen EPR-Registrierungspflichten – keine Ablösung, sondern Kumulierung.',
        'Ausländische Online-Händler und Plattformen gelten künftig in vielen Fällen selbst als Verpackungs-Inverkehrbringer.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Bestehendes slowakisches EPR-System (u. a. NATUR-PACK); PPWR-spezifisches Produzentenregister Stand 08/2026 noch nicht abschließend bestätigt',
        registration_url = 'https://www.naturpack.sk',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'SK'
    `).run(
      JSON.stringify([
        'Registrierung bei den zuständigen nationalen Behörden für jedes Unternehmen, das Verpackungen in der Slowakei erstmals in Verkehr bringt.',
        'Technische Dokumentation je Verpackungseinheit erforderlich (Materialzusammensetzung, Konformitätsbewertung, verantwortliche Person).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (Durchführungsrechtsakt der EU-Kommission laut Zeitplan bis 12.02.2026 vorgesehen; konkrete ungarische Stelle Stand 08/2026 nicht abschließend bestätigt)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'HU'
    `).run(
      JSON.stringify([
        'Gyártói nyilvántartásba vétel (Produzentenregistrierung) ist seit 12.08.2026 Pflicht für Unternehmen, die Verpackungen in Ungarn in Verkehr bringen.',
        'Konformitätsbewertung und Dokumentation der Verpackung erforderlich.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (Stand 08/2026 laut Fachpresse noch nicht vollständig aufgebaut)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'RO'
    `).run(
      JSON.stringify([
        'Ohne Registrierung im nationalen Produzentenregister dürfen Verpackungen ab 12.08.2026 nicht mehr in Verkehr gebracht werden; Vertreiber und Online-Plattformen müssen den Produzentenstatus prüfen.',
        'Rumänien hatte Stand 08/2026 laut Fachpresse die nationale Registerinfrastruktur noch nicht vollständig aufgebaut.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Suomen Pakkauskierrätys RINKI Oy (Rinki)',
        registration_url = 'https://rinkiin.fi',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'FI'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung der Verpackungsmengen erfolgt in Finnland meist über Rinki (Suomen Pakkauskierrätys RINKI Oy).',
        'EU-weite Stoffverbote (u. a. Schwermetalle, PFAS in Lebensmittelkontakt-Verpackungen) gelten bereits ab 12.08.2026.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Registar proizvođača s proširenom odgovornosti (RPPO)',
        requirements_json = ?,
        data_status = 'verified'
      WHERE code = 'HR'
    `).run(
      JSON.stringify([
        'Seit 2025 existiert das kroatische Register für erweiterte Herstellerverantwortung (RPPO), in dem sich Verpackungs-Inverkehrbringer registrieren müssen.',
        'Registrierungs- und EPR-Pflichten gelten für jeden Mitgliedstaat gesondert, in dem Verpackung erstmals in Verkehr gebracht wird.',
        'Für Kleinstunternehmen mit geringen Verpackungsmengen sind in bestimmten Fällen Erleichterungen vorgesehen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (Stand 08/2026 noch nicht errichtet – EU-Vorgabe sieht Einrichtung binnen 18 Monaten nach dem ersten Durchführungsrechtsakt der Kommission vor)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'SI'
    `).run(
      JSON.stringify([
        'Das slowenische Umweltministerium hat einen Verordnungsentwurf zur Umsetzung des PRO-Systems für Verpackungen vorbereitet; das nationale Register war Stand 08/2026 noch nicht in Betrieb.',
        'PPWR unterscheidet klar zwischen „Hersteller" (Konformität der Verpackung) und „Produzent" (EPR-Pflichten wie Registrierung und Finanzierung der Entsorgung).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Aplinkos apsaugos agentūra (Umweltschutzagentur)',
        registration_url = 'https://aaa.lrv.lt',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'LT'
    `).run(
      JSON.stringify([
        'Registrierungspflicht bei der litauischen Umweltschutzagentur (Aplinkos apsaugos agentūra) für jedes Unternehmen, das Verpackungen erstmals in Litauen in Verkehr bringt.',
        'Ausländische Unternehmen ohne Sitz in Litauen benötigen einen Bevollmächtigten für die erweiterte Herstellerverantwortung (EPR).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Valsts vides dienests (Staatlicher Umweltdienst)',
        registration_url = 'https://www.vvd.gov.lv',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'LV'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung erfolgt über den Staatlichen Umweltdienst (Valsts vides dienests, VVD).',
        'Bestehende lettische Steuer- und EPR-Pflichten (u. a. Verpackungssteuer) werden durch die PPWR nicht automatisch ersetzt, sondern bestehen zusätzlich fort.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Kliimaministeerium (Klimaministerium) – eigenständiges estnisches Produzentenregister voraussichtlich erst um 2028 fertig',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'EE'
    `).run(
      JSON.stringify([
        'Unternehmen müssen sich in jedem Mitgliedstaat registrieren, in dem sie Verpackungen erstmals in Verkehr bringen; ohne gültige Registrierung darf in Estland keine verpackte Ware in Verkehr gebracht werden.',
        'Das eigenständige estnische Produzentenregister wird laut Kliimaministeerium voraussichtlich erst um 2028 fertiggestellt sein.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Ministerium für Umwelt und Wasser – Systembeteiligung z. B. über Ecopak oder andere lizenzierte Organisationen',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'BG'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung bei den vom bulgarischen Umweltministerium lizenzierten Rückgewinnungsorganisationen (z. B. Ecopak) erforderlich.',
        'Konformitätsbewertung, technische Dokumentation und EU-Konformitätserklärung ab 12.08.2026 vorgeschrieben.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Valorlux',
        registration_url = 'https://www.valorlux.lu',
        requirements_json = ?,
        eco_fee = 'Mitgliedsbeitrag an Valorlux (einzige zugelassene Systembetreiberin), material- und mengenabhängig.',
        data_status = 'verified'
      WHERE code = 'LU'
    `).run(
      JSON.stringify([
        'Valorlux ist die einzige zugelassene Systembetreiberin (PRO) für Verpackungen in Luxemburg – Mitgliedschaft ist verpflichtend, eine individuelle Erfüllung ist nicht vorgesehen.',
        'Ausländische Unternehmen ohne Sitz in Luxemburg benötigen seit 12.08.2026 einen dort ansässigen Bevollmächtigten.',
        'Meldung der Verpackungsmengen über das Valorlux-Portal Valbase; für Industrieverpackungen läuft das Meldefenster jährlich von Anfang Januar bis Ende Februar.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (Stand 08/2026 keine konkrete Stelle bestätigt)',
        requirements_json = ?,
        data_status = 'needs_verification'
      WHERE code = 'MT'
    `).run(
      JSON.stringify([
        'Registrierungspflicht in jedem Mitgliedstaat, in dem Verpackungen erstmals in Verkehr gebracht werden – auch in Malta.',
        'Eine spezifische maltesische Zuständigkeitsstelle für die PPWR-Registrierung konnte Stand 08/2026 nicht abschließend bestätigt werden.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Green Dot Cyprus / Department of Environment',
        requirements_json = ?,
        data_status = 'verified'
      WHERE code = 'CY'
    `).run(
      JSON.stringify([
        'Green Dot Cyprus ist seit 2002 das etablierte System für die erweiterte Herstellerverantwortung bei Verpackungen in Zypern; Registrierung zusätzlich beim Department of Environment.',
        'Ausländische Unternehmen ohne Sitz in Zypern benötigen einen Bevollmächtigten in Zypern.'
      ])
    );


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
