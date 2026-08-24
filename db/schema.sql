-- ================================================================
-- PACK2EU – DATENBANKSCHEMA
-- ================================================================


-- ================================================================
-- KUNDEN
-- ================================================================

CREATE TABLE IF NOT EXISTS customers (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number         TEXT UNIQUE NOT NULL,
  company_name            TEXT NOT NULL,
  origin_country          TEXT NOT NULL,
  contact_name            TEXT,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,

  plan                    TEXT NOT NULL DEFAULT 'M',

  is_eu                   INTEGER NOT NULL DEFAULT 1,

  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,

  subscription_status     TEXT NOT NULL DEFAULT 'inactive',

  shopify_shop_domain     TEXT UNIQUE,
  shopify_access_token    TEXT,

  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ================================================================
-- LÄNDER
-- ================================================================

CREATE TABLE IF NOT EXISTS countries (
  code                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  register_body         TEXT NOT NULL,

  labeling_reqs         TEXT NOT NULL DEFAULT '[]',

  requirements_json     TEXT NOT NULL DEFAULT '[]',
  labeling_json        TEXT NOT NULL DEFAULT '[]',

  eco_fee               TEXT,

  steps_json            TEXT NOT NULL DEFAULT '[]',

  representative_required INTEGER DEFAULT 0,

  notary_required       INTEGER DEFAULT 0,

  notary_cost           TEXT,

  registration_url      TEXT,

  flag                  TEXT DEFAULT '🇪🇺'
);


-- ================================================================
-- AKTIVIERUNGEN
-- ================================================================

CREATE TABLE IF NOT EXISTS activations (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id
    INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  country_code
    TEXT NOT NULL
    REFERENCES countries(code),

  status
    TEXT NOT NULL DEFAULT 'pending',

  -- --------------------------------------------------------------
  -- Bestehende EPR-Nummer des Händlers
  -- --------------------------------------------------------------

  existing_number TEXT,


  -- --------------------------------------------------------------
  -- Bereits vorhandener Bevollmächtigter
  -- --------------------------------------------------------------

  representative_name TEXT,

  representative_company TEXT,

  representative_email TEXT,


  -- --------------------------------------------------------------
  -- Provider / Pack2EU
  -- --------------------------------------------------------------

  provider_id TEXT,

  provider_epr_number TEXT,

  provider_status
    TEXT DEFAULT 'pending',

  provider_data TEXT,


  -- --------------------------------------------------------------
  -- Lappa
  -- --------------------------------------------------------------

  lappa_representative_id TEXT,

  lappa_status
    TEXT DEFAULT 'pending',

  lappa_data TEXT,


  -- --------------------------------------------------------------
  -- Betriebsmodus
  -- --------------------------------------------------------------

  mode
    TEXT DEFAULT 'grauzone',

  mode_updated_at TEXT,


  -- --------------------------------------------------------------
  -- Vollmacht
  -- --------------------------------------------------------------

  signed_at TEXT,


  -- --------------------------------------------------------------
  -- Zeitstempel
  -- --------------------------------------------------------------

  created_at
    TEXT NOT NULL DEFAULT (datetime('now')),


  UNIQUE(customer_id, country_code)
);


-- ================================================================
-- PRODUKT-VERPACKUNGS-SKUS
-- ================================================================

CREATE TABLE IF NOT EXISTS product_packaging (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id
    INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  sku_name TEXT NOT NULL,

  shopify_product_id TEXT,

  shopify_variant_id TEXT,

  materials_json TEXT NOT NULL,

  total_weight_grams INTEGER NOT NULL,

  packaging_type TEXT,

  provider_codes_json TEXT,

  created_at
    TEXT NOT NULL DEFAULT (datetime('now')),

  updated_at
    TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ================================================================
-- SHOPIFY-BESTELLUNGEN
-- ================================================================

CREATE TABLE IF NOT EXISTS shopify_orders (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id
    INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  shopify_order_id TEXT NOT NULL UNIQUE,

  order_data_json TEXT NOT NULL,

  destination_country TEXT NOT NULL,

  total_weight_grams INTEGER,

  packaging_data TEXT,

  submission_id
    INTEGER
    REFERENCES submissions(id),

  processed_at TEXT,

  created_at
    TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ================================================================
-- VERPACKUNGSMELDUNGEN
-- ================================================================

CREATE TABLE IF NOT EXISTS submissions (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  customer_id
    INTEGER NOT NULL
    REFERENCES customers(id)
    ON DELETE CASCADE,

  destination
    TEXT NOT NULL
    REFERENCES countries(code),

  length_cm REAL NOT NULL,

  width_cm REAL NOT NULL,

  height_cm REAL NOT NULL,

  materials_json TEXT NOT NULL,

  total_weight_kg REAL NOT NULL,

  status
    TEXT NOT NULL DEFAULT 'received',

  created_at
    TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ================================================================
-- BEVOLLMÄCHTIGTE / REPRESENTATIVES
-- ================================================================

CREATE TABLE IF NOT EXISTS representatives (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  country_code
    TEXT NOT NULL
    REFERENCES countries(code),

  name TEXT NOT NULL,

  email TEXT UNIQUE NOT NULL,

  password_hash TEXT NOT NULL,

  company TEXT,

  active
    INTEGER NOT NULL DEFAULT 1,

  created_at
    TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ================================================================
-- INDIZES
-- ================================================================

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
