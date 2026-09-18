-- ================================================================
-- PACK2EU – BASISDATENBANKSCHEMA
-- ================================================================

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

  subscription_status TEXT NOT NULL DEFAULT 'inactive',

  shopify_shop_domain TEXT UNIQUE,

  shopify_access_token TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  updated_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  -- Vom Kunden gewählte Branche - steuert nur die vorgeschlagenen
  -- Produkt-Presets beim Onboarding, keine feste Kategorisierung.
  niche TEXT,

  -- Zeitpunkt, zu dem der Kunde das Erst-Onboarding abgeschlossen oder
  -- übersprungen hat. NULL = Onboarding beim nächsten Login noch anzeigen.
  onboarding_completed_at TEXT,

  -- 'monthly' | 'annual' - aus den Stripe-Checkout-Metadaten übernommen.
  -- Steuert zusammen mit "plan" den Bevollmächtigten-Bonus, siehe
  -- config/plans.js (getRepEntitlementCount).
  billing_interval TEXT,

  -- Vom Kunden gewählte Länder für den kostenlosen Bevollmächtigten-Bonus
  -- (Teilmenge von REP_ENTITLEMENT_COUNTRIES = ['DE','ES']), z. B. '["DE"]'.
  -- Die eigentliche Beauftragung/Bezahlung bei REP-Germany bzw. Heura ist
  -- Stand jetzt ein manueller Vorgang unseres Teams, kein automatisierter
  -- Zahlungsfluss - die tatsächlichen Anbieterkosten sind noch nicht
  -- verifiziert.
  rep_entitlement_choices_json TEXT
);


-- ================================================================
-- LÄNDER
-- ================================================================

CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY,

  name TEXT NOT NULL,

  register_body TEXT NOT NULL,

  labeling_reqs TEXT NOT NULL
    DEFAULT '[]',

  requirements_json TEXT NOT NULL
    DEFAULT '[]',

  labeling_json TEXT NOT NULL
    DEFAULT '[]',

  eco_fee TEXT,

  steps_json TEXT NOT NULL
    DEFAULT '[]',

  representative_required INTEGER
    NOT NULL DEFAULT 0,

  notary_required INTEGER
    NOT NULL DEFAULT 0,

  notary_cost TEXT,

  registration_url TEXT,

  representative_provider_name TEXT,

  representative_provider_url TEXT,

  representative_data_status TEXT NOT NULL
    DEFAULT 'needs_verification',

  flag TEXT DEFAULT '🌍',

  data_status TEXT NOT NULL
    DEFAULT 'needs_verification',

  -- Nur auf 0 gesetzt, wenn recherchiert bestätigt ist, dass das Land
  -- für Verpackungen aktuell überhaupt keine Registrierung/Bevollmächtigung
  -- verlangt (z. B. Schweiz, China, Thailand, Stand 08/2026) – NICHT
  -- gleichzusetzen mit "noch nicht recherchiert" (dafür gibt es data_status).
  registration_generally_required INTEGER NOT NULL
    DEFAULT 1,

  -- Wie oft die Verpackungsmengen an das Register/System gemeldet werden
  -- müssen: 'monthly' | 'quarterly' | 'annually' | 'needs_verification'.
  -- Bewusst konservativ: nur auf einen konkreten Wert gesetzt, wenn die
  -- Meldefrequenz für Produzenten (nicht nur die EU-weite Behörden-
  -- Berichtspflicht) recherchiert bestätigt ist - ein falscher Wert könnte
  -- zu einer verpassten echten Frist führen.
  reporting_frequency TEXT NOT NULL
    DEFAULT 'needs_verification',

  -- Grobe, recherchierte Lizenzentgelt-Sätze je Material in EUR/kg, z. B.
  -- {"papier": 0.15, "kunststoff": 0.38}. NUR Materialien mit recherchiert
  -- bestätigtem Satz sind enthalten - ein fehlender Schlüssel bedeutet
  -- "noch nicht recherchiert", NICHT "kostenlos". Dient nur der groben
  -- Kostenschätzung im Dashboard, keine verbindliche Preisauskunft.
  eco_fee_rates_json TEXT,

  -- Regel zur Berechnung des nächsten Melde-Stichtags, NUR gesetzt wenn ein
  -- konkreter Tag/Monat recherchiert bestätigt ist (nicht aus der bloßen
  -- reporting_frequency geraten - ein falsches Datum bei einer echten
  -- gesetzlichen Frist wäre gefährlicher als gar keine Anzeige):
  --   {"type":"annual","month":5,"day":15} - fester Tag im Jahr
  --   {"type":"periodic","period":"month"|"quarter","offsetDays":25} -
  --     N Tage nach Ende des Melde-Zeitraums (Monats-/Quartalsende)
  next_filing_rule_json TEXT
);


