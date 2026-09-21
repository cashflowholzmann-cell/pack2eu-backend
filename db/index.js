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


// customer_representative_requests ist brandneu (erst in dieser Sitzung
// gemergt) und hat praktisch keine echten Produktionsdaten - deshalb hier
// ausnahmsweise ein echter Tabellen-Rebuild statt nur additiver Spalten,
// um den UNIQUE-Constraint um stream zu erweitern (sonst würden sich eine
// Verpackungs- und eine WEEE-Anfrage für dasselbe Land gegenseitig
// überschreiben). Bei activations/compliance_cases (Jahre an echten
// Kundendaten) wird das bewusst NICHT gemacht, siehe Kommentar dort.
function migrateCustomerRepresentativeRequestsStreamUnique() {
  if (!tableExists('customer_representative_requests')) return;
  if (!columnExists('customer_representative_requests', 'stream')) return;

  const currentSql = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_representative_requests'
  `).get()?.sql || '';

  if (currentSql.includes('UNIQUE(customer_id, country_code, stream)')) return;

  db.exec(`
    CREATE TABLE customer_representative_requests_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      country_code TEXT NOT NULL REFERENCES countries(code),
      stream TEXT NOT NULL DEFAULT 'packaging',
      requested_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'rejected')),
      representative_id INTEGER REFERENCES representatives(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(customer_id, country_code, stream)
    );

    INSERT INTO customer_representative_requests_new
      (id, customer_id, country_code, stream, requested_email, status, representative_id, created_at, updated_at)
    SELECT id, customer_id, country_code, stream, requested_email, status, representative_id, created_at, updated_at
    FROM customer_representative_requests;

    DROP TABLE customer_representative_requests;
    ALTER TABLE customer_representative_requests_new RENAME TO customer_representative_requests;
  `);

  console.log('✅ customer_representative_requests: UNIQUE-Constraint um stream erweitert');
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

    // GPSR-Verantwortliche Person (Villa Elegance SRL, stream='gpsr' in
    // representatives) - separat zugekauft für Kunden, die sie nicht
    // schon über ihren Plan inklusive haben (siehe hasGpsrAccess() in
    // config/plans.js). Gleiche Struktur wie beim Amazon-Zusatzmodul.
    addColumnIfMissing('customers', 'gpsr_addon_active', 'INTEGER DEFAULT 0');
    addColumnIfMissing('customers', 'gpsr_addon_subscription_id', 'TEXT');

    // Postadresse/Telefon der Verantwortlichen Person - Pflichtangabe,
    // die laut Art. 16 GPSR auf dem Produkt/der Verpackung stehen muss.
    // Bisher gab es dafür kein Feld (representatives.company reicht für
    // die Verpackungs-Bevollmächtigten, aber nicht für die vollständige
    // GPSR-Pflichtangabe).
    addColumnIfMissing('representatives', 'address', 'TEXT');
    addColumnIfMissing('representatives', 'phone', 'TEXT');

    // Passwort-Reset (siehe routes/auth.js: /forgot-password, /reset-password).
    // Token wird gehasht gespeichert (wie ein Passwort) - der Klartext-Token
    // geht nur per E-Mail raus und steht nie in der Datenbank.
    addColumnIfMissing('customers', 'password_reset_token_hash', 'TEXT');
    addColumnIfMissing('customers', 'password_reset_expires_at', 'TEXT');

    // Bevollmächtigte: kein Self-Service-Signup mehr (siehe
    // routes/representatives.js) - nur Admin-Einladung per Token
    // (invite_*, wie beim Passwort-Reset gehasht gespeichert) + Login mit
    // E-Mail-Code als zweitem Faktor (login_code_*). password_hash bleibt
    // bis zur Einladungs-Annahme NULL.
    addColumnIfMissing('representatives', 'invite_token_hash', 'TEXT');
    addColumnIfMissing('representatives', 'invite_expires_at', 'TEXT');
    addColumnIfMissing('representatives', 'email_verified_at', 'TEXT');
    addColumnIfMissing('representatives', 'login_code_hash', 'TEXT');
    addColumnIfMissing('representatives', 'login_code_expires_at', 'TEXT');
    addColumnIfMissing('representatives', 'last_login_at', 'TEXT');

    // Ein Bevollmächtigten-Account deckt genau einen Pflichtenstrom pro
    // Land ab (nicht automatisch alle) - eine Kanzlei, die sowohl
    // Verpackung als auch WEEE für ein Land anbietet, bekommt zwei
    // getrennte Accounts. Additiv, default 'packaging' - keine
    // Verhaltensänderung für die bereits eingeladenen Bestands-Reps.
    addColumnIfMissing('representatives', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");
    addColumnIfMissing('customer_representative_requests', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");
    migrateCustomerRepresentativeRequestsStreamUnique();

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

    // WEEE-/Batterie-Klassifizierung je Produkt (siehe routes/skus.js) -
    // ohne diese Angaben kann das System nicht wissen, ob eine SKU
    // überhaupt WEEE- oder Batteriepflichten auslöst. weee_category/
    // battery_type referenzieren weee_categories.code/battery_categories.code,
    // bleiben aber bewusst freies TEXT statt FK (SQLite-ALTER-TABLE-
    // Beschränkung + einfachere Migration).
    addColumnIfMissing('product_packaging', 'is_electrical_equipment', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('product_packaging', 'weee_category', 'TEXT');
    addColumnIfMissing('product_packaging', 'contains_battery', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('product_packaging', 'battery_type', 'TEXT');

    // Optionale Stückzahl-Schätzung für den Material-Spar-Rechner (siehe
    // lib/material-savings.js) - ohne sie zeigt der Rechner nur die
    // Ersparnis pro Stück, keine Jahressumme.
    addColumnIfMissing('product_packaging', 'estimated_annual_units', 'INTEGER');

    // Stream-Dimension (siehe country_stream_rules-Kommentar in
    // schema.sql): additiv, default 'packaging' - keine Verhaltensänderung
    // für die bestehenden, ausschließlich Verpackungs-Aktivierungen aller
    // heutigen Kunden. Der bestehende UNIQUE(customer_id, country_code)
    // bleibt bewusst unverändert (siehe Kommentar oben) - ein Kunde kann
    // aktuell weiterhin nur eine Aktivierung pro Land haben; echte
    // Mehrfach-Stream-Aktivierung pro Land folgt erst mit einer eigenen,
    // sorgfältig getesteten Constraint-Migration, sobald WEEE/Batterie
    // tatsächlich Länderdaten haben.
    addColumnIfMissing('activations', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");
    addColumnIfMissing('compliance_cases', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");
    addColumnIfMissing('monthly_reports', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");
    // compliance_rules existiert erst ab Abschnitt 7 weiter unten - die
    // stream-Spalte dafür steht bei den anderen addColumnIfMissing-Aufrufen
    // dieser Tabelle.

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

    // Abgehakte Punkte der Schweiz→Österreich-Checkliste (siehe
    // lib/ch-at-checklist.js) - JSON-Objekt {itemId: true}. Nur für
    // Kunden mit origin_country='CH' im Dashboard sichtbar/relevant,
    // aber bewusst kein eigenes Flag dafür - die Spalte bleibt für jeden
    // Kunden einfach ungenutzt (NULL), wenn nicht zutreffend.
    addColumnIfMissing(
      'customers',
      'ch_at_checklist_json',
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

    // Kontakt-E-Mail des recherchierten Bevollmächtigten-Kandidaten je
    // Land - getrennt von representative_provider_name/url, weil sie
    // manuell im Admin-Dashboard gepflegt wird (siehe routes/admin.js,
    // POST /countries/:code/invite-representative): erst wenn hier eine
    // echte E-Mail hinterlegt ist, kann der Kandidat per Klick in einen
    // echten representatives-Account (mit Login/2FA) eingeladen werden.
    addColumnIfMissing(
      'countries',
      'representative_provider_email',
      'TEXT'
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
        representative_provider_name = 'get-e-right Austria GmbH',
        representative_provider_url = 'https://www.get-e-right.at/en/authorised-representative-packaging/',
        representative_data_status = 'needs_verification',
        notary_required = 1,
        reporting_frequency = 'needs_verification',
        data_status = 'verified'
      WHERE code = 'AT'
    `).run(
      JSON.stringify([
        'Einmalige Registrierung im elektronischen Verpackungsregister (EDM), z. B. über das Unternehmensserviceportal (USP).',
        'Systembeteiligung/Lizenzierung über ein genehmigtes Sammel- und Verwertungssystem wie ARA.',
        'Bevollmächtigter in Österreich bereits vor PPWR für ausländische Erstinverkehrbringer verpflichtend - seit 1.1.2023 auch für Direktversand-/Fernabsatzhändler ohne Sitz/Niederlassung in Österreich, KEINE Bagatellgrenze (gilt schon ab dem ersten Paket).',
        'Die Vollmacht für den Bevollmächtigten muss notariell beglaubigt werden (Unterschriftsbeglaubigung durch einen Notar, auf Deutsch oder Englisch möglich) - verursacht zusätzliche einmalige Kosten und Vorlaufzeit, die bei der Kostenschätzung eingeplant werden sollten (Quelle: it-recht-kanzlei.de, IHK, deutsche-recycling.de, Stand 09/2026 per KI-Recherche, mehrere unabhängige Quellen übereinstimmend, nicht anwaltlich geprüft).',
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
        representative_provider_name = 'econ Consulting (Dr. Egon Prenn)',
        representative_provider_url = 'https://www.econ.bz.it/dienstleistungen/',
        representative_data_status = 'needs_verification',
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
        representative_provider_name = 'CostManagement B.V.',
        representative_provider_url = 'https://costmanagement.nl/en/help-with-dutch-ppwr/authorized-representative-for-ppwr-compliance/',
        representative_data_status = 'needs_verification',
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
        'Ausländische Unternehmen ohne Sitz in Belgien benötigen seit 12.08.2026 einen bei EPRiBEL registrierten Bevollmächtigten (Vertegenwoordiger voor EPR) in Belgien.',
        'Materialmeldung nach Kunststoff-Subtyp erforderlich, ähnlich Italien/CONAI: Fost Plus unterscheidet in seinen Lizenzentgelt-Tarifen u. a. formstabiles PP, formstabiles PE, flexible Verpackung ≥95% PE/PP sowie Verbundkategorien wie PET/PE – keine pauschale "Kunststoff"-Sammelkategorie (Quelle: fostplus.be, Stand 09/2026 per KI-Recherche, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'BDO (Baza Danych o Odpadach)',
        registration_url = 'https://bdo.mos.gov.pl',
        requirements_json = ?,
        eco_fee = 'Recyclingbeitrag über das gewählte Rückgewinnungssystem, material- und mengenabhängig.',
        representative_provider_name = 'Olimp Marketplace',
        representative_provider_url = 'https://olimpmarketplace.com/de/index.php/obowiazki-srodowiskowe-i-epr-rop-w-krajach-ue-polska-niemcy-czechy-slowacja/',
        representative_data_status = 'needs_verification',
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
        'Meldefrequenz an die PRO gestaffelt nach Jahresgebühr: monatlich über 120.000 SEK, quartalsweise ab ca. 20.000 SEK, jährlich für sehr kleine Vertreiber – eine pauschale Frequenz lässt sich ohne Kenntnis der individuellen Mengen nicht angeben.',
        'Materialmeldung vermutlich NICHT nach Kunststoff-Subtyp wie in Italien/CONAI: NPA-Tarife unterscheiden zwar "formstabiler Kunststoff" von anderem Kunststoff und gewähren Boni für unpigmentierte Monomaterialien (z. B. reines PP/PE), das wirkt aber eher wie eine Recycling-Bonus-Regelung innerhalb einer Kunststoff-Kategorie als eine echte Polymer-Aufschlüsselungspflicht (Quelle: naturvardsverket.se, Stand 09/2026 per KI-Recherche, mittlere Sicherheit, nicht anwaltlich geprüft).',
        'Aktuelles schwedisches Recht verlangt Stand 09/2026 noch keinen Bevollmächtigten für Verpackungen – das könnte sich mit der PPWR-Umsetzung ändern; ein pan-europäischer Anbieter (EUROMANDAT) wirbt bereits mit Schweden-Abdeckung, ohne dass dies unabhängig bestätigt werden konnte.'
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
        'Die gesetzliche Meldung an DPA ist grundsätzlich jährlich; Vertreiber ab ca. 8 Tonnen Verpackung/Jahr melden laut gängiger Systempraxis stattdessen monatlich – Quellen sind hier nicht eindeutig, daher keine pauschale Frequenz.',
        'Materialmeldung teilweise granular: seit 2025 wird Kunststoff bei DPA in 4 Kategorien unterteilt (formstabil, flexibel, formstabiles PET, Schaumstoff) – PET wird also einzeln ausgewiesen, aber keine vollständige CONAI-Aufschlüsselung (PE/PP/PS/PVC getrennt). Volle verpflichtende Materialkategorie-Meldung erst ab 1.1.2027 vorgesehen (Quelle: recyda.com/producentansvar.dk, Stand 09/2026 per KI-Recherche, mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Repak',
        registration_url = 'https://www.repak.ie',
        requirements_json = ?,
        eco_fee = 'Lizenzentgelt an Repak, material- und mengenabhängig.',
        representative_provider_name = 'ERP Ireland (European Recycling Platform)',
        representative_provider_url = 'https://erp-recycling.org/ie/',
        representative_data_status = 'needs_verification',
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
        representative_provider_name = 'Portugal-AR',
        representative_provider_url = 'https://www.portugal-ar.com/en/company',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'PT'
    `).run(
      JSON.stringify([
        'Stand 08/2026: Meldung und Registrierung laufen über die bestehende Sociedade Ponto Verde (SPV) und die SILiAmb-Plattform der portugiesischen Umweltagentur (APA).',
        'Ein eigenständiges nationales PPWR-Produzentenregister ist erst für Ende 2027/Anfang 2028 vorgesehen.',
        'Meldung der in Verkehr gebrachten Verpackungsmengen erforderlich.',
        'Materialmeldung nach Kunststoff-Subtyp erforderlich, wie in Italien/CONAI: seit 1.1.2020 muss in Portugals Verpackungsmeldung der konkrete Kunststofftyp angegeben werden – PET, PEAD (HDPE), PEBD (LDPE), PP, EPS oder "sonstiger Kunststofftyp" –, keine pauschale "Kunststoff"-Kategorie (Quelle: APA SILiAmb-FAQ, Stand 09/2026 per KI-Recherche, hohe Sicherheit unter den recherchierten Ländern, aber nicht anwaltlich geprüft).',
        'Bewusst KEIN Großanbieter (Interzero/Landbell/ERP) als Bevollmächtigten-Kandidat: Portugal-AR (portugal-ar.com) ist laut Selbstauskunft ein reiner Portugal-Spezialist, unabhängig von Compliance-Systemen/Recyclern, seit 12+ Jahren aktiv (ehem. ANREEE-Register) - passt zur gewünschten Boutique-Strategie. Nicht direkt verifiziert (Seite war per WebFetch nicht abrufbar), vor Kontaktaufnahme selbst prüfen.'
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
        representative_provider_name = 'JTI Ventures',
        representative_provider_url = 'https://jtiventures.se/guide-weee-epr-compliance.html',
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
        register_body = 'EMPA (Εθνικό Μητρώο Παραγωγών / Nationales Produzentenregister) über EOAN; Systembeteiligung über HERRCO',
        registration_url = 'http://empa.eoan.gr',
        requirements_json = ?,
        reporting_frequency = 'needs_verification',
        data_status = 'needs_verification'
      WHERE code = 'GR'
    `).run(
      JSON.stringify([
        'Jährliche Meldung der Verpackungsmengen an das zuständige nationale Register bis zum 1. Juni des Folgejahres vorgesehen.',
        'Der EU-weite Durchführungsrechtsakt, der das einheitliche Format für Produzentenregister und Meldungen festlegt, befand sich Stand 08/2026 noch in öffentlicher Konsultation (6.8.–10.9.2026).',
        'Zusätzlich melden Mitglieder des bestehenden Systems HERRCO ihre Mengen je nach Vertrag monatlich oder quartalsweise an den Betreiber – eine einheitliche Frequenz gibt es nicht.',
        'Materialmeldung nach Kunststoff-Subtyp erforderlich, ähnlich Italien/CONAI: HERRCO unterscheidet PET, HDPE, Mischkunststoffe und PE-Folie als eigene Kategorien, mit Zuschlägen für gefärbtes PET, Mehrschicht-Verpackung, PVC und EPS (Quelle: herrco.gr, Stand 09/2026 per KI-Recherche, mittlere bis hohe Sicherheit, nicht anwaltlich geprüft).',
        'Bewusst KEIN Bevollmächtigten-Kandidat hinterlegt: eine gezielte Suche nach kleinen, unabhängigen Alternativen zu Interzero ergab für Griechenland keinen belastbaren Treffer - nur der große Konsolidierer selbst, der nicht als Kandidat gepflegt werden soll, die Marktbeherrscherin HERRCO (kein Bevollmächtigter-Dienstleister, sondern die PRO selbst) und pan-europäische Compliance-Plattformen. Einziger schwacher Hinweis: die Athener Kanzlei Dryllerakis & Associates hat einen Umweltrechts-Fachbereich, bietet aber laut Recherche keine bestätigte Bevollmächtigten-Dienstleistung für Verpackungen an - vor Kontaktaufnahme direkt verifizieren.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Ministerstvo životního prostředí (MŽP) / "Seznam osob"; Systembeteiligung über EKO-KOM, a.s. (PPWR-spezifisches Produzentenregister Stand 08/2026 noch nicht mit konkreter Stelle bestätigt)',
        requirements_json = ?,
        representative_provider_name = 'AuthoriseMe (Circular Pro)',
        representative_provider_url = 'https://circular-pro.com/product/authoriseme-for-czech-republic/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'quarterly',
        data_status = 'needs_verification'
      WHERE code = 'CZ'
    `).run(
      JSON.stringify([
        'PPWR-Pflichten gelten zusätzlich zu den bestehenden tschechischen EPR-Registrierungspflichten – keine Ablösung, sondern Kumulierung.',
        'Ausländische Online-Händler und Plattformen gelten künftig in vielen Fällen selbst als Verpackungs-Inverkehrbringer.',
        'Materialmeldung vermutlich granular wie in Italien/CONAI: EKO-KOMs Quartalsberichte sollen Kunststoff u. a. nach PET, PE, PP und XPS getrennt ausweisen – konnte nicht an der Primärquelle verifiziert werden (Quelle: ekokom.cz-Berichtsmethodik laut Suchergebnis-Zusammenfassung, Stand 09/2026, mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Ministerstvo životného prostredia SR (MŽP SR) – Register výrobcov vyhradených výrobkov (RVVV) über ISOH-Portal; Systembeteiligung u. a. über NATUR-PACK (PPWR-spezifisches Produzentenregister Stand 08/2026 noch nicht abschließend bestätigt)',
        registration_url = 'https://www.isoh.gov.sk/uvod/registre.html',
        requirements_json = ?,
        representative_provider_name = 'NATUR-PACK, a.s.',
        representative_provider_url = 'https://www.naturpack.sk/en/news/authorized-representative-for-extended-producer-responsibility-epr/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'quarterly',
        data_status = 'needs_verification'
      WHERE code = 'SK'
    `).run(
      JSON.stringify([
        'Registrierung bei den zuständigen nationalen Behörden für jedes Unternehmen, das Verpackungen in der Slowakei erstmals in Verkehr bringt.',
        'Technische Dokumentation je Verpackungseinheit erforderlich (Materialzusammensetzung, Konformitätsbewertung, verantwortliche Person).',
        'Materialmeldung vermutlich NICHT nach Kunststoff-Subtyp wie in Italien/CONAI: Meldung erfolgt nach Materialart und Gewicht, mit Recyclingfähigkeits-Boni seit 2023, aber keine bestätigte Aufschlüsselung nach einzelnen Polymeren (Quelle: KI-Recherche Stand 09/2026, niedrige bis mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'OKIR (Országos Környezetvédelmi Információs Rendszer) / MOHU (staatliche EPR-Konzessionärin) (konkrete PPWR-Zuständigkeit Stand 08/2026 nicht abschließend bestätigt, Namen ändern sich in Ungarn häufig)',
        registration_url = 'https://web.okir.hu/en/',
        requirements_json = ?,
        representative_provider_name = 'Eldris',
        representative_provider_url = 'https://epr.eldris.ai/epr-registration-hungary/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'quarterly',
        data_status = 'needs_verification'
      WHERE code = 'HU'
    `).run(
      JSON.stringify([
        'Gyártói nyilvántartásba vétel (Produzentenregistrierung) ist seit 12.08.2026 Pflicht für Unternehmen, die Verpackungen in Ungarn in Verkehr bringen.',
        'Konformitätsbewertung und Dokumentation der Verpackung erforderlich.',
        'Materialklassifizierung wirkt granularer als in den meisten anderen recherchierten Ländern: jede Verpackung muss mit einem 8-stelligen "KF"-Produktcode klassifiziert werden, der Kunststoff u. a. in PET, PP, PS, LDPE, HDPE unterteilt – auch wenn der Gebührensatz selbst laut denselben Quellen aktuell pauschal pro Materialart (nicht pro Polymer) berechnet wird. Für unser Datenmodell relevant: Ungarn braucht vermutlich Polymer-Granularität bei der Klassifizierung, auch wenn (noch) nicht bei der Gebühr (Quelle: eprhungary.com, Stand 09/2026 per KI-Recherche, mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Administrația Fondului pentru Mediu (AFM) – aktuell zuständige Stelle; welche Behörde langfristig das PPWR-Produzentenregister führt, war laut Quellen Stand 09/2026 noch nicht abschließend geklärt',
        registration_url = 'https://www.afm.ro',
        requirements_json = ?,
        reporting_frequency = 'monthly',
        data_status = 'needs_verification'
      WHERE code = 'RO'
    `).run(
      JSON.stringify([
        'Ohne Registrierung im nationalen Produzentenregister dürfen Verpackungen ab 12.08.2026 nicht mehr in Verkehr gebracht werden; Vertreiber und Online-Plattformen müssen den Produzentenstatus prüfen.',
        'Rumänien hatte Stand 08/2026 laut Fachpresse die nationale Registerinfrastruktur noch nicht vollständig aufgebaut.',
        'Kein Bevollmächtigten-Mechanismus im aktuellen rumänischen Verpackungsrecht dokumentiert; ausländische Anbieter erfüllen ihre Pflichten meist über eine lizenzierte Rückgewinnungsorganisation (OIREP, z. B. Eco-Rom Ambalaje SA) statt über einen klassischen Bevollmächtigten – kein konkreter Anbieter für die Bevollmächtigten-Rolle bestätigt.',
        'Materialgranularität unklar: AFM-Meldeformular (Anordnung 591/2017, Anhang 2) erwähnt in manchen Zusammenfassungen "PET" explizit, die vollständige Materialcode-Tabelle konnte aber nicht direkt eingesehen werden (Quelle: KI-Recherche Stand 09/2026, niedrige Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'LVV (Lupa- ja valvontavirasto) – Tuottajarekisteri (seit 1.1.2026 zuständig, vorher Pirkanmaa ELY-Zentrum); Systembeteiligung über Suomen Pakkaustuottajat Oy (SPT) / Rinki',
        registration_url = 'https://rinkiin.fi',
        requirements_json = ?,
        representative_provider_name = 'Elker Oy',
        representative_provider_url = 'https://elker.fi/en/authorized-representative/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'FI'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung der Verpackungsmengen erfolgt in Finnland meist über Rinki (Suomen Pakkauskierrätys RINKI Oy).',
        'EU-weite Stoffverbote (u. a. Schwermetalle, PFAS in Lebensmittelkontakt-Verpackungen) gelten bereits ab 12.08.2026.',
        'Materialmeldung vermutlich granular: Rinki-Gebühren werden laut mehreren Quellen materialspezifisch bis auf Kilogramm-Ebene berechnet unter Nennung anerkannter Kunststoffarten (PET, HDPE, PVC, LDPE, PP) – konnte nicht direkt an Rinkis offizieller Preisliste verifiziert werden (Quelle: KI-Recherche Stand 09/2026, mittlere Sicherheit, nicht anwaltlich geprüft).',
        'Bewusst KEIN Großanbieter (ERP/Interzero/Landbell) als Kandidat: Elker Oy gehört laut Recherche drei kleinen finnischen Produzentenverantwortungs-Organisationen (ICT-tuottajaosuuskunta TY, SELT ry, FLIP ry) und ist nur nordisch tätig (über "Nordic PRO Solutions"), kein europaweiter Konzern - passt zur gewünschten Boutique-Strategie. Nicht direkt verifiziert, vor Kontaktaufnahme selbst prüfen.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Registar proizvođača s proširenom odgovornosti (RPPO) über FZOEU',
        registration_url = 'https://rppo.fzoeu.hr',
        requirements_json = ?,
        reporting_frequency = 'monthly',
        data_status = 'verified'
      WHERE code = 'HR'
    `).run(
      JSON.stringify([
        'Seit 2025 existiert das kroatische Register für erweiterte Herstellerverantwortung (RPPO), in dem sich Verpackungs-Inverkehrbringer registrieren müssen.',
        'Registrierungs- und EPR-Pflichten gelten für jeden Mitgliedstaat gesondert, in dem Verpackung erstmals in Verkehr gebracht wird.',
        'Für Kleinstunternehmen mit geringen Verpackungsmengen sind in bestimmten Fällen Erleichterungen vorgesehen.',
        'Materialmeldung nach Kunststoff-Subtyp erforderlich, ähnlich Italien/CONAI: FZOEU-Tarif führt Kunststoff u. a. als PET, PE, PP sowie zusätzlich PETG, PLA und PS als eigene Kategorien (Quelle: fzoeu.hr, Stand 09/2026 per KI-Recherche, mittlere bis hohe Sicherheit, nicht anwaltlich geprüft).',
        'Bewusst KEIN Bevollmächtigten-Kandidat hinterlegt: gezielte Suche nach kleinen, unabhängigen Alternativen zu Interzero ergab trotz umfangreicher Recherche (auch auf Kroatisch) keinen belastbaren Treffer - nur Interzero selbst sowie kroatische Umweltberater (Oikon, ORO, Eco Code, CIAK Grupa) ohne bestätigtes Bevollmächtigten-Angebot für Verpackungen. Schwacher Hinweis: Go4Recycling (Deutschland) bezeichnet sich als neutraler EPR-Berater mit Kroatien-Abdeckung über ein Partnersystem, ist aber selbst mehrere Länder abdeckend und nicht kroatisch-lokal - vor Kontaktaufnahme direkt verifizieren.'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'ARSO (Agencija Republike Slovenije za okolje) – bestehendes Verpackungsregister (eigenständiges PPWR-Produzentenregister Stand 08/2026 noch nicht bestätigt)',
        registration_url = 'http://okolje.arso.gov.si/embalaza/',
        requirements_json = ?,
        reporting_frequency = 'quarterly',
        data_status = 'needs_verification'
      WHERE code = 'SI'
    `).run(
      JSON.stringify([
        'Das slowenische Umweltministerium hat einen Verordnungsentwurf zur Umsetzung des PRO-Systems für Verpackungen vorbereitet; das nationale Register war Stand 08/2026 noch nicht in Betrieb.',
        'PPWR unterscheidet klar zwischen „Hersteller" (Konformität der Verpackung) und „Produzent" (EPR-Pflichten wie Registrierung und Finanzierung der Entsorgung).',
        'Materialmeldung vermutlich NICHT nach Kunststoff-Subtyp wie in Italien/CONAI: Gebühr richtet sich primär nach Materialart (Karton, Kunststoff, Metall, Glas, Verbund) und Gewicht, keine Hinweise auf Polymer-Aufschlüsselung gefunden (Quelle: KI-Recherche Stand 09/2026, mittlere Sicherheit, nicht anwaltlich geprüft).',
        'Bewusst KEIN Bevollmächtigten-Kandidat hinterlegt: gezielte Suche nach kleinen, unabhängigen Alternativen zu Interzero ergab keinen belastbaren Treffer. Schwache Hinweise für Direktansprache: die sechs slowenischen Verpackungs-Systembetreiber (Slopak, Surovina, Dinos, Recikel, Embakom - Interseroh dabei bewusst NICHT, da ALBA-Group-Marke) übernehmen evtl. keine Bevollmächtigten-Rolle, sondern nur die Systembeteiligung; Triomin d.o.o. (Koper) ist eine kleine Steuer-/Unternehmensberatung mit Verpackungsrecht-Inhalten, aber unbestätigt als Bevollmächtigter tätig - beides vor Kontaktaufnahme direkt verifizieren.'
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
        'Quellen widersprechen sich zur Meldefrequenz über GPAIS (nur jährlich vs. zusätzlich quartalsweise) – vor verlässlicher Aussage noch zu klären.',
        'Wichtige operative Lücke: mindestens eine Quelle besagt, dass GPAIS (das litauische Melde-/Registersystem) Stand 09/2026 noch keine Funktion bietet, mit der ausländische Produzenten sich über einen Bevollmächtigten registrieren können – die Bevollmächtigten-Route könnte also aktuell noch nicht technisch nutzbar sein. Kein konkreter Bevollmächtigten-Anbieter für Litauen bestätigt. Materialgranularität (Polymer-Aufschlüsselung wie CONAI) konnte nicht bestätigt oder ausgeschlossen werden (Quelle: KI-Recherche Stand 09/2026, niedrige Sicherheit, nicht anwaltlich geprüft).'
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
        'Meldefrequenz (monatlich/quartalsweise) hängt vom jeweiligen PRO-Vertrag ab, zusätzlich zu einer jährlichen Zusammenfassung – kein einheitlicher Standard.',
        'Widersprüchliche Quellenlage zur Bevollmächtigten-Pflicht: manche Quellen nennen eine Pflicht mit lettischer Steuer-ID (VID), andere sagen, ausländische Anbieter könnten eigenständig ohne Bevollmächtigten handeln – vor Aussage an Kunden zu klären. Kein konkreter Anbieter bestätigt.',
        'Materialgranularität: die lettische Plastiksteuer unterscheidet "recycelbaren" vs. "nicht recycelbaren" Kunststoff (0,80 €/kg bei nicht recycelbar) mit möglichem Aufschlag für Polystyrol/Schaumstoff – aber keine bestätigte vollständige Polymer-Aufschlüsselung wie bei CONAI (Quelle: KI-Recherche Stand 09/2026, niedrige Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'PAKIS (Verpackungsregister) unter dem Kliimaministeerium (Klimaministerium) / Keskkonnaagentuur – eigenständiges vollwertiges Produzentenregister voraussichtlich erst um 2028 fertig',
        registration_url = 'https://pakis.envir.ee',
        requirements_json = ?,
        representative_provider_name = '1Aruandlus',
        representative_provider_url = 'https://1aruandlus.ee/en/authorized-representative/packaging-reporting-with-an-authorized-representative-in-estonia/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'EE'
    `).run(
      JSON.stringify([
        'Unternehmen müssen sich in jedem Mitgliedstaat registrieren, in dem sie Verpackungen erstmals in Verkehr bringen; ohne gültige Registrierung darf in Estland keine verpackte Ware in Verkehr gebracht werden.',
        'Das eigenständige estnische Produzentenregister wird laut Kliimaministeerium voraussichtlich erst um 2028 fertiggestellt sein.',
        'Materialgranularität unklar: ein Merkblatt zu estnischen Einwegplastik-Vorgaben erwähnt Kunststoffarten wie PET/HDPE/Folien, das bezieht sich aber eher auf Einwegplastik-Kategorien als auf die tatsächliche PAKIS-Meldegranularität für Verpackungsproduzenten (Quelle: KI-Recherche Stand 09/2026, niedrige Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'NISO (National Waste Information System) über ExEA (Executive Environment Agency); Systembeteiligung z. B. über Ecopak oder andere lizenzierte Organisationen',
        registration_url = 'https://eea.government.bg/bg/nsmos/waste/niso/',
        requirements_json = ?,
        reporting_frequency = 'monthly',
        data_status = 'needs_verification'
      WHERE code = 'BG'
    `).run(
      JSON.stringify([
        'Registrierung und Meldung bei den vom bulgarischen Umweltministerium lizenzierten Rückgewinnungsorganisationen (z. B. Ecopak) erforderlich.',
        'Konformitätsbewertung, technische Dokumentation und EU-Konformitätserklärung ab 12.08.2026 vorgeschrieben.',
        'Kein belastbarer Bevollmächtigten-Anbieter für Bulgarien gefunden – Interzeros "alle 27 Mitgliedstaaten"-Werbeaussage nannte Bulgarien in den gefundenen Länderlisten auffällig NICHT namentlich, im Gegensatz zu Kroatien/Italien/Spanien. Vor Kundenaussage direkt prüfen.',
        'Materialgranularität unklar: Ecopaks Kunststoff-Gebühr scheint eine Sammelposition zu sein (~0,175 BGN/kg), keine bestätigte Polymer-Aufschlüsselung wie bei CONAI (Quelle: KI-Recherche Stand 09/2026, niedrige Sicherheit, nicht anwaltlich geprüft).'
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
        'Meldung der Verpackungsmengen über das Valorlux-Portal Valbase; für Industrieverpackungen läuft das Meldefenster jährlich von Anfang Januar bis Ende Februar.',
        'Kein eigenständiger Bevollmächtigten-Dienstleister für Luxemburg gefunden – mehrere Quellen bestätigen übereinstimmend, dass ausländische Fernabsatzhändler stattdessen direkt Mitglied bei Valorlux werden, statt einen dritten Bevollmächtigten einzuschalten. Ob sich das seit dem PPWR-Stichtag 12.08.2026 geändert hat, war Stand 09/2026 nicht abschließend geklärt.',
        'Materialgranularität: Valorlux erfasst bei der Industrieverpackungs-Meldung nur vier Kategorien (Papier/Karton, Holz, Metall, Kunststoff) – Kunststoff bleibt EINE Sammelkategorie, KEINE Aufschlüsselung nach Polymer wie bei Italien/CONAI (Quelle: valorlux.lu, Stand 09/2026 per KI-Recherche, mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Environment and Resources Authority (ERA); Systembeteiligung über GreenPak Coop Society Ltd oder GreenMT Ltd',
        registration_url = 'https://era.org.mt',
        requirements_json = ?,
        reporting_frequency = 'annually',
        data_status = 'needs_verification'
      WHERE code = 'MT'
    `).run(
      JSON.stringify([
        'Registrierungspflicht in jedem Mitgliedstaat, in dem Verpackungen erstmals in Verkehr gebracht werden – auch in Malta.',
        'ERA verlangt von nicht in Malta ansässigen Produzenten die Bestellung eines dort ansässigen Bevollmächtigten – ein konkreter, namentlich bestätigter Dienstleister für diese Rolle (getrennt von den Systembetreibern GreenPak/GreenMT) konnte nicht gefunden werden.',
        'Materialgranularität: Maltas Tarif unterscheidet "formstabilen" und "flexiblen" Kunststoff als getrennte Kategorien – gröber als Italiens CONAI-Modell (keine einzelnen Polymere wie PE/PET/PP), aber auch nicht nur eine einzige Sammelkategorie (Quelle: KI-Recherche Stand 09/2026, mittlere Sicherheit, nicht anwaltlich geprüft).'
      ])
    );


    db.prepare(`
      UPDATE countries
      SET
        register_body = 'Green Dot Cyprus / Department of Environment',
        requirements_json = ?,
        representative_provider_name = 'Markou & Co LLC',
        representative_provider_url = 'https://markoullc.com/authorisedrepresentative-services-cy-batteries/',
        representative_data_status = 'needs_verification',
        reporting_frequency = 'annually',
        data_status = 'verified'
      WHERE code = 'CY'
    `).run(
      JSON.stringify([
        'Green Dot Cyprus ist seit 2002 das etablierte System für die erweiterte Herstellerverantwortung bei Verpackungen in Zypern; Registrierung zusätzlich beim Department of Environment.',
        'Ausländische Unternehmen ohne Sitz in Zypern benötigen einen Bevollmächtigten in Zypern.',
        'Materialmeldung nach Kunststoff-Subtyp erforderlich, ähnlich Italien/CONAI: Green Dot Cyprus führt PET und HDPE als getrennte Positionen in der offiziellen Gebührentabelle (Quelle: greendot.com.cy, Stand 09/2026 per KI-Recherche, mittlere bis hohe Sicherheit – Tabelle selbst evtl. noch nicht an die PPWR-Öko-Modulation ab 08/2026 angepasst, nicht anwaltlich geprüft).'
      ])
    );


    // ========================================================
    // 4b. WEEE- UND BATTERIE-KATEGORIEN (feste EU-Taxonomie)
    //
    // Anhang III Richtlinie 2012/19/EU (WEEE) bzw. Art. 3 Verordnung (EU)
    // 2023/1542 (Batterien) - direkt aus dem Rechtstext, keine pro Land
    // recherchierten Fakten. Per WebSearch am 2026-09-16 gegengeprüft, da
    // eine zuvor kursierende Konzept-Notiz die WEEE-Kategorie 6
    // fälschlich als "Photovoltaikmodule" statt "Kleine IT- und
    // Telekommunikationsgeräte" auflistete.
    // ========================================================

    const weeeCategories = [
      ['1', 'Wärmeaustauschgeräte', 'Temperature exchange equipment', 'Kühlschränke, Gefriergeräte, Klimaanlagen, Wärmepumpen'],
      ['2', 'Bildschirme, Monitore und Geräte mit Bildschirmen (> 100 cm²)', 'Screens, monitors and equipment containing screens (>100 cm²)', 'Fernseher, Laptops, Notebooks, Tablets'],
      ['3', 'Lampen', 'Lamps', 'Leuchtstofflampen, LED-Lampen'],
      ['4', 'Großgeräte (jede Abmessung > 50 cm)', 'Large equipment (any dimension >50 cm)', 'Waschmaschinen, Trockner, Öfen, große Drucker'],
      ['5', 'Kleingeräte (keine Abmessung > 50 cm)', 'Small equipment (no dimension >50 cm)', 'Staubsauger, Toaster, Rasierer, Uhren'],
      ['6', 'Kleine IT- und Telekommunikationsgeräte (keine Abmessung > 50 cm)', 'Small IT and telecommunication equipment (no dimension >50 cm)', 'Mobiltelefone, Router, Taschenrechner']
    ];

    const insertWeeeCategory = db.prepare(`
      INSERT OR IGNORE INTO weee_categories (code, name_de, name_en, description)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of weeeCategories) insertWeeeCategory.run(...row);

    const batteryCategories = [
      ['portable', 'Portable Batterien', 'Portable batteries', 'Versiegelt, unter 5 kg, nicht industriell/LMT/SLI'],
      ['lmt', 'LMT-Batterien (Leichtverkehrsmittel)', 'LMT (Light Means of Transport) batteries', 'E-Bikes, E-Scooter - versiegelt, bis 25 kg'],
      ['industrial', 'Industrie-Batterien', 'Industrial batteries', 'Für industrielle Zwecke, nicht portable/LMT/EV/SLI'],
      ['automotive', 'Fahrzeugbatterien (SLI)', 'Automotive (SLI) batteries', 'Starter-, Beleuchtungs-, Zündungsbatterien für Fahrzeuge'],
      ['ev', 'Elektrofahrzeug-Batterien', 'Electric vehicle (EV) batteries', 'Antriebsbatterien für Elektrofahrzeuge']
    ];

    const insertBatteryCategory = db.prepare(`
      INSERT OR IGNORE INTO battery_categories (code, name_de, name_en, description)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of batteryCategories) insertBatteryCategory.run(...row);

    console.log('✅ WEEE-/Batterie-Kategorien geprüft');


    // ========================================================
    // 4b-2. MATERIAL-LIZENZENTGELTE (Richtwerte, kein Rechtstext)
    //
    // Anders als oben: KEINE feste Taxonomie, sondern grobe
    // €/kg-Schätzwerte, per WebSearch am 2026-09-18 aus öffentlich
    // zitierten Branchenangaben zusammengetragen (Lizenzero-Support-
    // artikel: ø 1,17 €/kg Kunststoff vs. ø 0,10 €/kg PPK-Alternativen;
    // Reclay-Preisbeispiel Mai 2026 für Papier ~0,43 €/kg). Für die
    // Kunststoff-Subtypen (PE/PP/PS/EPS/PVC/PET) gab es keine belastbare
    // öffentliche Einzel-Quelle - diese Werte sind eine plausible
    // Einordnung relativ zum recherchierten Durchschnitt (schwer
    // recycelbare Typen wie PVC/EPS teurer, gut recycelbares PET
    // günstiger), KEINE recherchierten Fakten. source bleibt deshalb
    // durchgehend 'estimate' - jede Zeile ist über /admin/material-rates
    // änderbar, Kunden sollten ihre echten Vertragssätze eintragen.
    // ========================================================

    const materialRates = [
      ['kunststoff', null, 1.17],
      ['kunststoff', 'PE', 1.00],
      ['kunststoff', 'PP', 1.00],
      ['kunststoff', 'PS', 1.10],
      ['kunststoff', 'EPS', 1.30],
      ['kunststoff', 'PVC', 1.50],
      ['kunststoff', 'PET', 0.90],
      ['papier', null, 0.25],
      ['karton', null, 0.20],
      ['glas', null, 0.15],
      ['metall', null, 0.30],
      ['holz', null, 0.10]
    ];

    const insertMaterialRate = db.prepare(`
      INSERT OR IGNORE INTO material_license_rates (material, subtype, price_per_kg_eur, source)
      VALUES (?, ?, ?, 'estimate')
    `);
    for (const row of materialRates) insertMaterialRate.run(...row);

    console.log('✅ Material-Lizenzentgelt-Richtwerte geprüft');


    // ========================================================
    // 4c. WEEE-/BATTERIE-LÄNDERREGELN (recherchiert)
    //
    // Per WebSearch recherchiert am 2026-09-16 (offizielle nationale
    // Register/Behörden, IHK-Länderprofile, EU-Rechtstexte) - KEINE
    // erfundenen Werte. Wo die Recherche keine verlässliche Quelle für
    // ein Detail (insb. Melde-Rhythmus) fand, steht dort bewusst
    // 'needs_verification' statt eines geratenen Werts - siehe auch
    // representative_data_status/data_status-Kommentar in schema.sql:
    // auch mit Quellenangaben ersetzt eine KI-gestützte Web-Recherche
    // keine echte Rechtsprüfung, deshalb bleibt data_status hier
    // durchgehend 'needs_verification', nie 'verified'.
    //
    // Batterie-Sonderhinweis: Die EU-Kommission hat am 10.12.2025
    // vorgeschlagen, die Bevollmächtigten-Pflicht aus Art. 56(3) der
    // Batterieverordnung (EU) 2023/1542 bis 2035 auszusetzen
    // (COM(2025) 982) - Stand der Recherche (09/2026) war der Vorschlag
    // noch nicht verabschiedet, die Pflicht gilt bislang unverändert
    // weiter. Bei allen EU-/EWR-Batterie-Zeilen unten vermerkt.
    // ========================================================

    const EU_WEEE_LABELING = JSON.stringify([
      'Kennzeichnung mit dem Symbol der durchgestrichenen Mülltonne auf Rädern (Anhang IX Richtlinie 2012/19/EU)'
    ]);
    const EU_BATTERY_LABELING = JSON.stringify([
      'Kennzeichnung mit dem Symbol der durchgestrichenen Mülltonne auf Rädern sowie ggf. chemischen Symbolen (Cd/Pb/Hg) gemäß Verordnung (EU) 2023/1542'
    ]);
    const BATTERY_SUSPENSION_NOTE =
      'Hinweis: EU-Kommission hat am 10.12.2025 vorgeschlagen, die Bevollmächtigten-Pflicht aus Art. 56(3) der EU-Batterieverordnung bis 2035 auszusetzen (COM(2025) 982) - Stand 09/2026 noch nicht verabschiedet, Pflicht gilt bislang unverändert weiter.';

    // [country_code, stream, register_body, requirements[], labelingJson, representative_required, registration_generally_required, reporting_frequency, registration_url]
    const countryStreamRulesData = [
      // ---------- EU-Mitgliedstaaten ----------
      ['AT', 'weee', 'EDM-Portal (Elektronisches Datenmanagement) / EAK-Austria (Koordinierungsstelle)',
        ['Registrierung im EDM-Portal (Aktivitätsprofil Hersteller)', 'Ausländische Fernabsatz-Anbieter benötigen einen in Österreich ansässigen Bevollmächtigten (EAG-VO, Art. 17 WEEE-Richtlinie)', 'Quartalsweise Meldung der in Verkehr gebrachten Menge, jährlicher Recycling-Bericht bis 10. April'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://edm.gv.at'],
      ['AT', 'battery', 'EDM-Portal / EAK-Austria',
        ['Registrierung im EDM-Portal (Stammdaten-Register)', 'Ausländische Fernabsatz-Anbieter benötigen einen in Österreich ansässigen Bevollmächtigten (AWG §12b)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://edm.gv.at'],

      ['BE', 'weee', 'Recupel / BeWeee (OVAM, SPW, Leefmilieu Brussel)',
        ['Anmeldung über Recupel oder direkt über BeWeee bei den Regionalbehörden', 'Ausländische Fernabsatz-Anbieter benötigen einen belgischen Bevollmächtigten - Recupel bietet dies Mitgliedern kostenlos an', 'Quartalsweise (wahlweise monatliche) Meldung der in Verkehr gebrachten Menge'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://www.recupel.be'],
      ['BE', 'battery', 'Bebat',
        ['Mitgliedschaft bei Bebat oder genehmigtes Individualsystem', 'Ausländische Hersteller benötigen einen belgischen Bevollmächtigten', 'Meldung über MyBebat: monatlich bei >10.000 Batterien/Jahr, sonst jährlich', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.bebat.be'],

      ['BG', 'weee', 'Изпълнителна агенция по околна среда (ИАОС) / Ministerium für Umwelt und Wasser',
        ['Registrierung bei der Exekutivagentur Umwelt (ИАОС) erforderlich', 'Bevollmächtigten-Pflicht für ausländische Fernabsatz-Anbieter wahrscheinlich (EU-Richtlinie), aber nicht anhand des bulgarischen Gesetzestexts einzeln bestätigt', 'Melde-Rhythmus nicht verlässlich recherchierbar'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://eea.government.bg/registri-spravki'],
      ['BG', 'battery', 'Регистър на лицата, които пускат на пазара батерии и акумулатори (НИСО / ИАОС)',
        ['Registrierung im NISO-Batterieregister (qualifizierte elektronische Signatur erforderlich)', 'Bevollmächtigten-Pflicht wahrscheinlich (EU-Verordnung), bulgarische Gesetzesstelle nicht einzeln bestätigt', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://nwms.eea.government.bg/app/registers/batteries'],

      ['CY', 'weee', 'Department of Environment (MARDE) / Electrocyclosis Cyprus',
        ['Registrierung beim Department of Environment', 'Beitritt zu einem lizenzierten Kollektivsystem (Electrocyclosis Cyprus) oder Einzelgenehmigung', 'Ausländische Fernabsatz-Anbieter benötigen einen in Zypern ansässigen Bevollmächtigten', 'Quartalsweise Mengenmeldung'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://moa.gov.cy/sectors/environment/environment-department-of-environment/'],
      ['CY', 'battery', 'AFIS Cyprus Ltd (Kollektivsystem, mit Green Dot Cyprus)',
        ['Mitgliedschaft bei AFIS Cyprus ist für praktisch alle Marktteilnehmer verpflichtend', 'Ausländische Hersteller benötigen einen in Zypern ansässigen Bevollmächtigten vor Registrierung', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://afiscyprus.com.cy'],

      ['CZ', 'weee', 'Seznam výrobců elektrozařízení (Ministerium für Umwelt / VISOH2)',
        ['Registrierung im Herstellerregister VISOH2, meist über ein Kollektivsystem (z. B. Elektrowin, Ekolamp)', 'Ausländische Hersteller benötigen einen tschechischen Bevollmächtigten mit schriftlichem Vertrag (§11 Gesetz Nr. 542/2020 Sb.)'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://visoh2.mzp.cz/Elektrozarizeni/VyrobciPublic/OsobyIndex'],
      ['CZ', 'battery', 'Seznam výrobců baterií a akumulátorů (Ministerium für Umwelt / VISOH2)',
        ['Registrierung innerhalb von 60 Tagen nach erstem Inverkehrbringen', 'Ausländische Hersteller benötigen einen tschechischen Bevollmächtigten', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://visoh2.mzp.cz/Baterie/PovinneOsoby'],

      ['DE', 'weee', 'Stiftung EAR (Elektro-Altgeräte Register)',
        ['Registrierung bei Stiftung EAR (Markenanmeldung)', 'Hersteller ohne Sitz in Deutschland benötigen einen deutschen Bevollmächtigten (§8 ElektroG)', 'Laufende monatliche/quartalsweise Mengenmeldungen je nach Gerätekategorie, jährliche Abschlussmeldung bis 15. Mai'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://www.stiftung-ear.de'],
      ['DE', 'battery', 'Stiftung EAR (Batterieregister, BattDG)',
        ['Bevollmächtigten-Pflicht für nicht in Deutschland ansässige Hersteller (BattDG)', 'Seit 01.01.2026: Zuordnung zu einer Herstellerverantwortungsorganisation (PRO) mit Nachweis bis 15.01.2026', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.stiftung-ear.de/en/guides/applying-for-battery-registration/'],

      ['DK', 'weee', 'Dansk Producentansvar (DPA-System)',
        ['Registrierung im DPA-System, direkt oder über einen dänischen Bevollmächtigten (bemyndiget repræsentant) mit CVR-Nummer', 'Jährliche Mengenmeldung bis 31. März'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://www.dpa-system.dk'],
      ['DK', 'battery', 'Dansk Producentansvar (DPA-System)',
        ['Registrierung im DPA-System, ausländische Hersteller ohne dänische Präsenz benötigen einen bemyndiget repræsentant', 'Jährliche Mengenmeldung bis 31. März, Sammelquoten-Bericht bis 30. Juni', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'annually', 'https://www.dpa-system.dk'],

      ['EE', 'weee', 'Probleemtooteregister (PROTO), Kliimaministeerium',
        ['Registrierung in PROTO - Hersteller ohne Sitz in Estland benötigen einen estnischen Bevollmächtigten (Jäätmeseadus/Abfallgesetz), gilt ausdrücklich für Fernabsatz', 'Vertrag mit einer Herstellerverantwortungsorganisation für Sammlung/Verwertung'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://proto.envir.ee/proto/main/welcome'],
      ['EE', 'battery', 'Probleemtooteregister (PROTO)',
        ['Gleiches Register wie WEEE - Bevollmächtigten-Pflicht für nicht in Estland ansässige Hersteller', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://proto.envir.ee/proto/main/welcome'],

      ['ES', 'weee', 'RII-AEE (Registro Integrado Industrial, Ministerio de Industria y Turismo)',
        ['Registrierung im RII-AEE vor Inverkehrbringen', 'Nicht in Spanien niedergelassene Hersteller/Fernabsatzhändler benötigen einen spanischen Bevollmächtigten (RD 110/2015)', 'Quartalsweise Meldung (Jan/Apr/Jul/Okt)'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://industria.gob.es/registros-industriales/RAEE/Paginas/Index.aspx'],
      ['ES', 'battery', 'RII-PYA (Registro Integrado Industrial de Pilas y Acumuladores)',
        ['Registrierung im RII-PYA vor Inverkehrbringen', 'Nicht in Spanien niedergelassene Hersteller benötigen einen spanischen Bevollmächtigten', 'Quartalsweise Mengenmeldung', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'quarterly', 'https://industria.gob.es/registros-industriales/pilas/Paginas/Inicio.aspx'],

      ['FI', 'weee', 'Tuottajarekisteri (seit 01.01.2026: Lupa- ja valvontavirasto LVV, zuvor Pirkanmaan ELY-keskus)',
        ['Registrierung im Tuottajarekisteri', 'Ausländische Fernabsatz-Anbieter benötigen einen in Finnland ansässigen Bevollmächtigten (valtuutettu edustaja)', 'Jährlicher Monitoring-Bericht bis 30. Juni'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://lvv.fi'],
      ['FI', 'battery', 'Tuottajarekisteri (LVV)',
        ['Gleiches Register wie WEEE - Bevollmächtigten-Pflicht seit 18.08.2025 für ausländische Fernabsatz-Anbieter', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://lvv.fi'],

      ['FR', 'weee', 'ADEME / SYDEREP (Ökoorganismen Ecosystem, Ecologic)',
        ['Beitritt zu einem zugelassenen Ökoorganismus (Ecosystem oder Ecologic)', 'Identifikationsnummer (IDU) über SYDEREP', 'Seit 10.07.2026 (Gesetz Nr. 2026-602): jeder nicht in Frankreich niedergelassene Hersteller (EU wie Nicht-EU) muss einen französischen Mandataire benennen', 'Jährliche Meldung bis 31. Mai'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://www.syderep.ademe.fr'],
      ['FR', 'battery', 'ADEME / SYDEREP (Ökoorganismen Corepile, Screlec)',
        ['Beitritt zu einem zugelassenen Ökoorganismus (Corepile/Screlec) oder genehmigtes Individualsystem', 'Seit 10.07.2026 verpflichtender französischer Mandataire für nicht in Frankreich niedergelassene Hersteller', 'Jährliche Meldung', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'annually', 'https://www.syderep.ademe.fr'],

      ['GR', 'weee', 'Εθνικό Μητρώο Παραγωγών (ΕΜΠΑ) / EOAN (Hellenic Recycling Agency)',
        ['Registrierung im ΕΜΠΑ zur Erlangung einer Produzenten-Registernummer', 'Definition "Produzent" schließt ausdrücklich Fernabsatzhändler aus anderen EU-Staaten/Drittstaaten ein - genauer Bevollmächtigten-Mechanismus national nicht einzeln bestätigt', 'Melde-Rhythmus nicht verlässlich recherchierbar'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://empa.eoan.gr'],
      ['GR', 'battery', 'ΕΜΠΑ / EOAN (gleiches Register wie WEEE, z. B. Re-Battery A.E. als Kollektivsystem)',
        ['Registrierung im ΕΜΠΑ verpflichtend', 'Bevollmächtigten-Mechanismus für Batterien aus EU-Recht abgeleitet, griechische Spezifika nicht einzeln bestätigt (niedrige Konfidenz)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://empa.eoan.gr'],

      ['HR', 'weee', 'RPPO - Registar proizvođača s proširenom odgovornosti (FZOEU)',
        ['Direkte Online-Registrierung im RPPO (Hersteller oder Bevollmächtigter)', 'Fernabsatz-Anbieter ohne Sitz in Kroatien benötigen einen kroatischen Bevollmächtigten (schriftliche Vollmacht)', 'Meldung und Selbstberechnung der Abfallgebühr an FZOEU'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://rppo.fzoeu.hr/'],
      ['HR', 'battery', 'RPPO (FZOEU) - Batterie-/Akkumulator-Hersteller',
        ['Registrierung im RPPO', 'Monatliche Meldung per Formular OBA1 (fällig zum Monatsende für den Vormonat)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'monthly', 'https://rppo.fzoeu.hr/'],

      ['HU', 'weee', 'OKIR (nationales Umweltinformationssystem) / MOHU (staatlicher EPR-Konzessionsinhaber)',
        ['Registrierung als EPR-Produzent im MOHU-Partnerportal und Antrag über das OKIR-Gate', 'Ausländische Online-Verkäufer benötigen faktisch einen ungarischen Bevollmächtigten (ungarische Steuernummer/Regierungsportal-Zugang erforderlich)', 'Quartalsweise Meldung bis zum 20. Tag nach Quartalsende'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://kapu.okir.hu'],
      ['HU', 'battery', 'OKIR / MOHU (gleiches System wie WEEE, seit 01.07.2023 reformiert)',
        ['Registrierung als EPR-Produzent bei MOHU und über das OKIR-Gate', 'Quartalsweise Meldung bis zum 20. Tag nach Quartalsende', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'quarterly', 'https://kapu.okir.hu'],

      ['IE', 'weee', 'Producer Register Limited (PRL) / EPA',
        ['Jährliche Registrierung bei PRL', 'Nicht in Irland niedergelassene Fernabsatzhändler benötigen einen irischen Bevollmächtigten, der sämtliche WEEE-Pflichten übernimmt (S.I. No. 149/2014)', 'Monatliche Mengenmeldung über das PRL-Blackbox-Portal (fällig zum 19. des Monats)'],
        EU_WEEE_LABELING, 1, 1, 'monthly', 'https://www.producerregister.ie'],
      ['IE', 'battery', 'Producer Register Limited (PRL) / EPA',
        ['Registrierung bei PRL als Batterie-Produzent', 'Bevollmächtigten-Pflicht für nicht in Irland niedergelassene Hersteller', 'Monatliche Meldung von Gewicht/Chemie über PRL Blackbox', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'monthly', 'https://www.producerregister.ie'],

      ['IT', 'weee', 'Registro Nazionale dei Produttori di AEE (Handelskammern/Unioncamere)',
        ['Elektronische Registrierung über die zuständige Handelskammer vor Inverkehrbringen', 'Fernabsatzhändler ohne Sitz in Italien benötigen einen italienischen Bevollmächtigten (Rappresentante Autorizzato, D.Lgs. 49/2014)', 'Jährliche Meldung im Rahmen der MUD-Erklärung (ca. 30. April)'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://www.registroaee.it/'],
      ['IT', 'battery', 'RENAP - Registro Nazionale dei Produttori (Pile e Accumulatori)',
        ['Elektronische Registrierung über die Handelskammer', 'Ausländische Hersteller registrieren über einen italienischen Bevollmächtigten', 'Jährliche Meldung bis 31. März (Stückzahl/Gewicht)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'annually', 'https://www.renap.gov.it/it/registro-pile-e-accumulatori'],

      ['LT', 'weee', 'GPAIS - Gaminių, pakuočių ir atliekų informacinė sistema (Umweltschutzagentur AAA)',
        ['Registrierung in GPAIS (ein Konto deckt auch Verpackung, Batterien u. a. Ströme ab)', 'Ausländische Hersteller ohne litauische Niederlassung benötigen einen litauischen Bevollmächtigten mit Vollmacht (Art. 34¹(3) Abfallgesetz)', 'Jährliche Meldung binnen 50 Tagen nach Jahresende'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://www.gpais.eu'],
      ['LT', 'battery', 'GPAIS (gleiches System wie WEEE)',
        ['Registrierung als Batterie-Produzent in GPAIS über einen litauischen Bevollmächtigten (falls nicht ansässig)', 'Melde-Rhythmus analog WEEE angenommen, für Batterien nicht einzeln bestätigt', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.gpais.eu'],

      ['LU', 'weee', 'Administration de l’environnement (AEV) / Ecotrel ASBL',
        ['Registrierung bei der Administration de l’Environnement, direkt oder über einen luxemburgischen Bevollmächtigten', 'Beitritt zu Ecotrel ASBL (derzeit einziges zugelassenes Kollektivsystem) oder Einzelgenehmigung', 'Jährliche Meldung bis 30. April'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://environnement.public.lu/fr/emweltprozeduren/Autorisations/Gestion_des_dechets_et_ressources/Dechets_d_equipements_electriques_et_electroniques.html'],
      ['LU', 'battery', 'Administration de l’environnement (AEV) / Ecobatterien ASBL',
        ['Registrierung bei der Administration de l’Environnement, direkt oder über einen luxemburgischen Bevollmächtigten', 'Beitritt zu Ecobatterien ASBL oder Einzelgenehmigung über das e-RA-Tool', 'Jährliche Meldung bis 30. Juni (Einzelgenehmigung)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'annually', 'https://www.ecobatterien.lu'],

      ['LV', 'weee', 'Elektroregistrs (LETERA, im Auftrag des Klima- und Energieministeriums)',
        ['Registrierung im Elektroregistrs, direkt oder über einen lettischen Bevollmächtigten mit schriftlicher Vollmacht und WEEE-Sammelvertrag', 'Halbjährliche Meldung (fällig 30. April und 30. Oktober)'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://elektroregistrs.lv/registration/en'],
      ['LV', 'battery', 'BARR - Bateriju un Akumulatoru Reģistrs (LETERA-Infrastruktur)',
        ['Registrierung im Batterieregister BARR, direkt oder über einen lettischen Bevollmächtigten mit schriftlicher Vollmacht', 'Halbjährliche Meldung analog WEEE angenommen', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', null],

      ['MT', 'weee', 'Environment and Resources Authority (ERA)',
        ['Registrierung bei ERA (Formular A) vor Inverkehrbringen', 'Fernabsatzhändler ohne Sitz in Malta benötigen einen maltesischen Bevollmächtigten, der gegenüber ERA haftet (S.L. 549.89, §17(2))', 'Quartalsweise Meldung binnen 40 Werktagen nach Quartalsende, jährliche Erneuerung (Formular B)'],
        EU_WEEE_LABELING, 1, 1, 'quarterly', 'https://era.org.mt/topic/waste-electrical-and-electronic-equipment/'],
      ['MT', 'battery', 'ERA - Nationales Register der Batterie-/Akkumulator-Hersteller',
        ['Registrierung bei ERA vor erstem Inverkehrbringen', 'Ausländische Hersteller benötigen einen maltesischen Bevollmächtigten mit schriftlicher Vollmacht (S.L. 549.178, seit 14.10.2025)', 'Melde-Rhythmus noch nicht verlässlich recherchierbar (sehr neue Regelung)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://era.org.mt/topic/batteries-and-accumulators-and-waste-batteries-and-accumulators/'],

      ['NL', 'weee', 'Nationaal (W)EEE Register (NWR) / Stichting OPEN',
        ['Beitritt zu Stichting OPEN (übernimmt auch die NWR-Registrierung)', 'Hersteller außerhalb der EU benötigen einen niederländischen Bevollmächtigten; für EU-Hersteller evtl. Ausnahme direkter Registrierung (nicht offiziell bestätigt)', 'Meldung quartalsweise (größere Teilnehmer) oder jährlich (kleinere), über das myOPEN-2.0-Portal'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://www.stichting-open.org/en/'],
      ['NL', 'battery', 'Stichting OPEN (vormals Stibat, seit 01.01.2024 integriert)',
        ['Registrierung als Batterie-Produzent bei Stichting OPEN', 'Hersteller außerhalb der Niederlande benötigen einen niederländischen Bevollmächtigten', 'Melde-Rhythmus je nach Größe monatlich/quartalsweise/jährlich', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.stichting-open.org/en/forms/register-producer-batteries/'],

      ['PL', 'weee', 'BDO - Baza danych o produktach i opakowaniach oraz o gospodarce odpadami',
        ['Eintragung in BDO vor Aufnahme der Tätigkeit', 'Fernabsatz-Hersteller ohne Sitz in Polen benötigen einen im BDO-Register eingetragenen autoryzowany przedstawiciel (Bevollmächtigten)', 'Jährliche Meldung (Abschnitt V: Elektro-/Elektronikgeräte)'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://bdo.mos.gov.pl'],
      ['PL', 'battery', 'BDO (gleiche Plattform wie WEEE)',
        ['Eintragung als "wprowadzający" (Inverkehrbringer) von Batterien in BDO', 'Bevollmächtigten-Mechanismus im BDO-Register seit ca. 12.08.2026 vorgesehen; eigenständiges neues polnisches Batteriegesetz war zum RechercheZeitpunkt noch Gesetzentwurf', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://bdo.mos.gov.pl'],

      ['PT', 'weee', 'Agência Portuguesa do Ambiente (APA) / SILiAmb',
        ['Registrierung über die SILiAmb-Plattform', 'Unternehmen ohne portugiesische Niederlassung benötigen einen representante autorizado (schriftliches Mandat, mind. 15 Tage vor Wirksamkeit bei APA eingereicht)', 'Jährliche Meldung bis 31. März (Vorjahres-Ist-Werte + laufende Schätzung)'],
        EU_WEEE_LABELING, 1, 1, 'annually', 'https://apambiente.pt/residuos/registo-de-produtoresembaladores'],
      ['PT', 'battery', 'APA / SILiAmb (gleiches System wie WEEE)',
        ['Registrierung über SILiAmb, representante autorizado für nicht in Portugal niedergelassene Hersteller erforderlich', 'Jährliche Meldung bis 31. März', 'Ab 18.02.2027: Registrierungspflicht im EU-Batteriepass für LMT-, Industrie- (>2kWh) und EV-Batterien', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'annually', 'https://apambiente.pt/en/node/370'],

      ['RO', 'weee', 'Administrația Fondului pentru Mediu (AFM)',
        ['Registrierung im nationalen Herstellerregister (online.afm.ro), direkt (qualifizierte elektronische Signatur) oder über einen Bevollmächtigten', 'Beitritt zu einem lizenzierten Kollektivsystem (z. B. Ecotic) oder Einzelsystem', 'Monatliche Meldung an AFM bis zum 25. des Monats (mittlere Konfidenz)'],
        EU_WEEE_LABELING, 1, 1, 'monthly', 'https://online.afm.ro'],
      ['RO', 'battery', 'AFM (gleiches System wie WEEE)',
        ['Registrierung als Batterie-Hersteller/Importeur im nationalen B&A-Register bei AFM', 'Beitritt zu einem lizenzierten Kollektivsystem (z. B. Ecotic BAT) oder Einzelsystem', 'Monatliche Meldung für portable Batterien angenommen (mittlere Konfidenz)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'monthly', 'https://online.afm.ro'],

      ['SE', 'weee', 'Naturvårdsverket (Producentansvarsregistret) / El-Kretsen',
        ['Registrierung im Producentansvarsregister bei Naturvårdsverket - verpflichtend auch für Mitglieder des Kollektivsystems El-Kretsen', 'Nicht in Schweden niedergelassene Fernabsatzhändler benötigen einen schwedischen Bevollmächtigten (auktoriserad representant)', 'Genauer Melde-Rhythmus nicht verlässlich recherchierbar'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://www.naturvardsverket.se/vagledning-och-stod/producentansvar/producentansvar-for-elutrustning/'],
      ['SE', 'battery', 'Naturvårdsverket (gleiches Register wie WEEE)',
        ['Registrierung im Producentansvarsregister, Bevollmächtigten-Pflicht laut offizieller Naturvårdsverket-Anleitung ausdrücklich für Fernabsatzhändler ohne schwedische Niederlassung', 'Melde-Rhythmus nicht verlässlich recherchierbar', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.naturvardsverket.se/en/guidance/extended-producer-responsibility-epr/producer-responsibility-for-batteries/'],

      ['SI', 'weee', 'MOPE (Ministrstvo za okolje, podnebje in energijo) über SPOT-Portal',
        ['Antrag auf Eintragung in die Herstellerdatenbank über das staatliche SPOT-Portal, Registrierung von Hersteller ODER Bevollmächtigtem erforderlich vor jedem Verkauf', 'Melde-Rhythmus nicht verlässlich recherchierbar'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://spot.gov.si/sl/dejavnosti-in-poklici/dovoljenja/vpis-v-evidenco-proizvajalcev-in-pooblascenih-zastopnikov-elektricne-in-elektronske-opreme'],
      ['SI', 'battery', 'MOPE über SPOT-Portal (Batterie-Herstellerregister)',
        ['Antrag auf Eintragung über SPOT vor erstem Inverkehrbringen, Beteiligung an einem kollektiven Batteriemanagementplan', 'Bevollmächtigten-Mechanismus für Batterien speziell nicht einzeln bestätigt (mittlere Konfidenz)', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://spot.gov.si/sl/dejavnosti-in-poklici/dovoljenja/vpis-v-evidenco-proizvajalcev-baterij-in-akumulatorjev/'],

      ['SK', 'weee', 'Register výrobcov vyhradených výrobkov (MŽP SR / ISOH.gov.sk)',
        ['Elektronischer Antrag über das ISOH-Portal auf Eintragung', 'Nicht ansässige Hersteller müssen einen in der Slowakei ansässigen Bevollmächtigten benennen (offiziell bestätigt)', 'Melde-Rhythmus nicht verlässlich recherchierbar'],
        EU_WEEE_LABELING, 1, 1, 'needs_verification', 'https://www.isoh.gov.sk/uvod/zivotna-situacia-registracia.html'],
      ['SK', 'battery', 'Zoznam výrobcov batérií a akumulátorov (MŽP SR / ISOH.gov.sk)',
        ['Registrierungsantrag bei MŽP SR vor erstem Inverkehrbringen', 'Bevollmächtigten-Pflicht für Hersteller mit Sitz außerhalb der Slowakei offiziell bestätigt', 'Änderungen müssen binnen 30 Tagen gemeldet werden', BATTERY_SUSPENSION_NOTE],
        EU_BATTERY_LABELING, 1, 1, 'needs_verification', 'https://www.isoh.gov.sk/uvod/registre/zoznam-vyrobcov-baterii-a-akumulatorov.html'],

      // ---------- EWR / UK / Schweiz ----------
      ['NO', 'weee', 'Miljødirektoratet (Produsentregister) + zugelassene Rücknahmegesellschaft (z. B. NORSIRK, Renas)',
        ['Registrierung im Produsentregister bei Miljødirektoratet - nur Unternehmen mit norwegischer Organisationsnummer können direkt registrieren, ausländische Hersteller benötigen einen norwegischen Bevollmächtigten mit schriftlicher Vollmacht (Avfallsforskriften Kap. 1)', 'Beitritt zu einer zugelassenen Rücknahmegesellschaft', 'Meldung an Rücknahmegesellschaft vermutlich halbjährlich, an Miljødirektoratet jährlich (nicht abschließend bestätigt)'],
        JSON.stringify([]), 1, 1, 'needs_verification', 'https://produsentansvar.miljodirektoratet.no/'],
      ['NO', 'battery', 'Miljødirektoratet + zugelassene Batterie-Rücknahmegesellschaft (z. B. Batteriretur)',
        ['Registrierung analog WEEE - norwegischer Bevollmächtigter mit schriftlicher Vollmacht für ausländische Hersteller (Avfallsforskriften Kap. 3)', 'Meldepflicht der Compliance-Lösung binnen 3 Monaten nach Verkaufsbeginn, danach jährliche Mengendokumentation'],
        JSON.stringify([]), 1, 1, 'annually', 'https://produsentansvar.miljodirektoratet.no/'],

      ['IS', 'weee', 'Umhverfis- og orkustofnun (UST) + Úrvinnslusjóður (Recyclingfonds)',
        ['Registrierung als gebührenpflichtiger Importeur/Hersteller bei der Steuerbehörde (Skatturinn) binnen 15 Tagen vor Tätigkeitsbeginn (Recyclinggebühr úrvinnslugjald)', 'Zusätzliche Registrierung bei Umhverfis- og orkustofnun für die WEEE-Herstellerverantwortung', 'Bevollmächtigten-Mechanismus für nicht ansässige Fernabsatzhändler nicht eindeutig bestätigt - als EWR-Staat wird die EU-Richtlinie grundsätzlich umgesetzt, genaue isländische Ausgestaltung unklar'],
        JSON.stringify([]), 1, 1, 'needs_verification', 'https://www.urvinnslusjodur.is/english'],
      ['IS', 'battery', 'Úrvinnslusjóður (Reglugerð 1020/2011)',
        ['Registrierung als Hersteller/Importeur von Batterien bei Úrvinnslusjóður (Name + Kennitala) Pflicht laut Verordnung 1020/2011', 'Finanzierung der Entsorgung über Zahlungen an den Recyclingfonds', 'Bevollmächtigten-Mechanismus für nicht ansässige Fernabsatzhändler nicht eindeutig bestätigt'],
        JSON.stringify([]), 1, 1, 'needs_verification', 'https://www.urvinnslusjodur.is/framleidendaabyrgd/voruflokkar/rafhlodur'],

      ['LI', 'weee', 'Kein eigenes Register - Liechtenstein folgt über die Zollunion mit der Schweiz (Vertrag von 1923) direkt dem Schweizer VREG-System',
        ['Gleiche Pflichten wie in der Schweiz: Beitritt zu SENS eRecycling (Haushaltsgeräte) oder Swico Recycling (IT/Elektronik) - beide Systeme decken Liechtenstein ausdrücklich mit ab', 'Lokale Rücknahmestelle in Liechtenstein vorhanden (z. B. ELREC AG)', 'Kein eigenständiger liechtensteinischer Bevollmächtigten-Mechanismus gefunden'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.swico.ch/en/recycling/'],
      ['LI', 'battery', 'INOBAT (gemeinsames System für Schweiz und Liechtenstein, Zollunion)',
        ['Registrierung bei INOBAT - Geltungsbereich ausdrücklich "Schweiz und Fürstentum Liechtenstein"', 'Kein eigenständiges liechtensteinisches Batterieregister', 'Kein eigenständiger Bevollmächtigten-Mechanismus gefunden'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.inobat.ch/'],

      ['GB', 'weee', 'Environment Agency (National Producer Registration/NPWD) bzw. regionale Äquivalente (SEPA, NRW, NIEA) + Producer Compliance Scheme (PCS)',
        ['Kein klassischer "Bevollmächtigter" wie in der EU - ein Fernabsatzhändler ohne UK-Sitz, der direkt an britische Endkunden verkauft, gilt selbst als "Producer" und muss registrieren; seit 12.08.2025 gelten auch Online-Marktplätze selbst als Producer für Drittanbieter-Verkäufe', 'Einstufung als "small producer" (<5t/Jahr, Direktregistrierung) oder "large producer" (≥5t/Jahr, Beitritt zu einem PCS) vor Inverkehrbringen', 'Quartalsweise Mengenmeldung (große Hersteller), jährlich (kleine)'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://npwd.environment-agency.gov.uk/public/WEEEHome.aspx'],
      ['GB', 'battery', 'Environment Agency (NPWD Batteries) + Battery Compliance Scheme (BCS)',
        ['Gleiche Logik wie WEEE: Fernabsatzhändler, die direkt an britische Endkunden verkaufen, gelten selbst als "Producer" statt einen separaten Bevollmächtigten zu benennen (Batteries and Accumulators Regulations 2008 i.d.F.)', 'Bei >1 Tonne/Jahr: Beitritt zu einem Battery Compliance Scheme mit quartalsweiser Meldung; bei ≤1 Tonne: Direktregistrierung bei der Environment Agency (jährliche Gebühr £30)'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://npwd.environment-agency.gov.uk/public/BatteriesHome.aspx'],

      ['CH', 'weee', 'SENS eRecycling (Haushaltsgeräte) / Swico Recycling (IT/Unterhaltungselektronik), unter Aufsicht des BAFU',
        ['Beitritt zum passenden Rücknahmesystem je nach Produktkategorie (SENS oder Swico)', 'Seit der VREG-Revision 2022 gelten auch ausländische Fernabsatzhändler, die direkt an Schweizer Endkunden verkaufen, selbst als "Hersteller" - kein eigenständiger Bevollmächtigten-Mechanismus im EU-Sinn bestätigt', 'Vorgezogene Recyclinggebühr (vRG) im Verkaufspreis eingerechnet'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.swico.ch/en/recycling/'],
      ['CH', 'battery', 'INOBAT (Verein INOBAT, betrieben mit Batrec Industrie AG), unter Aufsicht des BAFU',
        ['Registrierung bei INOBAT als Hersteller/Importeur vor Inverkehrbringen', 'Vorgezogene Entsorgungsgebühr (VEG) im Verkaufspreis eingerechnet', 'Kein eigenständiger Bevollmächtigten-Mechanismus im EU-Sinn bestätigt - Erfassung erfolgt über direkte INOBAT-Registrierung'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.inobat.ch/'],

      // ---------- Nicht-EU/EWR ----------
      ['AU', 'weee', 'National Television and Computer Recycling Scheme (NTCRS) - DCCEEW; nur TV/Computer/Drucker/Peripheriegeräte über Mengenschwelle',
        ['Nur für Importeure/Hersteller von TV, Computern, Druckern und Peripheriegeräten über einem Mengenschwellenwert verpflichtend - kein allgemeines Register für alle Elektrogeräte', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus', 'Geplante Ausweitung auf "kleine Elektro-/Elektronikgeräte" (SEEE) war zum Recherchezeitpunkt noch nicht Gesetz', 'Jährliche Recycling-Zielvorgaben'],
        JSON.stringify([]), 0, 0, 'annually', 'https://www.dcceew.gov.au/environment/protection/waste/e-waste'],
      ['AU', 'battery', 'National: freiwillig über Battery Stewardship Council / B-cycle; ab 01.10.2026 in New South Wales verpflichtend (Product Lifecycle Responsibility Act 2026)',
        ['Landesweit bislang nur freiwillige Teilnahme an B-cycle üblich', 'Bundesstaat New South Wales führt ab 01.10.2026 als erster australischer Bundesstaat eine verpflichtende Regelung ein (Registrierung bei einer akkreditierten Product Stewardship Organisation, quartalsweise UND jährliche Meldung)', 'Andere Bundesstaaten folgen bislang nicht - fragmentiertes Bild ähnlich wie bei Verpackung/USA/Kanada'],
        JSON.stringify([]), 0, 0, 'needs_verification', 'https://bcycle.com.au/'],

      ['CA', 'weee', 'Keine Bundesregelung - provinzweise EPR-Programme, meist über EPRA (Electronic Products Recycling Association) abgewickelt',
        ['Pflichten bestehen provinzweise, nicht national - Registrierung als "Steward" bei EPRA oder der jeweiligen Provinzbehörde (z. B. Ontario: RPRA) erforderlich', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus', 'Nunavut hat bislang kein Programm'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://epra.ca/'],
      ['CA', 'battery', 'Keine Bundesregelung - provinzweise EPR, meist über Call2Recycle Canada abgewickelt',
        ['Registrierung als Mitglied/"Steward" bei Call2Recycle (getrennte Programme für Haushalts- und E-Mobility-/EV-Batterien) je nach belieferter Provinz', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://call2recycle.ca/'],

      ['CN', 'weee', 'Ministerium für Ökologie und Umwelt (MEE) / Finanzministerium (MOF) - Fonds für die Behandlung von Elektroaltgeräten, nur 5 regulierte Gerätekategorien (u. a. Fernseher, Kühlschränke, Waschmaschinen, Klimaanlagen, Computer)',
        ['Nur für 5 gesetzlich definierte Gerätekategorien verpflichtend, kein allgemeines Register für alle Elektrogeräte', 'Einzahlung in den staatlichen WEEE-Fonds durch Hersteller bzw. Importeur/dessen Agenten', 'Kein bestätigtes öffentliches Registrierungsportal gefunden - needs_verification'],
        JSON.stringify([]), 1, 1, 'needs_verification', null],
      ['CN', 'battery', 'Ministerium für Industrie und Informationstechnologie (MIIT) - Rückverfolgungsplattform nur für NEV-Antriebsbatterien (2026); für sonstige Batterien kein einheitliches Register bestätigt',
        ['Für Elektrofahrzeug-Antriebsbatterien seit 2026 verpflichtende Rückverfolgungs-/Registrierungspflicht bei MIIT', 'Für Konsumgüter-Batterien (z. B. Haushaltsbatterien) kein einheitliches nationales Pflichtregister gefunden - vermutlich über allgemeines Abfallrecht geregelt'],
        JSON.stringify([]), 0, 1, 'needs_verification', null],

      ['IN', 'weee', 'Central Pollution Control Board (CPCB) - E-Waste (Management) Rules 2022',
        ['Registrierung als Manufacturer/Producer/Importer/Brand Owner auf dem CPCB-EPR-Portal vor Verkauf/Import', 'Ausländische Hersteller benötigen einen Authorized Indian Representative (AIR)', 'Jährliche Sammel-Zielvorgaben je nach EPR-Zulassung'],
        JSON.stringify([]), 1, 1, 'annually', 'https://eprewastecpcb.in'],
      ['IN', 'battery', 'Central Pollution Control Board (CPCB) - Battery Waste Management Rules 2022',
        ['Registrierung auf dem zentralen CPCB-Batterie-EPR-Portal', 'Ausländische Hersteller benötigen analog zu WEEE einen Authorized Indian Representative (AIR) - für Batterien nicht separat bestätigt, aber strukturell gleiches System', 'Zulassung ist 5 Jahre gültig'],
        JSON.stringify([]), 1, 1, 'needs_verification', 'https://eprbattery.cpcb.gov.in/'],

      ['JP', 'weee', 'Home Appliance Recycling Law / Kaden Recycling-Gesetz (家電リサイクル法) - METI/Umweltministerium, NUR 4 Gerätekategorien (Klimaanlagen, Fernseher, Kühl-/Gefriergeräte, Waschmaschinen/Trockner)',
        ['Nur für 4 gesetzlich definierte Gerätekategorien verpflichtend - kein allgemeines Register für alle Elektrogeräte, andere Kategorien fallen unter ein separates, leichteres Kleingeräte-Recyclinggesetz mit kommunalen Sammelboxen', 'Hersteller/Importeure müssen ein landesweites Rücknahmesystem für die eigenen Marken aufbauen (Recycling-Ticket-System statt klassischem Register)', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus im EU-Sinn'],
        JSON.stringify([]), 0, 1, 'needs_verification', null],
      ['JP', 'battery', 'JBRC (Japan Portable Rechargeable Battery Recycling Center) - nur wiederaufladbare Batterien (Ni-Cd, Ni-MH, Li-Ion, kleine Blei-Akkus)',
        ['Nur für wiederaufladbare Batterien verpflichtend, Einwegbatterien fallen nicht unter diese Pflicht', 'Praktischer Compliance-Weg ist die Mitgliedschaft bei JBRC (eigenes Sammelsystem ist für die meisten Unternehmen unpraktikabel)', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus im EU-Sinn'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.jbrc.com/'],

      ['TH', 'weee', 'Noch kein verbindliches Gesetz - Entwurf des WEEE Act (Pollution Control Department) seit rund 20 Jahren in Vorbereitung, durch Parlamentsauflösung im Dezember 2025 erneut verzögert',
        ['Aktuell KEINE verpflichtende Registrierung für Elektroaltgeräte - dies ist ein recherchiert bestätigter, ehrlicher Befund, keine Recherchelücke', 'Der Gesetzentwurf sieht bei Inkrafttreten eine Herstellerpflicht (direkt oder über eine bei der PCD registrierte Abfallmanagement-Organisation) vor, tritt aber laut Entwurf erst 1 Jahr nach Veröffentlichung in Kraft (Bußgelder erst nach 2 Jahren)'],
        JSON.stringify([]), 0, 0, 'needs_verification', null],
      ['TH', 'battery', 'Kein eigenständiges Batteriegesetz - würde voraussichtlich Teil eines künftigen WEEE Act',
        ['Aktuell KEINE verpflichtende Registrierung für Batterien - bestätigter Befund, keine Recherchelücke', 'Allgemeines Gefahrstoffrecht (Ministry of Industry) regelt nur die Entsorgung, nicht die Herstellerregistrierung'],
        JSON.stringify([]), 0, 0, 'needs_verification', null],

      ['US', 'weee', 'Kein Bundesgesetz - ca. 25 Bundesstaaten + DC mit eigenen E-Waste-Gesetzen (u. a. Kalifornien: CalRecycle/CDTFA)',
        ['Verpflichtungen bestehen bundesstaatenabhängig, nicht national - in rund der Hälfte der Bundesstaaten existiert gar keine Regelung', 'Beispiel Kalifornien: gebührenbasiertes Modell über CDTFA (Point-of-Sale-Recyclinggebühr) plus CalRecycle-Programm; andere Staaten (NY, WA, IL) nutzen ein Hersteller-EPR-Modell', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://calrecycle.ca.gov/electronics/'],
      ['US', 'battery', 'Bundesweit nur MCRBMA (Kennzeichnung/Quecksilber-Grenzwerte, kein Register); EPR-Pflichten bundesstaatenabhängig (u. a. New Jersey, Kalifornien, Washington, New York, Illinois)',
        ['Kein Bundesregister - der Mercury-Containing and Rechargeable Battery Management Act regelt nur Kennzeichnung/Grenzwerte, keine Herstellerregistrierung', 'Wachsende Zahl von Bundesstaaten mit eigenen Batterie-EPR-Gesetzen, oft über Call2Recycle als zugelassene Organisation abgewickelt (z. B. New Jersey: verpflichtende Meldung für Antriebsbatterien seit 08.01.2026)', 'Kein bestätigter eigenständiger Bevollmächtigten-Mechanismus'],
        JSON.stringify([]), 0, 1, 'needs_verification', 'https://www.call2recycle.org']
    ];

    const insertCountryStreamRule = db.prepare(`
      INSERT OR IGNORE INTO country_stream_rules
        (country_code, stream, register_body, requirements_json, labeling_json,
         representative_required, registration_generally_required, reporting_frequency,
         registration_url, data_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_verification')
    `);
    for (const [code, stream, registerBody, requirements, labelingJson, repReq, regReq, freq, url] of countryStreamRulesData) {
      insertCountryStreamRule.run(code, stream, registerBody, JSON.stringify(requirements), labelingJson, repReq, regReq, freq, url);
    }

    console.log(`✅ WEEE-/Batterie-Länderregeln recherchiert und eingefügt: ${countryStreamRulesData.length} Zeilen (${countryStreamRulesData.length / 2} Länder × 2 Ströme)`);



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

    addColumnIfMissing(
      'compliance_rules',
      'stream',
      "TEXT NOT NULL DEFAULT 'packaging'"
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

            stream TEXT NOT NULL
              DEFAULT 'packaging',

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


        const streamExpression =
          hasOld('stream')
            ? `COALESCE(
                stream,
                'packaging'
              )`
            : `'packaging'`;


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
            stream,

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
            ${streamExpression},

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
      'representative_customer_assignments',
      'representative_access_log',
      'customer_representative_requests',
      'country_stream_rules',
      'weee_categories',
      'battery_categories',
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

    // Herkunftsland des Besuchers (per clientseitiger IP-Geolocation
    // erkannt, siehe index.html detectCountryByIP() - dieselbe Erkennung,
    // die auch für Sprach-/Preisvorschlag genutzt wird). Nur der
    // zweistellige ISO-Ländercode, keine IP-Adresse wird gespeichert.
    addColumnIfMissing('page_views', 'country', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);`);

    // Gerätetyp (mobile/tablet/desktop), clientseitig per User-Agent-
    // Heuristik erkannt (siehe index.html detectDeviceType()) - kein
    // vollständiger User-Agent-String wird gespeichert, nur die grobe
    // Kategorie. Ermöglicht z. B. zu prüfen, ob Absprünge direkt nach
    // dem Hero überproportional von einem Gerätetyp kommen (siehe
    // GET /admin/landing-engagement -> heroBounce).
    addColumnIfMissing('page_views', 'device_type', 'TEXT');

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

    // Nutzung des öffentlichen FAQ-Chats auf der Landing Page (siehe
    // routes/faq-chat.js): jede vorgefertigte Frage (Klick, 0 Cent) und
    // jede Freitext-Frage wird geloggt - damit im Admin-Dashboard sichtbar
    // wird, wie oft der Chat genutzt wird und welche Fragen am häufigsten
    // vorkommen. 'answered' = false heißt: die KI konnte die Frage NICHT
    // sicher aus bekanntem Pack2EU-Wissen beantworten (kein Bing/Web-Aufruf,
    // keine Recherche-Kosten) - diese Fragen landen als Vorschlag für neue
    // FAQ-Einträge im Admin-Dashboard, statt einfach nur eine Ausweich-
    // antwort zu bekommen.
    db.exec(`
      CREATE TABLE IF NOT EXISTS faq_chat_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        source TEXT NOT NULL,
        canned_id TEXT,
        answered INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_faq_chat_log_created_at ON faq_chat_log(created_at);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_faq_chat_log_answered ON faq_chat_log(answered);`);

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

    // Dringlichkeit für die Aufgabenliste (siehe /admin/tasks) - erlaubt,
    // z. B. einen alten Launch-Ablaufplan in einem Rutsch einzutragen und
    // danach nach Priorität statt nur nach Fälligkeitsdatum zu sortieren.
    addColumnIfMissing('admin_tasks', 'priority', "TEXT NOT NULL DEFAULT 'medium'");

    // Täglich wiederkehrende Aufgaben (z. B. "Insta Stories posten") -
    // 'status' bleibt bei recurrence='daily' technisch ungenutzt für die
    // Anzeige, stattdessen zeigt last_completed_date, ob HEUTE schon
    // erledigt wurde. Dadurch verschwindet der Haken am nächsten Tag von
    // selbst, ganz ohne Cronjob zum Zurücksetzen (siehe routes/admin.js).
    addColumnIfMissing('admin_tasks', 'recurrence', "TEXT NOT NULL DEFAULT 'none'");
    addColumnIfMissing('admin_tasks', 'last_completed_date', 'TEXT');

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

    // Selbstauskunft aus dem Onboarding ("Verkaufst du auch Elektrogeräte
    // oder Produkte mit eingebauter Batterie?", siehe dashboard.html
    // onboarding-weee-battery-checkbox) - ein FRÜHERES Interesse-Signal
    // als eine tatsächliche WEEE-/Batterie-Aktivierung (siehe GET
    // /admin/weee-battery-interest), zeigt also auch Interesse von
    // Kunden, die die neue Sparte noch nicht genutzt haben.
    addColumnIfMissing('customers', 'weee_battery_interest_declared', 'INTEGER NOT NULL DEFAULT 0');

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

    // Additiv, default 'packaging' - Rechtsänderungs-Radar deckt jetzt auch
    // WEEE/Batterie ab (siehe legal-watch.js), bestehende Funde bleiben
    // unverändert als 'packaging' zugeordnet.
    addColumnIfMissing('legal_watch_findings', 'stream', "TEXT NOT NULL DEFAULT 'packaging'");

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

    // Jede von Stripe erstellte Checkout-Session (siehe POST
    // /billing/create-checkout-session) - beantwortet "wie viele
    // registrierte Kunden erreichen die Stripe-Kasse und brechen DORT ab",
    // statt das nur zu vermuten. origin_country/is_eu werden beim Anlegen
    // vom Kunden übernommen (kein zusätzlicher Stripe-Aufruf nötig), damit
    // sich die Abbruchquote pro Land/EU-Nicht-EU auswerten lässt - z. B. um
    // zu prüfen, ob Besucher aus fernen Ländern (z. B. Japan) an der
    // Stripe-Kasse überproportional häufig abspringen.
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkout_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_session_id TEXT NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        plan TEXT,
        interval TEXT,
        origin_country TEXT,
        is_eu INTEGER,
        status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'completed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_checkout_sessions_customer_id ON checkout_sessions(customer_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_checkout_sessions_created_at ON checkout_sessions(created_at);`);

    // Bisher wurde NUR die Haupt-Abo-Kasse (plan_upgrade) hier geloggt -
    // Premium-Länder-Upgrade und Amazon-Zusatzmodul erzeugten zwar auch
    // eine Stripe-Checkout-Session, aber keine Zeile hier, waren also im
    // Checkout-Funnel unsichtbar. 'plan_upgrade' als Default hält die
    // Bedeutung bestehender Zeilen unverändert.
    addColumnIfMissing(
      'checkout_sessions',
      'type',
      "TEXT NOT NULL DEFAULT 'plan_upgrade'"
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
  init,
  DB_PATH
};
