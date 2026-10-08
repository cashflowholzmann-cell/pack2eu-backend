const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizeCountryCode } = require('../lib/country-normalize');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('../lib/weee-battery-items');
const { encrypt, decryptCustomerCredentials } = require('../lib/credential-crypto');
const { buildSkuMap, processOrderItems } = require('../lib/marketplace-order-import');

const router = express.Router();

const OAUTH_STATE_TTL_MINUTES = 10;

// ============================================================
// Shopify-Webhook-Signaturprüfung
//
// Alle Routen unter /api/shopify/webhook/* bekommen den rohen Body
// (siehe server.js, express.raw() vor express.json() - exakt das
// Stripe-Webhook-Muster). Ohne diese Prüfung könnte jeder gefälschte
// Bestell-/Datenschutz-Anfragen an die Endpunkte schicken - Shopifys
// App-Review testet das gezielt mit ungültigen Signaturen.
// ============================================================
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !hmacHeader || !Buffer.isBuffer(req.body)) {
    return res.status(401).send('Unauthorized');
  }

  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  const digestBuf = Buffer.from(digest);
  const headerBuf = Buffer.from(hmacHeader);
  const valid = digestBuf.length === headerBuf.length && crypto.timingSafeEqual(digestBuf, headerBuf);

  if (!valid) {
    console.error('❌ Shopify-Webhook: ungültige HMAC-Signatur.');
    return res.status(401).send('Unauthorized');
  }

  try {
    req.shopifyPayload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Ungültiges JSON.');
  }

  next();
}

// Normalisiert die vom Kunden eingegebene Shop-Adresse auf die reine
// *.myshopify.com-Domain, die die OAuth-URL braucht. Audit-Fund 10/2026:
// Shopifys neue Admin-Oberfläche zeigt Kunden standardmäßig KEINE
// myshopify.com-URL mehr an, sondern "admin.shopify.com/store/<handle>" -
// ein Kunde, der das aus seiner eigenen Adresszeile kopiert (naheliegend),
// bekam bisher eine kaputte "https://https://admin.shopify.com/..."-URL
// mit DNS-Fehler statt einer funktionierenden Verbindung.
function normalizeShopifyShop(raw) {
  const trimmed = String(raw || '').trim();

  const adminMatch = trimmed.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/i);
  if (adminMatch) return `${adminMatch[1]}.myshopify.com`;

  let shop = trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (shop && !shop.includes('.')) shop = `${shop}.myshopify.com`;
  return shop;
}