-- ================================================================
-- PFLICHTENSTROM-SPEZIFISCHE LÄNDERREGELN (WEEE, BATTERIE, ...)
--
-- Die bestehende countries-Tabelle trägt ihre Verpackungsregeln
-- (register_body, representative_required, eco_fee_rates_json, ...) als
-- feste Spalten direkt am Land - das bleibt für 'packaging' bewusst
-- unverändert (Live-Produktion, keine riskante Migration ohne Grund).
-- Für neue Pflichtenströme (WEEE, Batterie) gilt dieselbe Struktur, aber
-- pro (Land, Strom) statt pro Land - deshalb eine eigene Tabelle statt
-- weiterer countries-Spalten. Jede Zeile startet unrecherchiert
-- (data_status='needs_verification') - siehe legal-watch.js für die
-- Recherche-Pipeline, die hier künftig einträgt statt zu raten.
-- ================================================================

CREATE TABLE IF NOT EXISTS country_stream_rules (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  country_code TEXT NOT NULL
    REFERENCES countries(code),

  stream TEXT NOT NULL
    CHECK (stream IN ('weee', 'battery')),

  register_body TEXT,

  requirements_json TEXT NOT NULL
    DEFAULT '[]',

  labeling_json TEXT NOT NULL
    DEFAULT '[]',

  steps_json TEXT NOT NULL
    DEFAULT '[]',

  representative_required INTEGER
    NOT NULL DEFAULT 0,

  notary_required INTEGER
    NOT NULL DEFAULT 0,

  notary_cost TEXT,

  registration_url TEXT,

  representative_provider_name TEXT,

  representative_provider_url TEXT,

  representative_data_status TEXT NOT NULL
    DEFAULT 'needs_verification',

  data_status TEXT NOT NULL
    DEFAULT 'needs_verification',

  registration_generally_required INTEGER NOT NULL
    DEFAULT 1,

  -- Wie oft Stückzahlen/Kategorien gemeldet werden müssen - siehe
  -- countries.reporting_frequency-Kommentar für dieselbe Vorsichtsregel:
  -- nur ein konkreter Wert, wenn recherchiert bestätigt.
  reporting_frequency TEXT NOT NULL
    DEFAULT 'needs_verification',

  -- Grobe, recherchierte Gebühren-/Entgeltsätze - Struktur bewusst offen
  -- (JSON), da WEEE/Batterie meist nach Stückzahl/Kategorie statt nach
  -- Material/Gewicht abrechnen, anders als bei Verpackung.
  fee_rates_json TEXT,

  next_filing_rule_json TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  updated_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(country_code, stream)
);


-- ================================================================
-- WEEE-KATEGORIEN (Anhang III, Richtlinie 2012/19/EU)
--
-- Feste, EU-weit einheitliche Taxonomie - keine "recherchierten", pro
-- Land unterschiedlichen Fakten, sondern direkt aus dem Rechtstext.
-- ================================================================

CREATE TABLE IF NOT EXISTS weee_categories (

  code TEXT PRIMARY KEY,

  name_de TEXT NOT NULL,

  name_en TEXT NOT NULL,

  description TEXT
);


-- ================================================================
-- BATTERIE-KATEGORIEN (Art. 3, Verordnung (EU) 2023/1542)
--
-- Ebenfalls feste, EU-weit einheitliche Taxonomie direkt aus dem
-- Rechtstext.
-- ================================================================

