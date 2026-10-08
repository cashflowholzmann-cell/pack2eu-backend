// routes/woocommerce.js
//
// WooCommerce REST API (https://{storeUrl}/wp-json/wc/v3/) - kein OAuth-
// Redirect: WooCommerce ist selbst gehostet (WordPress-Plugin), jeder
// Shop hat seine eigene URL. Der Kunde erzeugt sich selbst in seinem
// eigenen WordPress-Adminbereich (WooCommerce -> Einstellungen ->
// Erweitert -> REST-API) ein Consumer-Key/Secret-Paar und trägt beides
// hier zusammen mit der Shop-URL ein - gleiches Prinzip wie bei Kaufland
// (siehe routes/kaufland.js), nur mit Basic Auth statt HMAC-Signatur
// (WooCommerce selbst empfiehlt Consumer Key als Benutzername, Consumer
// Secret als Passwort bei HTTPS-Shops).
const express = require('express');
const axios = require('axios');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUnclassifiedProduct, isSkuUnclassified } = require('../lib/marketplace-auto-sku');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('../lib/weee-battery-items');
const { normalizeCountryCode } = require('../lib/country-normalize');

const router = express.Router();

// Entfernt einen eingegebenen Schrägstrich am Ende und ergänzt https://,
// falls der Kunde nur "meinshop.de" statt der vollen URL einträgt -
// WooCommerce-Shops sind praktisch immer HTTPS (Voraussetzung für Basic
// Auth laut WooCommerce-eigener Doku).
function normalizeStoreUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

async function woocommerceRequest({ storeUrl, consumerKey, consumerSecret, path, params }) {
  return axios({
    method: 'GET',
    url: `${storeUrl}/wp-json/wc/v3${path}`,
    params,
    auth: { username: consumerKey, password: consumerSecret },
    headers: { Accept: 'application/json', 'User-Agent': 'Pack2EU (Inhouse_development)' },
    timeout: 20000
  });
}

// ============================================================
// 1. WooCommerce-Zugangsdaten hinterlegen
// ============================================================
router.post('/connect', requireAuth, async (req, res) => {
  const storeUrl = normalizeStoreUrl(req.body?.storeUrl);
  const consumerKey = String(req.body?.consumerKey || '').trim();
  const consumerSecret = String(req.body?.consumerSecret || '').trim();
  if (!storeUrl || !consumerKey || !consumerSecret) {
    return res.status(400).json({ error: 'Shop-URL, Consumer Key und Consumer Secret sind erforderlich.' });
  }

  // Zugangsdaten gleich prüfen, statt erst beim nächsten Sync einen
  // vertippten Key/eine falsche URL zu bemerken - derselbe Grundsatz wie
  // bei den Shopify/Etsy-OAuth-Flows, die sofort einen gültigen Token
  // brauchen, um überhaupt weiterzukommen.
  try {
    await woocommerceRequest({ storeUrl, consumerKey, consumerSecret, path: '/orders', params: { per_page: 1 } });
  } catch (err) {
    console.error('❌ WooCommerce Verbindungstest fehlgeschlagen:', err.response?.data || err.message);
    return res.status(400).json({ error: 'Verbindung zu WooCommerce fehlgeschlagen. Bitte Shop-URL, Consumer Key und Consumer Secret prüfen.' });
  }

  db.prepare(`
    UPDATE customers SET woocommerce_store_url = ?, woocommerce_consumer_key = ?, woocommerce_consumer_secret = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(storeUrl, consumerKey, consumerSecret, req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET woocommerce_store_url = NULL, woocommerce_consumer_key = NULL, woocommerce_consumer_secret = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 2. WooCommerce-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.woocommerce_store_url || !customer?.woocommerce_consumer_key || !customer?.woocommerce_consumer_secret) {
      return res.status(400).json({ error: 'WooCommerce nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND woocommerce_product_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.woocommerce_product_id] = s; });

    // Keine Paginierungs-Schleife (gleicher Umfang wie der bestehende
    // Kaufland-Sync) - die letzten 100 Bestellungen reichen für einen
    // laufenden Abgleich, ältere Bestellungen werden ohnehin nicht
    // rückwirkend gemeldet.
    const response = await woocommerceRequest({
      storeUrl: customer.woocommerce_store_url,
      consumerKey: customer.woocommerce_consumer_key,
      consumerSecret: customer.woocommerce_consumer_secret,
      path: '/orders',
      params: { per_page: 100, orderby: 'date', order: 'desc' }
    });

    const orders = response.data || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];
      let hasUnclassifiedItem = false;
      const weeeBatteryItemSets = [];

      (order.line_items || []).forEach(item => {
        const externalId = String(item.product_id);
        const sku = skuMap[externalId];
        if (isSkuUnclassified(sku)) hasUnclassifiedItem = true;
        if (sku) {
          const qty = item.quantity || 1;
          const weight = sku.total_weight_grams * qty;
          totalWeight += weight;
          weeeBatteryItemSets.push(extractWeeeBatteryItems(sku, qty));
          const materials = JSON.parse(sku.materials_json || '[]');
          materials.forEach(m => {
            packagingMaterials.push({
              material: m.material,
              weight_grams: m.weight_grams * qty,
              is_recyclable: m.is_recyclable
            });
          });
        } else {
          // Noch kein Pack2EU-Artikel für dieses WooCommerce-Produkt -
          // einen leeren Artikel anlegen (siehe lib/marketplace-auto-sku.js).
          ensureUnclassifiedProduct(db, customer.id, {
            field: 'woocommerce_product_id',
            externalId,
            name: item.name
          });
        }
      });

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, has_unclassified_items, weee_battery_items_json)
        VALUES (?, 'woocommerce', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(order.id),
        JSON.stringify(order),
        normalizeCountryCode(order.shipping?.country, order.billing?.country) || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials),
        hasUnclassifiedItem ? 1 : 0,
        JSON.stringify(mergeWeeeBatteryItems(...weeeBatteryItemSets))
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ WooCommerce Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim WooCommerce-Sync.' });
  }
});

// ============================================================
// 3. WooCommerce-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, has_unclassified_items, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'woocommerce'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ WooCommerce Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der WooCommerce-Bestellungen.' });
  }
});

// ============================================================
// 4. WooCommerce-Produkte fürs Dashboard (Produkt-Picker)
// ============================================================
// Normalisiertes Format {id, name, sku, image} - identisch zu routes/
// shopify.js, damit das Dashboard EINE generische Produkt-Verknüpfen-
// Oberfläche für alle Produkt-Picker-fähigen Plattformen nutzen kann.
router.get('/products', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.woocommerce_store_url || !customer?.woocommerce_consumer_key || !customer?.woocommerce_consumer_secret) {
      return res.status(400).json({ error: 'WooCommerce nicht verbunden.' });
    }

    const response = await woocommerceRequest({
      storeUrl: customer.woocommerce_store_url,
      consumerKey: customer.woocommerce_consumer_key,
      consumerSecret: customer.woocommerce_consumer_secret,
      path: '/products',
      params: { per_page: 100 }
    });

    const products = (response.data || []).map(p => ({
      id: String(p.id),
      name: p.name,
      sku: p.sku || '',
      image: p.images?.[0]?.src || null
    }));

    res.json(products);
  } catch (err) {
    console.error('❌ WooCommerce Produkte Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der WooCommerce-Produkte.' });
  }
});

module.exports = router;
