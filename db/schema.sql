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
    DEFAULT (datetime('now'))
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
    DEFAULT 1
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