CREATE TABLE IF NOT EXISTS battery_categories (

  code TEXT PRIMARY KEY,

  name_de TEXT NOT NULL,

  name_en TEXT NOT NULL,

  description TEXT
);


-- ================================================================
-- MATERIAL-LIZENZENTGELTE (für den Material-Spar-Rechner im
-- SKU-Editor - siehe lib/material-savings.js)
--
-- Anders als weee_categories/battery_categories KEINE feste
-- EU-Taxonomie, sondern geschätzte €/kg-Richtwerte je Material
-- (und bei Kunststoff je Subtyp) - die echten Lizenzentgelte
-- unterscheiden sich stark nach dualem System und Vertrag und
-- ändern sich jährlich. source bleibt deshalb bewusst 'estimate',
-- nie 'verified' (vgl. data_status-Konvention in country_stream_
-- rules) - jede Zeile ist über /admin/material-rates editierbar,
-- damit Kunden ihre echten Vertragssätze eintragen können.
-- ================================================================

CREATE TABLE IF NOT EXISTS material_license_rates (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  material TEXT NOT NULL,

  -- NULL für Materialien ohne Subtyp-Unterscheidung (papier, karton, ...)
  subtype TEXT,

  price_per_kg_eur REAL NOT NULL,

  source TEXT NOT NULL DEFAULT 'estimate',

  updated_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(material, subtype)
);


-- ================================================================
-- AKTIVIERUNGEN
-- ================================================================

CREATE TABLE IF NOT EXISTS activations (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  country_code TEXT NOT NULL
    REFERENCES countries(code),

  status TEXT NOT NULL
    DEFAULT 'pending',

  -- Händler besitzt bereits eine Nummer
  existing_number TEXT,

  -- Vorhandener Bevollmächtigter
  representative_name TEXT,

  representative_company TEXT,

  representative_email TEXT,

  -- Pack2EU Provider
  provider_id TEXT,

  provider_epr_number TEXT,

  provider_status TEXT
    DEFAULT 'pending',

  provider_data TEXT,

  provider_case_id TEXT,

  provider_error TEXT,

  -- Lappa
  lappa_representative_id TEXT,

  lappa_status TEXT
    DEFAULT 'pending',

  lappa_data TEXT,

  -- Compliance
  compliance_status TEXT,

  registration_status TEXT
    DEFAULT 'not_started',

  representative_status TEXT
    DEFAULT 'not_required',

  compliance_snapshot TEXT
    DEFAULT '{}',

  local_establishment INTEGER
    NOT NULL DEFAULT 0,

  -- Betriebsmodus
  mode TEXT
    DEFAULT 'grauzone',

  mode_updated_at TEXT,

  -- Signatur
  signed_at TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(customer_id, country_code)
);


-- ================================================================
-- COMPLIANCE CASES
-- ================================================================

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


-- ================================================================
-- PRODUKTE / VERPACKUNGEN
-- ================================================================