// ============================================================
// 1. Shopify OAuth – Händler autorisiert die App
// ============================================================
// requireAuth + oauth_states (statt der vorherigen fest verdrahteten
// Test-E-Mail im Callback) - identisches Muster wie Etsy/Amazon/eBay.
//
// Env-Var-Namen SHOPIFY_API_KEY/SHOPIFY_API_SECRET bewusst so (nicht
// SHOPIFY_CLIENT_ID/SECRET wie bei Etsy/Amazon) - folgt Shopifys eigener
// Terminologie ("API key"/"API secret key" im Partner Dashboard) und war
// bereits unter diesem Namen bei Render hinterlegt (Audit-Fund 10/2026:
// Code suchte nach SHOPIFY_CLIENT_ID, das es nie gab - deshalb lief die
// Verbindung trotz vorhandener, korrekter Zugangsdaten nie).
router.get('/auth', requireAuth, (req, res) => {
  const shop = normalizeShopifyShop(req.query.shop);
  if (!shop) return res.status(400).json({ error: 'Shop-Parameter fehlt.' });
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_REDIRECT_URI) {
    return res.status(503).json({ error: 'Shopify-Integration ist noch nicht konfiguriert (SHOPIFY_API_KEY/SHOPIFY_REDIRECT_URI fehlen).' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (customer_id, provider, state, shop_domain, expires_at)
    VALUES (?, 'shopify', ?, ?, ?)
  `).run(req.auth.userId, state, shop, expiresAt);

  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=read_products,read_orders&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}&state=${state}`;

  // JSON statt redirect: der Aufruf braucht den Bearer-Token, den eine
  // einfache Browser-Navigation nicht mitschicken kann. Das Frontend
  // ruft diese Route per fetch() auf und navigiert danach selbst zur
  // zurückgegebenen URL.
  res.json({ url: authUrl });
});

// ============================================================
// 2. Shopify OAuth Callback
// ============================================================
router.get('/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code || !state) return res.status(400).send('Fehlende Parameter.');

  try {
    const stateRow = db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND provider = 'shopify'
    `).get(state);

    if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
      return res.status(400).send('❌ Verbindung abgelaufen oder ungültig - bitte erneut versuchen.');
    }

    // expiring: 1 ist seit 2026 Pflicht - die Admin API lehnt die alten,
    // nie ablaufenden Offline-Tokens inzwischen ab ("Non-expiring access
    // tokens are no longer accepted"). Dafür liefert Shopify jetzt
    // zusätzlich einen refresh_token + expires_in (1h Gültigkeit des
    // Access Tokens, siehe ensureFreshShopifyToken unten).
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code: code,
      expiring: 1
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null;

    db.prepare(`
      UPDATE customers
      SET shopify_shop_domain = ?, shopify_access_token = ?, shopify_refresh_token = ?, shopify_token_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(shop, encrypt(access_token), encrypt(refresh_token || null), expiresAt, stateRow.customer_id);

    db.prepare('DELETE FROM oauth_states WHERE id = ?').run(stateRow.id);

    res.send('✅ Shopify erfolgreich verbunden! Du kannst dieses Fenster jetzt schließen.');
  } catch (err) {
    console.error('Shopify Auth Fehler:', err.response?.data || err.message);
    res.status(500).send('❌ Fehler bei der Shopify-Verbindung.');
  }
});

// Liefert einen gültigen Access Token zurück, erneuert ihn vorher per
// Refresh Token, falls er abgelaufen oder bald fällig ist (Access Token
// lebt laut Shopify nur 1h) - exakt dasselbe Muster wie bei Etsy/eBay
// (siehe routes/etsy.js, routes/ebay.js ensureFreshToken()). "customer"
// muss bereits per decryptCustomerCredentials() entschlüsselt sein.
async function ensureFreshShopifyToken(customer) {
  if (!customer.shopify_refresh_token) return customer.shopify_access_token;
  if (customer.shopify_token_expires_at && new Date(customer.shopify_token_expires_at) > new Date(Date.now() + 60000)) {
    return customer.shopify_access_token;
  }

  const response = await axios.post(`https://${customer.shopify_shop_domain}/admin/oauth/access_token`, {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    grant_type: 'refresh_token',
    refresh_token: customer.shopify_refresh_token
  });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = expires_in
    ? new Date(Date.now() + expires_in * 1000).toISOString()
    : null;

  db.prepare(`
    UPDATE customers SET shopify_access_token = ?, shopify_refresh_token = ?, shopify_token_expires_at = ? WHERE id = ?
  `).run(encrypt(access_token), encrypt(refresh_token || customer.shopify_refresh_token), expiresAt, customer.id);

  return access_token;
}

// ============================================================
// 3. Shopify Webhook – Neue Bestellung
// ============================================================
router.post('/webhook/orders/create', verifyShopifyWebhook, async (req, res) => {
  try {
    const order = req.shopifyPayload;
    const shopDomain = req.headers['x-shopify-shop-domain'];
    
    const customer = db.prepare('SELECT * FROM customers WHERE shopify_shop_domain = ?').get(shopDomain);
    if (!customer) {
      console.error(`Kein Kunde für Shop ${shopDomain} gefunden.`);
      return res.status(404).send('Kunde nicht gefunden.');
    }
    
    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ?
    `).all(customer.id);
    
    const skuMap = {};
    skus.forEach(s => {
      if (s.shopify_product_id) skuMap[s.shopify_product_id] = s;
    });
    
    let totalWeight = 0;
    const packagingMaterials = [];
    const weeeBatteryItemSets = [];

    order.line_items.forEach(item => {
      const sku = skuMap[item.product_id];
      if (sku) {
        const weight = sku.total_weight_grams * item.quantity;
        totalWeight += weight;
        weeeBatteryItemSets.push(extractWeeeBatteryItems(sku, item.quantity));
        const materials = JSON.parse(sku.materials_json);
        materials.forEach(m => {
          packagingMaterials.push({
            material: m.material,
            weight_grams: m.weight_grams * item.quantity,
            is_recyclable: m.is_recyclable
          });
        });
      }
    });
    
    const insert = db.prepare(`
      INSERT INTO shopify_orders
      (customer_id, shopify_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, weee_battery_items_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      customer.id,
      // String(): better-sqlite3 bindet JS-Zahlen als REAL, was die
      // TEXT-Spalte shopify_order_id sonst mit einem "2001.0"-Suffix
      // statt "2001" befüllt - bricht sonst stillschweigend jeden
      // späteren Abgleich per shopify_order_id (z. B. customers/redact).
      String(order.id),
      JSON.stringify(order),
      normalizeCountryCode(order.shipping_address?.country_code) || 'DE',
      totalWeight,
      JSON.stringify(packagingMaterials),
      JSON.stringify(mergeWeeeBatteryItems(...weeeBatteryItemSets))
    );
    
    console.log(`✅ Bestellung ${order.id} verarbeitet: ${totalWeight}g`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

// ============================================================
// 4-6. Shopify GDPR-Pflicht-Webhooks (App-Store-Voraussetzung)
//
// Shopify verlangt für jede öffentliche App genau diese drei Endpunkte,
// sonst wird die Freigabe verweigert. Alle drei laufen über dieselbe
// HMAC-Prüfung wie orders/create oben.
// ============================================================

// Entfernt personenbezogene Daten aus einer gespeicherten Bestellung,
// behält aber die für uns eigentlich relevanten, nicht-personenbezogenen
// Daten (Gewicht, Material, Zielland) - genau das, worum es bei einer
// Verpackungs-Compliance-Auswertung geht.
function redactOrderPII(orderJson) {
  const redacted = { ...orderJson };
  delete redacted.customer;
  delete redacted.email;
  delete redacted.contact_email;
  delete redacted.phone;
  delete redacted.note;
  delete redacted.browser_ip;
  delete redacted.client_details;
  delete redacted.customer_locale;
  if (redacted.shipping_address) {
    redacted.shipping_address = { country_code: redacted.shipping_address.country_code || null };
  }
  if (redacted.billing_address) {
    redacted.billing_address = { country_code: redacted.billing_address.country_code || null };
  }
  return redacted;
}

// Shop-Inhaber:in fordert die über eine:n Endkund:in gespeicherten Daten
// an. Wir führen kein eigenes Endkunden-Datenprofil - die relevanten
// Bestelldaten liegen in shopify_orders. Statt eines automatisierten
// Exports landet die Anfrage als Aufgabe im Admin-Dashboard (30 Tage
// Frist), damit sie manuell beantwortet werden kann.
router.post('/webhook/customers/data_request', verifyShopifyWebhook, (req, res) => {
  try {
    const { shop_domain, customer, orders_requested } = req.shopifyPayload || {};
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO admin_tasks (title, due_date, priority)
      VALUES (?, ?, 'high')
    `).run(
      `GPSR/DSGVO: Datenauskunft für ${customer?.email || 'Kunde ohne E-Mail'} (Shop ${shop_domain}, Bestellungen: ${(orders_requested || []).join(', ') || 'keine'}) anfordern und beantworten`,
      dueDate
    );

    console.log(`📋 Shopify customers/data_request: Aufgabe angelegt (Shop ${shop_domain}).`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Shopify customers/data_request Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

// Shop-Inhaber:in verlangt Löschung der Daten einer bestimmten
// Endkund:in - wir entfernen die PII aus den gespeicherten Bestellungen
// dieses Shops, behalten aber die anonymisierten Compliance-Daten.
router.post('/webhook/customers/redact', verifyShopifyWebhook, (req, res) => {
  try {
    const { shop_domain, orders_to_redact } = req.shopifyPayload || {};

    const customer = db.prepare('SELECT id FROM customers WHERE shopify_shop_domain = ?').get(shop_domain);
    if (!customer) {
      // Shop nicht (mehr) bei uns registriert - nichts zu redigieren.
      return res.status(200).send('OK');
    }

    const rows = Array.isArray(orders_to_redact) && orders_to_redact.length > 0
      ? db.prepare(`
          SELECT id, order_data_json FROM shopify_orders
          WHERE customer_id = ? AND shopify_order_id IN (${orders_to_redact.map(() => '?').join(',')})
        `).all(customer.id, ...orders_to_redact.map(String))
      : db.prepare('SELECT id, order_data_json FROM shopify_orders WHERE customer_id = ?').all(customer.id);

    const update = db.prepare('UPDATE shopify_orders SET order_data_json = ? WHERE id = ?');
    rows.forEach(row => {
      const redacted = redactOrderPII(JSON.parse(row.order_data_json));
      update.run(JSON.stringify(redacted), row.id);
    });

    console.log(`🗑️ Shopify customers/redact: ${rows.length} Bestellung(en) für Shop ${shop_domain} anonymisiert.`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Shopify customers/redact Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

// Shop wurde deinstalliert (Aufruf 48h danach) - komplette Löschung
// aller Shopify-spezifischen Daten für diesen Shop.
router.post('/webhook/shop/redact', verifyShopifyWebhook, (req, res) => {
  try {
    const { shop_domain } = req.shopifyPayload || {};

    const customer = db.prepare('SELECT id FROM customers WHERE shopify_shop_domain = ?').get(shop_domain);
    if (!customer) {
      return res.status(200).send('OK');
    }

    db.prepare('DELETE FROM shopify_orders WHERE customer_id = ?').run(customer.id);
    db.prepare(`
      UPDATE customers
      SET shopify_shop_domain = NULL, shopify_access_token = NULL, shopify_refresh_token = NULL, shopify_token_expires_at = NULL
      WHERE id = ?
    `).run(customer.id);

    console.log(`🗑️ Shopify shop/redact: alle Shopify-Daten für Shop ${shop_domain} gelöscht.`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Shopify shop/redact Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

// ============================================================
// Manueller Bestell-Sync (Übergangslösung)
//
// Shopify-Bestellungen sollen eigentlich automatisch per Webhook reinkommen
// (siehe POST /webhook/orders/create oben) - aber der Webhook lässt sich
// erst registrieren, sobald Shopify die "Protected customer data access"-
// Freigabe erteilt hat (Name/Adresse zählen als geschützte Kundendaten).
// Bis dahin holt dieser manuelle Sync dieselben Bestelldaten direkt per
// REST-Admin-API ab - exakt dasselbe Übergangsmuster wie bei jedem
// anderen Marktplatz-Connector (siehe lib/marketplace-order-import.js).
// Ob die Adressfelder ohne die Freigabe überhaupt befüllt zurückkommen
// oder von Shopify redigiert werden, ist zum Zeitpunkt der Implementierung
// NICHT verifiziert - erst der erste echte Sync gegen ein verbundenes
// Konto zeigt das.
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.shopify_access_token || !customer?.shopify_shop_domain) {
      return res.status(400).json({ error: 'Shopify nicht verbunden.' });
    }
    decryptCustomerCredentials(customer);
    const accessToken = await ensureFreshShopifyToken(customer);

    const skuMap = buildSkuMap(db, customer.id, 'shopify_product_id');

    const response = await axios.get(`https://${customer.shopify_shop_domain}/admin/api/2024-07/orders.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      params: { status: 'any', limit: 50 }
    });

    const orders = response.data?.orders || [];
    let imported = 0;

    for (const order of orders) {
      const { totalWeight, packagingMaterials, hasUnclassifiedItem, weeeBatteryItemsJson } = processOrderItems({
        db, customerId: customer.id, items: order.line_items, skuField: 'shopify_product_id', skuMap,
        getExternalId: item => String(item.product_id),
        getQuantity: item => item.quantity,
        getName: item => item.name
      });

      const result = db.prepare(`
        INSERT OR IGNORE INTO shopify_orders
        (customer_id, shopify_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, has_unclassified_items, weee_battery_items_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(order.id),
        JSON.stringify(order),
        normalizeCountryCode(order.shipping_address?.country_code) || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials),
        hasUnclassifiedItem ? 1 : 0,
        weeeBatteryItemsJson
      );
      if (result.changes > 0) imported++;
    }

    res.json({
      ok: true,
      imported,
      total: orders.length,
      // Diagnose-Info fürs Dashboard/die Konsole: zeigt, ob Shopify für die
      // zuletzt gesehene Bestellung tatsächlich eine Lieferadresse
      // geliefert hat - fehlt sie bei JEDER Bestellung, deutet das auf die
      // fehlende Protected-Customer-Data-Freigabe hin (Felder werden dann
      // redigiert/leer geliefert statt eines Fehlers).
      addressDataReceived: orders.some(o => o.shipping_address?.country_code)
    });
  } catch (err) {
    console.error('❌ Shopify Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Shopify-Sync.' });
  }
});

// Bestellungen des angemeldeten Händlers für das Dashboard.
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, shopify_order_id, destination_country, total_weight_grams,
             packaging_data, created_at
      FROM shopify_orders
      WHERE customer_id = ?
      ORDER BY created_at DESC
    `).all(req.auth.userId);

    res.json(orders);
  } catch (error) {
    console.error('Shopify Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Shopify-Bestellungen.' });
  }
});

// ============================================================
// 4. Shopify-Produkte abrufen
// ============================================================
router.get('/products', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.shopify_access_token) {
      return res.status(400).json({ error: 'Shopify nicht verbunden.' });
    }
    decryptCustomerCredentials(customer);
    const accessToken = await ensureFreshShopifyToken(customer);

    const response = await axios.get(`https://${customer.shopify_shop_domain}/admin/api/2024-07/products.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });

    // Normalisiertes Format {id, name, sku, image} - gleiche Form wie bei
    // jedem anderen Produkt-Picker-fähigen Connector (siehe routes/
    // woocommerce.js), damit das Dashboard EINE generische Liste/Verknüpfen-
    // Oberfläche für alle Plattformen nutzen kann, statt pro Plattform eine
    // eigene. Bei mehreren Varianten wird die erste SKU genommen (Pack2EU
    // kennt pro Artikel nur eine externe ID, keine Varianten-Hierarchie).
    const products = (response.data.products || []).map(p => ({
      id: String(p.id),
      name: p.title,
      sku: p.variants?.[0]?.sku || '',
      image: p.images?.[0]?.src || null
    }));

    res.json(products);
  } catch (err) {
    console.error('Shopify Produkte Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der Produkte.' });
  }
});

module.exports = router;
