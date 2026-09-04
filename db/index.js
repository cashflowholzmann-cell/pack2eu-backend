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

    // Etsy (OAuth 2.0 + PKCE, siehe routes/etsy.js).
    addColumnIfMissing('customers', 'etsy_shop_id', 'TEXT');
    addColumnIfMissing('customers', 'etsy_access_token', 'TEXT');
    addColumnIfMissing('customers', 'etsy_refresh_token', 'TEXT');
    addColumnIfMissing('customers', 'etsy_token_expires_at', 'TEXT');

    // Kaufland (kein OAuth - Kunde hinterlegt eigene API-Zugangsdaten
    // aus seinem Kaufland-Verkäuferkonto, siehe routes/kaufland.js).
    addColumnIfMissing('customers', 'kaufland_client_key', 'TEXT');
    addColumnIfMissing('customers', 'kaufland_secret_key', 'TEXT');

    // Amazon SP-API (Login with Amazon, siehe routes/amazon.js) - Code
    // bereits fertig, wartet auf Amazons Entwickler-/Rollen-Freigabe.
    addColumnIfMissing('customers', 'amazon_selling_partner_id', 'TEXT');
    addColumnIfMissing('customers', 'amazon_refresh_token', 'TEXT');

    // Amazon ist im Gegensatz zu Shopify/Etsy/Kaufland/eBay für uns nicht
    // kostenlos (SP-API-Nutzungsgebühren) - daher ein separat buchbares,
    // kostenpflichtiges Zusatzmodul (Stripe-Abo, siehe routes/billing.js)
    // statt im Starter-Plan inklusive.
    addColumnIfMissing('customers', 'amazon_addon_active', 'INTEGER DEFAULT 0');
    addColumnIfMissing('customers', 'amazon_addon_subscription_id', 'TEXT');

    // Passwort-Reset (siehe routes/auth.js: /forgot-password, /reset-password).
    // Token wird gehasht gespeichert (wie ein Passwort) - der Klartext-Token
    // geht nur per E-Mail raus und steht nie in der Datenbank.
    addColumnIfMissing('customers', 'password_reset_token_hash', 'TEXT');
    addColumnIfMissing('customers', 'password_reset_expires_at', 'TEXT');

    // eBay (OAuth 2.0, siehe routes/ebay.js) - Code bereits fertig,
    // wartet auf eBays Produktions-Freigabe.
    addColumnIfMissing('customers', 'ebay_access_token', 'TEXT');
    addColumnIfMissing('customers', 'ebay_refresh_token', 'TEXT');
    addColumnIfMissing('customers', 'ebay_token_expires_at', 'TEXT');

    // Produkt-Zuordnung für die neuen Marktplätze (gleiches Prinzip wie
    // shopify_product_id/shopify_variant_id): ordnet eine externe
    // Marktplatz-Artikel-ID einem lokal angelegten Produkt zu, damit
    // beim Bestellungs-Sync das richtige Verpackungsgewicht gefunden wird.
    addColumnIfMissing('product_packaging', 'etsy_listing_id', 'TEXT');
    addColumnIfMissing('product_packaging', 'kaufland_product_id', 'TEXT');
    addColumnIfMissing('product_packaging', 'amazon_sku', 'TEXT');
    addColumnIfMissing('product_packaging', 'ebay_item_id', 'TEXT');

    // Herkunfts-Kanal einer manuell angelegten Bestellung (own_shop,
    // shopify, etsy, kaufland, amazon, ebay) - rein zur Zuordnung/
    // Auswertung, keine Sync-Funktion. NULL/fehlend = own_shop (siehe
    // routes/orders.js).
    addColumnIfMissing('orders', 'source_platform', 'TEXT');

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

    // Vom Kunden gewählte Branche (z. B. 'fashion', 'beauty') - steuert nur
    // die vorgeschlagenen Produkt-Presets beim Onboarding, keine feste
    // Kategorisierung. NULL = Nische (noch) nicht gewählt.
    addColumnIfMissing(
      'customers',
      'niche',
      'TEXT'
    );

    // Zeitpunkt, zu dem der Kunde das Erst-Onboarding (Nische + Presets)
    // abgeschlossen oder übersprungen hat. NULL = Onboarding beim nächsten
    // Dashboard-Login noch anzeigen.
    addColumnIfMissing(
      'customers',
      'onboarding_completed_at',
      'TEXT'
    );

    // 'monthly' | 'annual' - siehe Kommentar in schema.sql.
    addColumnIfMissing(
      'customers',
      'billing_interval',
      'TEXT'
    );

    // Gewählte Länder für den Bevollmächtigten-Bonus - siehe Kommentar in
    // schema.sql.
    addColumnIfMissing(
      'customers',
      'rep_entitlement_choices_json',
      'TEXT'
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

    // Nur auf 0 gesetzt, wenn recherchiert bestätigt ist, dass das Land
    // aktuell überhaupt keine Verpackungs-Registrierung/Bevollmächtigung
    // verlangt (z. B. Schweiz, China, Thailand) – nicht gleichzusetzen mit
    // "noch nicht recherchiert" (dafür gibt es data_status).
    addColumnIfMissing(
      'countries',
      'registration_generally_required',
      'INTEGER NOT NULL DEFAULT 1'
    );

    // Wie oft an das Register/System gemeldet werden muss:
    // 'monthly' | 'quarterly' | 'annually' | 'needs_verification'. Bewusst
    // konservativ befüllt - siehe Kommentar in schema.sql.
    addColumnIfMissing(
      'countries',
      'reporting_frequency',
      "TEXT NOT NULL DEFAULT 'needs_verification'"
    );

    // Grobe recherchierte Lizenzentgelt-Sätze je Material in EUR/kg, als
    // JSON-Objekt - siehe Kommentar in schema.sql.
    addColumnIfMissing(
      'countries',
      'eco_fee_rates_json',
      'TEXT'
    );

    // Regel für den nächsten Melde-Stichtag, als JSON-Objekt - siehe
    // Kommentar in schema.sql.
    addColumnIfMissing(
      'countries',
      'next_filing_rule_json',
      'TEXT'
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
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'DE'
    `).run(
      JSON.stringify([
        'Registrierungspflicht im Verpackungsregister LUCID für jedes Unternehmen, das verpackte Ware erstmals in Deutschland in Verkehr bringt – unabhängig von Menge oder Unternehmensgröße.',
        'Systembeteiligung (Lizenzierung) bei einem dualen System für alle mit Ware befüllten Verkaufsverpackungen.',
        'Bevollmächtigter in Deutschland zwingend erforderlich für Unternehmen ohne Sitz in Deutschland, seit 12.08.2026 (VerpackDG/PPWR).',
        'Jährliche Datenmeldung (Mengenmeldung) bei LUCID für das Vorjahr, Frist jeweils 15. Mai.'
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'AT'
    `).run(
      JSON.stringify([
        'Einmalige Registrierung im elektronischen Verpackungsregister (EDM), z. B. über das Unternehmensserviceportal (USP).',
        'Systembeteiligung/Lizenzierung über ein genehmigtes Sammel- und Verwertungssystem wie ARA.',
        'Bevollmächtigter in Österreich bereits vor PPWR für ausländische Erstinverkehrbringer verpflichtend.',
        'Meldefrequenz bei ARA gestaffelt nach erwarteter Jahreslizenzgebühr: jährlich unter 1.500 €, ansonsten quartalsweise, ab 20.000 € monatlich – eine pauschale Frequenz lässt sich ohne Kenntnis der individuellen Mengen nicht angeben.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'CONAI (Übergang – nationales PPWR-Produzentenregister RENAP für Verpackungen noch nicht vollständig aktiv)',
        registration_url = 'https://www.conai.org',
        requirements_json = ?,
        eco_fee = 'CONAI-Umweltbeitrag (Contributo Ambientale CONAI, CAC), materialabhängig gestaffelt.',
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'IT'
    `).run(
      JSON.stringify([
        'Stand 08/2026: Die EPR-Pflichten für Verpackungen laufen weiterhin über CONAI; ein eigenständiges PPWR-Produzentenregister (RENAP) ist für Verpackungen noch nicht vollständig in Betrieb.',
        'Paralleler Weiterbetrieb von CONAI und PPWR-System voraussichtlich bis 11.08.2028 vorgesehen.',
        'Nationale Durchführungsbestimmungen zu Registrierung und Bevollmächtigten werden im Laufe 2026 erwartet – noch nicht final.',
        'Meldefrequenz bei CONAI gestaffelt nach der Höhe des im Vorjahr gemeldeten Umweltbeitrags je Material (jährlich/quartalsweise/monatlich) – eine pauschale Frequenz lässt sich ohne Kenntnis der individuellen Mengen nicht angeben.'
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'SE'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung bei der schwedischen Umweltbehörde Naturvårdsverket erforderlich.',
        'Anschluss an eine anerkannte Produzentenverantwortungsorganisation, z. B. Näringslivets Producentansvar (NPA) oder Tailor-Made Responsibility (TMR).',
        'Detailliertere neue Meldepflichten gelten voraussichtlich erstmals 2028 für das Berichtsjahr 2027.',
        'Meldefrequenz an die PRO gestaffelt nach Jahresgebühr: monatlich über 120.000 SEK, quartalsweise ab ca. 20.000 SEK, jährlich für sehr kleine Vertreiber – eine pauschale Frequenz lässt sich ohne Kenntnis der individuellen Mengen nicht angeben.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Dansk Producentansvar (DPA)',
        registration_url = 'https://producentansvar.dk',
        requirements_json = ?,
        eco_fee = 'Beitrag an Dansk Producentansvar (DPA), material- und mengenabhängig.',
        reporting_frequency = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'DK'
    `).run(
      JSON.stringify([
        'Registrierungspflicht im nationalen Produzentenregister bei Dansk Producentansvar (DPA) für alle Unternehmen, die Verpackungen in Dänemark in Verkehr bringen.',
        'Meldung der erwarteten Verpackungsmengen und -arten sowie Finanzierung der Abfallbewirtschaftung.',
        'Erweiterte Herstellerverantwortung für Verpackungen gilt in Dänemark bereits seit 1.10.2025, ergänzt durch die PPWR-Vorgaben ab 12.08.2026.',
        'Die gesetzliche Meldung an DPA ist grundsätzlich jährlich; Vertreiber ab ca. 8 Tonnen Verpackung/Jahr melden laut gängiger Systempraxis stattdessen monatlich – Quellen sind hier nicht eindeutig, daher keine pauschale Frequenz.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Repak',
        registration_url = 'https://www.repak.ie',
        requirements_json = ?,
        eco_fee = 'Lizenzentgelt an Repak, material- und mengenabhängig.',
        reporting_frequency = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'IE'
    `).run(
      JSON.stringify([
        'Registrierung und Systembeteiligung bei Repak, der einzigen staatlich anerkannten Produzentenverantwortungsorganisation für Verpackungen in Irland.',
        'Für ausländische Unternehmen ohne Sitz in Irland ist seit 12.08.2026 ein Bevollmächtigter zwingend – die Schwelle dafür liegt bei Fernabsatzhändlern faktisch bei null.',
        'PRL (Producer Register Limited) ist NICHT für Verpackungen zuständig, sondern für Elektrogeräte/Batterien/Reifen – für Verpackungen ist Repak die richtige Stelle.',
        'Repak-Mitglieder melden ihre Mengen halbjährlich (H1: Frist 21. August, H2: Frist 21. Februar) – das passt in kein einfaches Monats-/Quartals-/Jahresraster.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Sociedade Ponto Verde (SPV) / SILiAmb (Übergang – eigenständiges nationales Produzentenregister erst für Ende 2027/Anfang 2028 geplant)',
        registration_url = 'https://www.pontoverde.pt/clientes-embaladores/adira-ao-sistema-ponto-verde/',
        requirements_json = ?,
        eco_fee = 'Beitrag an die Sociedade Ponto Verde (SPV), material- und mengenabhängig.',
        reporting_frequency = 'annually',
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
        register_body = 'Kein einheitliches gesetzliches Pflichtsystem – freiwillige Branchenlösungen (z. B. PET-Recycling Schweiz, Swiss Recycle/VetroSwiss für Glas)',
        requirements_json = ?,
        eco_fee = 'Keine gesetzliche Öko-Gebühr; ggf. freiwillige Beiträge an Branchenlösungen.',
        registration_generally_required = 0,
        reporting_frequency = 'not_applicable',
        data_status = 'verified'
      WHERE code = 'CH'
    `).run(
      JSON.stringify([
        'Die EU-Verpackungsverordnung (PPWR) gilt nicht direkt in der Schweiz – Stand 08/2026 gibt es keine gesetzliche Pflicht zur erweiterten Herstellerverantwortung für Verpackungen.',
        'Stattdessen bestehen freiwillige Rücknahme- und Recyclingsysteme je Branche/Material (z. B. PET-Recycling Schweiz, Glas über VetroSwiss/Swiss Recycle).',
        'Schweizer Unternehmen, die in die EU liefern oder direkt an EU-Kunden verkaufen, müssen für diese Lieferungen dennoch die EU-PPWR-Pflichten (inkl. Bevollmächtigter im jeweiligen EU-Zielland) erfüllen – das betrifft das EU-Zielland, nicht die Schweiz selbst.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Kein Bundesgesetz – bislang 7 Bundesstaaten mit eigenen EPR-Gesetzen (CA, CO, ME, MD, MN, OR, WA); Circular Action Alliance (CAA) ist die designierte PRO in CA, CO, MD, OR, WA',
        registration_url = 'https://circularactionalliance.org',
        requirements_json = ?,
        eco_fee = 'Gebühren variieren je Bundesstaat und PRO (z. B. CAA), ab 2027 zunehmend ökomoduliert.',
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'US'
    `).run(
      JSON.stringify([
        'Verpackungs-EPR ist in den USA Sache der Bundesstaaten, nicht bundesweit einheitlich geregelt – Pflichten hängen davon ab, in welche(n) Bundesstaat(en) geliefert wird.',
        'Oregon: Programm seit 1.7.2025 aktiv, Registrierung bei der PRO sowie jährliche Meldung von Mengen und Materialarten erforderlich.',
        'Kalifornien: Registrierung bei CAA oder CalRecycle bis 1.6.2026 Pflicht; Gebührenpflicht ab 2027 vorgesehen.',
        'Weitere Bundesstaaten (Colorado, Maine, Maryland, Minnesota, Washington) folgen mit eigenen Zeitplänen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'PackUK (Scheme Administrator) – Registrierung über den Report-Packaging-Data-Dienst der zuständigen Umweltbehörde (Environment Agency / SEPA / NRW / NIEA)',
        requirements_json = ?,
        eco_fee = 'pEPR-Gebühr an PackUK; Basisgebühr in der Einführungsphase 2025/26, ab 2026/27 nach Recyclingfähigkeit ökomoduliert gestaffelt.',
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'GB'
    `).run(
      JSON.stringify([
        'Registrierungspflicht für Unternehmen mit Jahresumsatz über 1 Mio. £ und mehr als 25 Tonnen Verpackung pro Jahr im UK-Markt.',
        '„Produzent" im Sinne von pEPR ist, wer verpackte Ware erstmals im UK-Markt bereitstellt – das schließt Importeure, Markeninhaber, Fernabsatzhändler und Marktplatzbetreiber ein.',
        'Jährliche Registrierung/Meldung bis 1. April über den Report-Packaging-Data-Dienst bei der zuständigen Umweltbehörde (Environment Agency England, SEPA Schottland, NRW Wales oder NIEA Nordirland).',
        'Basisgebühren gelten ab 2025/26; ab 2026/27 ökomodulierte Gebühren (z. B. 1,2-facher Satz für schwer recycelbare Verpackungen).',
        'Meldefrequenz hängt von der Unternehmensgröße ab: „large producers" (über den o. g. Schwellen) melden halbjährlich (1. Oktober und 1. April), „small producers" darunter nur einmal jährlich im April.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Keine Bundesregelung – provinzweise eigene EPR-Programme (u. a. Ontario, British Columbia); Circular Materials ist ein wichtiger überregionaler PRO-Anbieter',
        registration_url = 'https://circularmaterials.ca',
        requirements_json = ?,
        eco_fee = 'Gebühren variieren je Provinz und PRO.',
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'CA'
    `).run(
      JSON.stringify([
        'Verpackungs-EPR ist in Kanada Provinzsache – Pflichten hängen davon ab, in welche Provinz(en) geliefert wird.',
        'British Columbia: eines der am längsten laufenden Programme (Recycle BC), administriert über Circular Materials; gilt auch für Erstimporteure und E-Commerce-Verkäufer.',
        'Ontario: seit 1.1.2026 vollständig produzentenfinanziert, mit erstmals landesweit standardisierter Materialliste.',
        'Jährliche Meldefrist in den meisten Provinzen: 31. Mai.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Australian Packaging Covenant Organisation (APCO) – Stand 08/2026 überwiegend freiwillig, verbindliches Gesetz („No Time to Waste") noch nicht in Kraft',
        registration_url = 'https://www.apco.org.au',
        requirements_json = ?,
        eco_fee = 'Aktuell freiwillige APCO-Mitgliedsbeiträge; ökomodulierte Pflichtgebühren ab Finanzjahr 2026/27 in Planung.',
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'AU'
    `).run(
      JSON.stringify([
        'APCO-Mitgliedschaft ist Stand 08/2026 weiterhin überwiegend freiwillig; ein Gesetzentwurf für ein verbindliches, nationales EPR-System befand sich im Mai 2026 noch im Ausschuss des australischen Senats.',
        'Verbindliche Pflichten und ökomodulierte Gebühren werden laut Übergangsplan erst für das Finanzjahr 2027 erwartet, mit Fokus auf Unternehmen ab 5 Mio. AUD Jahresumsatz.',
        'Bis zur verbindlichen Regelung empfiehlt sich freiwillige APCO-Mitgliedschaft zur Vorbereitung.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Grønt Punkt Norge (größte zugelassene PRO)',
        registration_url = 'https://www.grontpunkt.no',
        requirements_json = ?,
        eco_fee = 'Mitgliedsbeitrag an die gewählte PRO (z. B. Grønt Punkt Norge), material- und mengenabhängig.',
        representative_provider_name = 'Lizenzero',
        representative_provider_url = 'https://lizenzero.com/en/authorised-representative',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'NO'
    `).run(
      JSON.stringify([
        'Die EU-Verpackungsverordnung (PPWR) gilt in Norwegen erst nach Übernahme in das EWR-Abkommen – die norwegische Umweltbehörde hat bestätigt, dass der Termin 12.08.2026 dafür nicht eingehalten wird.',
        'Bis dahin gilt das bestehende norwegische System: Pflicht zur Mitgliedschaft in einer zugelassenen Produzentenverantwortungsorganisation (PRO), z. B. Grønt Punkt Norge.',
        'Seit 1.7.2025 gibt es keine Bagatellgrenze mehr (vorher 1.000 kg je Material/Jahr) – jede Menge Verpackung auf dem norwegischen Markt löst die Pflicht aus.',
        'Nur Unternehmen mit norwegischer Organisationsnummer können sich direkt registrieren; ausländische Unternehmen benötigen einen Bevollmächtigten in Norwegen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Japan Containers and Packaging Recycling Association (JCPRA) – Registrierung/Gebührenzahlung nach dem japanischen Verpackungsrecyclinggesetz (容器包装リサイクル法)',
        registration_url = 'https://www.jcpra.or.jp',
        requirements_json = ?,
        labeling_json = ?,
        eco_fee = 'Recycling-Beitragsgebühr an die JCPRA, gestaffelt nach Material und Menge.',
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'JP'
    `).run(
      JSON.stringify([
        'Hersteller, Vertreiber und Importeure von "spezifizierten Verpackungen" (Glas, PET-Flaschen, Papier, Kunststoff) müssen ihrer Recyclingpflicht nachkommen – in der Praxis meist durch Auslagerung an die JCPRA gegen Recycling- und Kommunalbeitragsgebühr.',
        'Zum 24.01.2026 traten neue, verschärfte Zertifizierungskriterien in Kraft (u. a. für PET-Flaschen sowie Kosmetik-/Reinigungsmittelverpackungen), die den Materialeinsatz senken und den Rezyklatanteil erhöhen sollen.',
        'Kleinunternehmen unterhalb bestimmter Umsatz-/Mitarbeitergrenzen sind teils von der individuellen Meldepflicht befreit, müssen sich aber ggf. dennoch registrieren – genaue Schwellenwerte für ausländische Fernabsatzhändler waren Stand 08/2026 nicht abschließend bestätigt.'
      ]),
      JSON.stringify([
        'Gesetzliche Kennzeichnungspflicht (Identifikationsmarken) nach dem Ressourcennutzungsgesetz: PETマーク (PET-Flaschen), プラマーク (sonstige Kunststoffverpackungen), 紙マーク (Papierverpackungen), sowie Kennzeichen für Alu- und Stahldosen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Kein einheitliches nationales Pflichtregister für Verpackungen – bislang nur sektorspezifische EPR-Pilotregelung für papierbasierte Getränke-Verbundverpackungen (Solid Waste Law 2020)',
        requirements_json = ?,
        eco_fee = 'Keine allgemeine gesetzliche Öko-Gebühr für Verpackungen; ggf. sektorspezifische Beiträge im Pilotprogramm für Getränke-Verbundverpackungen.',
        registration_generally_required = 0,
        reporting_frequency = 'not_applicable',
        data_status = 'needs_verification'
      WHERE code = 'CN'
    `).run(
      JSON.stringify([
        'Stand 08/2026 existiert keine umfassende, verpflichtende Verpackungs-EPR-Registrierung für (ausländische) Online-Händler in China.',
        'Die einzige konkrete EPR-Pflicht betrifft papierbasierte Getränke-Verbundverpackungen im Rahmen eines seit 2024/2025 laufenden Pilotprogramms nach dem Solid Waste Law von 2020.',
        'Für bestimmte Warengruppen (z. B. Kosmetik, Lebensmittel, Spielzeug) gelten nationale GB-Normen gegen "übermäßige Verpackung" (过度包装) – das sind Produktstandards, keine Registrierungspflicht.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Central Pollution Control Board (CPCB) – zentrales EPR-Portal für Plastikverpackungen',
        registration_url = 'https://eprplastic.cpcb.gov.in/',
        requirements_json = ?,
        eco_fee = 'EPR-Gebühr/Zertifikatspflicht abhängig von Verpackungskategorie und Recyclingzielerreichung.',
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'IN'
    `).run(
      JSON.stringify([
        'Registrierungspflicht auf dem zentralen CPCB-EPR-Portal für "PIBOs" (Producers, Importers, Brand Owners) von Kunststoffverpackungen – Voraussetzung für Inverkehrbringen und jährliche Meldung.',
        'Jährliche Recyclingquoten nach Kategorie: starre (I) und kompostierbare (IV) Verpackungen 60 % (2025/26) steigend auf 70 % (2026/27); flexible (II) und mehrschichtige (III) Verpackungen 40 % steigend auf 50 %.',
        'Die PWM-Änderungsverordnung vom 31.03.2026 hat Zertifikate, Audits und den Umgang mit Zielverfehlungen neu geregelt.',
        'Nichteinhaltung kann zu Umweltausgleichszahlungen (bis 1 Lakh INR pro Tag) sowie zur Blockade der Zollabfertigung für Importeure führen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Noch kein verpflichtendes nationales System – Entwurf des "Sustainable Packaging Act" in Konsultation, verbindliche EPR laut Fahrplan erst ab ca. 2027 erwartet',
        requirements_json = ?,
        registration_generally_required = 0,
        reporting_frequency = 'not_applicable',
        data_status = 'needs_verification'
      WHERE code = 'TH'
    `).run(
      JSON.stringify([
        'Stand 08/2026 gibt es in Thailand keine gesetzliche Pflicht zur erweiterten Herstellerverantwortung für Verpackungen.',
        'Das Pollution Control Department hat im März 2024 einen Entwurf des "Sustainable Packaging Act" zur öffentlichen Konsultation gestellt; laut Non-Plastic-Waste-Management-Fahrplan (Phase II, 2023–2027) wird die Verabschiedung für ca. 2026, die verbindliche Umsetzung ab 2027 erwartet.',
        'TIPMSE (Thailand Institute of Packaging and Recycling Management) betreibt seit Januar 2024 ein freiwilliges EPR-Pilotprojekt mit 10 Kommunen in der Provinz Chonburi.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Úrvinnslusjóður (isländischer Recyclingfonds) – Erhebung der Recyclinggebühr (úrvinnslugjald) über die Steuerbehörde (Skatturinn) beim Import',
        registration_url = 'https://www.urvinnslusjodur.is/framleidendaabyrgd',
        requirements_json = ?,
        eco_fee = 'Úrvinnslugjald (Recyclinggebühr), material- und mengenabhängig, erhoben über den Zoll/Importeur.',
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'IS'
    `).run(
      JSON.stringify([
        'Island ist EWR-Mitglied (nicht EU) – die Herstellerverantwortung für Verpackungen basiert auf dem bestehenden Gesetz Nr. 162/2002 über die Recyclinggebühr, nicht auf einem eigenständigen PPWR-Produzentenregister.',
        'Die Recyclinggebühr wird beim Zoll vom isländischen Importeur erhoben; ein ausländischer Verkäufer ohne eigene Niederlassung in Island erfüllt seine Pflicht in der Praxis über diesen Importeur.',
        'Wer selbst gebührenpflichtig wird, muss sich spätestens 15 Tage vor Aufnahme der Tätigkeit bei der Steuerbehörde (Skatturinn) registrieren.',
        'Ob und wie die EU-PPWR-Fristen (12.08.2026) für Island übernommen werden, war Stand 08/2026 noch nicht abschließend bestätigt.',
        'Wer selbst meldepflichtig ist, meldet zweimonatlich (Frist jeweils der 28. des zweiten Folgemonats) – das passt in kein einfaches Monats-/Quartals-/Jahresraster.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Amt für Umwelt (Office of Environment), Liechtensteinische Landesverwaltung – kein eigenständiges Verpackungsregister bekannt; enge Zoll- und Wirtschaftsunion mit der Schweiz',
        registration_url = 'https://www.llv.li/en/national-administration/office-of-environment',
        requirements_json = ?,
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'LI'
    `).run(
      JSON.stringify([
        'Liechtenstein ist EWR-Mitglied, gleichzeitig aber über den Zollvertrag von 1923 wirtschaftlich eng mit der Schweiz verbunden, die selbst kein gesetzliches Pflichtsystem für Verpackungen kennt.',
        'Stand 08/2026 konnte keine eigenständige, bestätigte Verpackungs-Registrierungspflicht oder -stelle für Liechtenstein identifiziert werden; einige Compliance-Quellen zählen Liechtenstein pauschal zu den EWR-Staaten, für die die PPWR ab 12.08.2026 gilt – das ist jedoch unbestätigt und steht im Widerspruch zur engen Anlehnung an das Schweizer System.',
        'Bis zur Klärung wird empfohlen, die Entwicklung über das Amt für Umwelt zu beobachten, bevor von einer Registrierungspflicht ausgegangen wird.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Nationales Produzentenregister (noch im Aufbau – EU-weiter Durchführungsrechtsakt für das Registrierungsformat war Stand 08/2026 noch in öffentlicher Konsultation)',
        requirements_json = ?,
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'GR'
    `).run(
      JSON.stringify([
        'Jährliche Meldung der Verpackungsmengen an das zuständige nationale Register bis zum 1. Juni des Folgejahres vorgesehen.',
        'Der EU-weite Durchführungsrechtsakt, der das einheitliche Format für Produzentenregister und Meldungen festlegt, befand sich Stand 08/2026 noch in öffentlicher Konsultation (6.8.–10.9.2026).',
        'Zusätzlich melden Mitglieder des bestehenden Systems HERRCO ihre Mengen je nach Vertrag monatlich oder quartalsweise an den Betreiber – eine einheitliche Frequenz gibt es nicht.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Bestehendes tschechisches EPR-System (PPWR-spezifisches Produzentenregister Stand 08/2026 noch nicht mit konkreter Stelle bestätigt)',
        requirements_json = ?,
        reporting_frequency = 'quarterly',
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
        reporting_frequency = 'quarterly',
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
        reporting_frequency = 'quarterly',
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
        reporting_frequency = 'monthly',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'monthly',
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
        reporting_frequency = 'quarterly',
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
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'LT'
    `).run(
      JSON.stringify([
        'Registrierungspflicht bei der litauischen Umweltschutzagentur (Aplinkos apsaugos agentūra) für jedes Unternehmen, das Verpackungen erstmals in Litauen in Verkehr bringt.',
        'Ausländische Unternehmen ohne Sitz in Litauen benötigen einen Bevollmächtigten für die erweiterte Herstellerverantwortung (EPR).',
        'Quellen widersprechen sich zur Meldefrequenz über GPAIS (nur jährlich vs. zusätzlich quartalsweise) – vor verlässlicher Aussage noch zu klären.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Valsts vides dienests (Staatlicher Umweltdienst)',
        registration_url = 'https://www.vvd.gov.lv',
        requirements_json = ?,
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'LV'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung erfolgt über den Staatlichen Umweltdienst (Valsts vides dienests, VVD).',
        'Bestehende lettische Steuer- und EPR-Pflichten (u. a. Verpackungssteuer) werden durch die PPWR nicht automatisch ersetzt, sondern bestehen zusätzlich fort.',
        'Meldefrequenz (monatlich/quartalsweise) hängt vom jeweiligen PRO-Vertrag ab, zusätzlich zu einer jährlichen Zusammenfassung – kein einheitlicher Standard.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Kliimaministeerium (Klimaministerium) – eigenständiges estnisches Produzentenregister voraussichtlich erst um 2028 fertig',
        requirements_json = ?,
        reporting_frequency = 'annually',
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
        reporting_frequency = 'monthly',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'annually',
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
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'CY'
    `).run(
      JSON.stringify([
        'Green Dot Cyprus ist seit 2002 das etablierte System für die erweiterte Herstellerverantwortung bei Verpackungen in Zypern; Registrierung zusätzlich beim Department of Environment.',
        'Ausländische Unternehmen ohne Sitz in Zypern benötigen einen Bevollmächtigten in Zypern.'
      ])
    );


    // ========================================================
    // 5a. GROBE ÖKO-GEBÜHR-SÄTZE JE MATERIAL (EUR/kg)
    //
    // Recherchierte, aber bewusst grobe Näherungswerte aus den jeweils
    // öffentlich einsehbaren Tarifen/Preislisten der nationalen
    // Verpackungsregister/PROs (Stand 09/2026, siehe eco_fee_rates_json-
    // Kommentar in schema.sql). NUR Länder/Materialien mit einer
    // einigermaßen eindeutigen, aktuellen Quelle sind hier gesetzt - bei
    // stark bandbreiten- oder mengenstaffel-abhängigen Sätzen (z. B. sehr
    // große Recyclingfähigkeits-Spannen), strukturell andersartigen
    // Systemen (z. B. Australiens freiwillige Mitgliedsbeiträge, Indiens
    // handelbare EPR-Zertifikate, Polens Straf-Produktabgabe statt echter
    // Lizenzgebühr) oder wenn schlicht keine verlässliche aktuelle Quelle
    // gefunden wurde, bleibt das Land bewusst ohne Satz (NULL) - das
    // Dashboard zeigt dann "Satz noch nicht recherchiert" statt einer
    // irreführenden Zahl. Bei mehreren Teilmaterialien mit stark
    // abweichenden Sätzen (z. B. Stahl vs. Aluminium) wurde jeweils der
    // gebräuchlichere/konservativere Wert für den allgemeinen "metall"-
    // Eintrag gewählt.
    //
    // 09/2026-Nachrecherche (Lücken auffüllen + neue Länder): folgende
    // Fälle blieben bewusst ohne Satz, obwohl recherchiert wurde -
    // NICHT vergessen, sondern aktiv ausgeschlossen:
    // - DE (Metall), FR/LU (Kunststoff): nur stark gestaffelte/
    //   uneinheitliche Tarife bzw. eine einzelne schwache Quelle ohne
    //   verlässlichen Einzelwert gefunden.
    // - DK (Papier): gefundener Wert wich um mehr als das 20-fache vom
    //   ebenfalls recherchierten Karton-Satz ab - zu unplausibel für
    //   einen Aufnahme ohne Zweitquelle.
    // - LV (restliche Materialien): nur eine Quelle von 2020 gefunden,
    //   zu veraltet.
    // - GR: keine feste öffentliche Tarifliste (HERRCo verhandelt
    //   vertraglich, Preis richtet sich nach Sekundärrohstoff-Markt).
    // - LI: hat nach mehreren Quellen aktuell gar kein eigenes
    //   Verpackungs-EPR-System (eng an die Schweizer Zollunion
    //   angebunden).
    // - SI: trotz mehrerer Versuche keine belastbare Zahl gefunden.
    // - IT-Kunststoff (CONAI CAC) steigt laut CONAI zum 01.10.2026 von
    //   0,79 auf 0,922 €/kg - hier bewusst noch der bis dahin gültige
    //   Satz eingetragen, im Q4 2026 aktualisieren.
    // ========================================================

    const ecoFeeRates = {
      DE: { papier: 0.26, karton: 0.26 },
      FR: { papier: 0.2143, karton: 0.2143, glas: 0.0164, metall: 0.0535 },
      IT: { papier: 0.045, karton: 0.045, kunststoff: 0.790, glas: 0.035, metall: 0.005, holz: 0.009 },
      ES: { papier: 0.115, karton: 0.115, kunststoff: 0.285, glas: 0.035 },
      AT: { papier: 0.190, karton: 0.190, kunststoff: 0.990, glas: 0.102, metall: 0.450, holz: 0.020, sonstige: 1.080 },
      NL: { kunststoff: 0.1972, glas: 0.0303, papier: 0.0154, karton: 0.0154, metall: 0.0663 },
      SE: { papier: 0.61, kunststoff: 1.23, glas: 0.26, metall: 1.10 },
      IE: { papier: 0.046, karton: 0.046, kunststoff: 0.17, glas: 0.023, metall: 0.009 },
      PT: { papier: 0.260, karton: 0.260, kunststoff: 0.447, glas: 0.006 },
      HU: { kunststoff: 0.60, papier: 0.474, karton: 0.474, metall: 0.211, glas: 0.293 },
      RO: { papier: 0.108, karton: 0.108, kunststoff: 0.108, metall: 0.108, holz: 0.108 },
      CY: { glas: 0.0276, papier: 0.0448, karton: 0.0448, metall: 0.0906, kunststoff: 0.1006 },
      EE: { glas: 0.120, papier: 0.115, karton: 0.115, kunststoff: 0.460, metall: 0.260 },
      LT: { glas: 0.160, papier: 0.180, karton: 0.180, kunststoff: 0.446, metall: 0.250, holz: 0.070 },
      LU: { glas: 0.0177, papier: 0.0402, karton: 0.0402, metall: 0.0271 },
      SK: { glas: 0.109, papier: 0.109, karton: 0.109, kunststoff: 0.299, metall: 0.110, holz: 0.010 },
      HR: { papier: 0.0498, karton: 0.0498, kunststoff: 0.0995, glas: 0.0199, metall: 0.0544 },
      LV: { metall: 0.099 },
      GB: { karton: 0.530, kunststoff: 0.486, holz: 0.322, metall: 0.298, glas: 0.221 },
      NO: { kunststoff: 0.510 },
      US: { papier: 0.122, karton: 0.122, kunststoff: 0.487 },
      CA: { kunststoff: 0.594, karton: 0.429, metall: 0.429 },
      JP: { kunststoff: 0.397, papier: 0.139, karton: 0.139, glas: 0.069 },
      BE: { papier: 0.150, karton: 0.150, kunststoff: 0.360, glas: 0.105 },
      BG: { papier: 0.0498, karton: 0.0498, kunststoff: 0.0544, metall: 0.0421 },
      CZ: { papier: 0.283, karton: 0.283, kunststoff: 0.626, glas: 0.073, metall: 0.206 },
      DK: { karton: 0.401, kunststoff: 0.692, glas: 0.495, metall: 0.930 },
      FI: { papier: 0.102, karton: 0.102, kunststoff: 0.238, glas: 0.076, metall: 0.030 },
      IS: { papier: 0.462, karton: 0.462, kunststoff: 0.462, glas: 0.178, metall: 0.178 },
      MT: { papier: 0.203, karton: 0.203, kunststoff: 0.205, glas: 0.147, metall: 0.205 }
    };

    const updateEcoFeeRates =
      db.prepare(`UPDATE countries SET eco_fee_rates_json = ? WHERE code = ?`);

    for (const [code, rates] of Object.entries(ecoFeeRates)) {
      updateEcoFeeRates.run(JSON.stringify(rates), code);
    }

    console.log(
      `✅ Öko-Gebühr-Sätze gesetzt: ${Object.keys(ecoFeeRates).length} Länder`
    );


    // ========================================================
    // 5b. NÄCHSTER MELDE-STICHTAG JE LAND
    //
    // NUR gesetzt, wenn ein konkreter Tag/Monat recherchiert bestätigt ist -
    // siehe Kommentar zu next_filing_rule_json in schema.sql. Länder mit
    // bekannter reporting_frequency, aber ohne verlässlich recherchierten
    // exakten Stichtag (z. B. die meisten "annually"-Länder), bleiben
    // bewusst ohne Regel statt eines geratenen Datums.
    // ========================================================

    const nextFilingRules = {
      DE: { type: 'annual', month: 5, day: 15 },
      ES: { type: 'annual', month: 3, day: 31 },
      CA: { type: 'annual', month: 5, day: 31 },
      LU: { type: 'annual', month: 2, day: 28 },
      FR: { type: 'annual', month: 2, day: 28 },
      NL: { type: 'annual', month: 4, day: 1 },
      BE: { type: 'annual', month: 2, day: 28 },
      PT: { type: 'annual', month: 3, day: 31 },
      FI: { type: 'annual', month: 1, day: 31 },
      EE: { type: 'annual', month: 9, day: 1 },
      CZ: { type: 'periodic', period: 'quarter', offsetDays: 30 },
      HU: { type: 'periodic', period: 'quarter', offsetDays: 20 },
      SK: { type: 'periodic', period: 'quarter', offsetDays: 10 },
      RO: { type: 'periodic', period: 'month', offsetDays: 25 },
      BG: { type: 'periodic', period: 'month', offsetDays: 15 },
      HR: { type: 'periodic', period: 'month', offsetDays: 20 }
    };

    const updateNextFilingRule =
      db.prepare(`UPDATE countries SET next_filing_rule_json = ? WHERE code = ?`);

    for (const [code, rule] of Object.entries(nextFilingRules)) {
      updateNextFilingRule.run(JSON.stringify(rule), code);
    }

    console.log(
      `✅ Melde-Stichtag-Regeln gesetzt: ${Object.keys(nextFilingRules).length} Länder`
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

    addColumnIfMissing(
      'product_packaging',
      'icon',
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

    // Etsy PKCE braucht neben "state" auch den code_verifier bis zum
    // Callback - hier zwischengespeichert (kurzlebig, siehe expires_at).
    addColumnIfMissing('oauth_states', 'code_verifier', 'TEXT');


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
      'customer_package_sizes',
      'shopify_orders',
      'marketplace_orders',
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

    // ========================================================
    // VERTRIEB/MARKETING: TRAFFIC, LEADS, AUFGABEN
    //
    // Eigenständiger Bereich fürs interne Admin-Tool (routes/admin.js) -
    // page_views für anonymes Traffic-Tracking (kein Cookie-Consent
    // nötig, da keine personenbezogene Zuordnung stattfindet), leads
    // für Interessenten unabhängig vom Registrierungs-Flow (z. B.
    // Telefonanrufe), tasks für einfache Vertriebs-Aufgaben.
    // ========================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        referrer TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);`);

    // Klick-Events fürs Funnel-Tracking (siehe routes/track.js,
    // POST /track/event) - erfasst gezielt "Demo gestartet" und
    // "Rechner geöffnet" pro anonymer Session-ID, damit sich im
    // internen Tool auswerten lässt, über welchen Einstiegspunkt
    // später tatsächlich ein Abo abgeschlossen wurde (siehe
    // customers.acquisition_session_id + GET /admin/funnel-attribution).
    db.exec(`
      CREATE TABLE IF NOT EXISTS click_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_click_events_session_id ON click_events(session_id);`);

    // Numerischer Zusatzwert für Events, die mehr als nur "ist passiert"
    // transportieren - aktuell nur 'demo_duration' (Sekunden, die die
    // Demo im Dashboard offen war, siehe dashboard.html + routes/track.js).
    addColumnIfMissing('click_events', 'event_value', 'INTEGER');

    // Anonyme Rechner-Nutzung: welche Länder/Mengen wurden im Eco-Fee-
    // Rechner (Landing Page) tatsächlich durchgerechnet und welcher Plan
    // kam raus - hilft zu sehen, wonach am meisten gesucht wird, ohne
    // personenbezogene Daten (nur die anonyme Session-ID, siehe auch
    // click_events/page_views).
    db.exec(`
      CREATE TABLE IF NOT EXISTS calculator_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        countries_json TEXT NOT NULL,
        country_count INTEGER NOT NULL,
        total_kg REAL NOT NULL,
        plan TEXT,
        savings REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_calculator_usage_created_at ON calculator_usage(created_at);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contact TEXT,
        source TEXT NOT NULL DEFAULT 'other',
        status TEXT NOT NULL DEFAULT 'new',
        notes TEXT,
        customer_id INTEGER REFERENCES customers(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        related_lead_id INTEGER REFERENCES leads(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Herkunft eines Kunden (woher kam der Lead, der zum Kunden wurde) -
    // wird bei der Registrierung aus UTM-Parametern/Referrer befüllt,
    // bleibt sonst NULL ("organisch"/unbekannt).
    addColumnIfMissing('customers', 'acquisition_source', 'TEXT');

    // Anonyme Session-ID (dieselbe wie in page_views/click_events) zum
    // Zeitpunkt der Registrierung - erlaubt im internen Tool die
    // Zuordnung "kam über Demo-Klick" / "kam über Rechner-Klick" / "weder"
    // für diesen Kunden (siehe GET /admin/funnel-attribution).
    addColumnIfMissing('customers', 'acquisition_session_id', 'TEXT');

    // Zeitpunkt der Abo-Kündigung (siehe routes/billing.js,
    // customer.subscription.deleted-Webhook) - ohne diesen Zeitstempel
    // lässt sich ein gekündigter Kunde nicht von einem unterscheiden, der
    // nie zahlender Kunde war, und eine Churn-Rate wäre nicht berechenbar.
    // Wichtig fürs interne Tool (Umsatz-/Kennzahlenauswertung) und für
    // eine spätere Due-Diligence bei einem Verkauf von Pack2EU.
    addColumnIfMissing('customers', 'cancelled_at', 'TEXT');

    // Zwischengespeichertes Ergebnis der KI-Themenanalyse (siehe
    // routes/admin.js, POST /topics/analyze) - läuft nicht bei jedem
    // Seitenaufruf automatisch, sondern nur auf Knopfdruck im internen
    // Tool, damit nicht bei jedem Öffnen unnötig API-Kosten anfallen.
    db.exec(`
      CREATE TABLE IF NOT EXISTS topic_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        results_json TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Rechtsänderungs-Radar (siehe legal-watch.js) - KI-gestützte
    // Web-Recherche pro Land, die NIE automatisch die echte
    // Kunden-Datenbank (Tabelle "countries") überschreibt, sondern hier
    // erstmal als Fund landet. Erst wenn ein Mensch im internen Tool
    // "Übernehmen" klickt, fließen die vorgeschlagenen Werte in
    // "countries" ein - wir sind bewusst kein Rechtsberater und wollen
    // nie ungeprüft eine KI-Aussage als geprüfte Rechtsauskunft
    // ausgeben.
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_watch_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        country_code TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        has_update INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        ai_confidence TEXT,
        suggested_fields_json TEXT,
        sources_json TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        reviewed_at TEXT,
        reviewed_by TEXT
      );
    `);

    // Ein Zeileneintrag pro Kalendertag, an dem der tägliche
    // Rechtsänderungs-Radar-Lauf (siehe runDailyLegalWatch in
    // server.js) tatsächlich durchgelaufen ist - verhindert doppelte
    // Läufe am selben Tag nach einem Server-Neustart, ohne einen
    // externen Scheduler zu brauchen.
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_watch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_date TEXT NOT NULL UNIQUE,
        ran_at TEXT NOT NULL DEFAULT (datetime('now')),
        countries_checked INTEGER NOT NULL DEFAULT 0
      );
    `);

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
  init,
  DB_PATH
};