CREATE TABLE IF NOT EXISTS product_packaging (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  sku_name TEXT NOT NULL,

  icon TEXT,

  shopify_product_id TEXT,

  shopify_variant_id TEXT,

  destination TEXT,

  materials_json TEXT NOT NULL,

  total_weight_grams INTEGER NOT NULL,

  packaging_type TEXT,

  provider_codes_json TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  updated_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- PAKETGRÖSSEN (KUNDENINDIVIDUELL)
--
-- Größen-Presets für den Produkt-Konfigurator (z.B. "S – 240 g").
-- Die drei Standardgrößen S/M/L werden im Frontend immer angezeigt;
-- diese Tabelle enthält nur vom Kunden selbst hinzugefügte Größen.
-- ================================================================

CREATE TABLE IF NOT EXISTS customer_package_sizes (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  label TEXT NOT NULL,

  weight_grams INTEGER NOT NULL,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- BESTELLUNGEN (MANUELL ERFASST)
-- ================================================================

CREATE TABLE IF NOT EXISTS orders (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  user_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  shopify_order_id TEXT,

  destination_country TEXT NOT NULL,

  total_weight_grams REAL NOT NULL DEFAULT 0,

  packaging_data TEXT NOT NULL DEFAULT '[]',

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- SHOPIFY ORDERS
-- ================================================================

CREATE TABLE IF NOT EXISTS shopify_orders (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  shopify_order_id TEXT NOT NULL UNIQUE,

  order_data_json TEXT NOT NULL,

  destination_country TEXT NOT NULL,

  total_weight_grams INTEGER,

  packaging_data TEXT,

  submission_id INTEGER
    REFERENCES submissions(id),

  processed_at TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- MARKETPLACE ORDERS (Etsy, Kaufland, Amazon, eBay)
--
-- Gemeinsame Tabelle für alle Marktplätze außer Shopify (das hat mit
-- shopify_orders bereits eine eigene, etablierte Tabelle mit eigenen
-- Verbrauchern - hier absichtlich nicht angefasst, um dort nichts zu
-- riskieren). "platform" unterscheidet die Quelle, external_order_id
-- ist die ID des Marktplatzes selbst (je Plattform eindeutig).
-- ================================================================

CREATE TABLE IF NOT EXISTS marketplace_orders (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  platform TEXT NOT NULL
    CHECK (platform IN ('etsy', 'kaufland', 'amazon', 'ebay')),

  external_order_id TEXT NOT NULL,

  order_data_json TEXT,

  destination_country TEXT,

  total_weight_grams INTEGER NOT NULL
    DEFAULT 0,

  packaging_data TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(platform, external_order_id)
);


-- ================================================================
-- SUBMISSIONS
-- ================================================================

CREATE TABLE IF NOT EXISTS submissions (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  destination TEXT NOT NULL
    REFERENCES countries(code),

  length_cm REAL NOT NULL,

  width_cm REAL NOT NULL,

  height_cm REAL NOT NULL,

  materials_json TEXT NOT NULL,

  total_weight_kg REAL NOT NULL,

  status TEXT NOT NULL
    DEFAULT 'received',

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- SUPPORT-CHAT VERLAUF
--
-- Persistiert je Kunde die letzten Chat-Nachrichten mit dem KI-Support-
-- Bot - nur fuer den eigenen Verlauf beim naechsten Login, kein Team-
-- Zugriff/Auswertung vorgesehen.
-- ================================================================

CREATE TABLE IF NOT EXISTS support_messages (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant')),

  content TEXT NOT NULL,

  escalated INTEGER NOT NULL
    DEFAULT 0,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- VERBESSERUNGSVORSCHLAEGE (FEEDBACK)
--
-- Frei eingereichtes Feedback ueber den "Verbesserungsvorschlag"-Button.
-- Wird direkt bei der Einreichung per KI in spam / useful / very_useful
-- eingeordnet (category + reasoning) - bei useful/very_useful geht
-- zusaetzlich eine Benachrichtigung an FEEDBACK_WEBHOOK_URL raus (siehe
-- routes/feedback.js).
-- ================================================================

CREATE TABLE IF NOT EXISTS feedback (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  message TEXT NOT NULL,

  category TEXT
    CHECK (category IN ('spam', 'useful', 'very_useful') OR category IS NULL),

  ai_reasoning TEXT,

  notified INTEGER NOT NULL
    DEFAULT 0,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- BEVOLLMÄCHTIGTE
-- ================================================================

CREATE TABLE IF NOT EXISTS representatives (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  country_code TEXT NOT NULL
    REFERENCES countries(code),

  name TEXT NOT NULL,

  email TEXT UNIQUE NOT NULL,

  password_hash TEXT NOT NULL,

  company TEXT,

  active INTEGER NOT NULL
    DEFAULT 1,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- BEVOLLMÄCHTIGTE <-> KUNDEN-ZUWEISUNG
--
-- Ein Bevollmächtigter sieht ausschließlich Kunden, die ihm hier explizit
-- zugewiesen wurden - nicht automatisch "alle Kunden seines Landes". Die
-- Zuweisung wird ausschließlich von uns (Admin) gepflegt, siehe
-- routes/admin.js. Kein Self-Service für Bevollmächtigte.
-- ================================================================

CREATE TABLE IF NOT EXISTS representative_customer_assignments (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  representative_id INTEGER NOT NULL
    REFERENCES representatives(id)
    ON DELETE CASCADE,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  assigned_by TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(representative_id, customer_id)
);


-- ================================================================
-- BEVOLLMÄCHTIGTE – ZUGRIFFS-PROTOKOLL (AUDIT-LOG)
--
-- Jeder Datenzugriff eines Bevollmächtigten auf Kundendaten wird hier
-- protokolliert - wer hat wann welchen Kunden eingesehen. Wird nie vom
-- Bevollmächtigten selbst geschrieben, nur vom Backend beim Ausliefern
-- der Daten (siehe routes/representatives.js).
-- ================================================================

-- ================================================================
-- KUNDE <-> BEVOLLMÄCHTIGTER: VOM KUNDEN ANGEGEBENE VERBINDUNG
--
-- Der Kunde trägt beim Land-Aktivieren (falls "ich habe schon einen
-- Bevollmächtigten") dessen E-Mail an (activations.representative_email).
-- Ist diese E-Mail bereits ein bei uns aktiver, verifizierter
-- Bevollmächtigten-Account für genau dieses Land, wird automatisch
-- verbunden (status='matched', siehe routes/representatives.js:
-- syncCustomerRepresentativeRequest). Ist sie unbekannt, bleibt der
-- Eintrag 'pending' und taucht im Admin-Tool als Anfrage auf - bewusst
-- KEIN automatisches Anlegen+Einladen unbekannter Adressen (siehe
-- Sicherheitsbegründung in routes/representatives.js).
-- ================================================================

CREATE TABLE IF NOT EXISTS customer_representative_requests (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  country_code TEXT NOT NULL
    REFERENCES countries(code),

  -- Ein Bevollmächtigter deckt genau einen Pflichtenstrom pro Land ab -
  -- siehe country_stream_rules-Kommentar weiter oben.
  stream TEXT NOT NULL
    DEFAULT 'packaging',

  requested_email TEXT NOT NULL,

  status TEXT NOT NULL
    DEFAULT 'pending'
    CHECK (status IN ('pending', 'matched', 'rejected')),

  representative_id INTEGER
    REFERENCES representatives(id)
    ON DELETE SET NULL,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  updated_at TEXT NOT NULL
    DEFAULT (datetime('now')),

  UNIQUE(customer_id, country_code, stream)
);


CREATE TABLE IF NOT EXISTS representative_access_log (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  representative_id INTEGER NOT NULL
    REFERENCES representatives(id)
    ON DELETE CASCADE,

  customer_id INTEGER
    REFERENCES customers(id)
    ON DELETE SET NULL,

  action TEXT NOT NULL,

  ip_address TEXT,

  created_at TEXT NOT NULL
    DEFAULT (datetime('now'))
);


-- ================================================================
-- OAUTH STATES
-- ================================================================

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


-- ================================================================
-- PROVIDER TRANSACTIONS
-- ================================================================

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


-- ================================================================
-- MONTHLY REPORTS
-- ================================================================

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

  UNIQUE(customer_id, country_code, period)
);


-- ================================================================
-- INDIzes
-- ================================================================

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
idx_compliance_cases_customer
ON compliance_cases(customer_id);

CREATE INDEX IF NOT EXISTS
idx_product_packaging_customer
ON product_packaging(customer_id);

CREATE INDEX IF NOT EXISTS
idx_shopify_orders_customer
ON shopify_orders(customer_id);

CREATE INDEX IF NOT EXISTS
idx_orders_user_year
ON orders(user_id, created_at);

CREATE INDEX IF NOT EXISTS
idx_customer_package_sizes_customer
ON customer_package_sizes(customer_id);

CREATE INDEX IF NOT EXISTS
idx_support_messages_customer
ON support_messages(customer_id);

CREATE INDEX IF NOT EXISTS
idx_feedback_customer
ON feedback(customer_id);

CREATE INDEX IF NOT EXISTS
idx_marketplace_orders_customer
ON marketplace_orders(customer_id);
