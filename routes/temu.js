// routes/temu.js
//
// Temu Open Platform - anders als eMAG/Kaufland/WooCommerce reicht hier
// KEIN reines Kunden-Zugangsdatenpaar: Temu verlangt, dass der *Anbieter*
// der Integration (hier: Pack2EU) zuerst selbst eine App im Open Platform
// Seller Center registriert (App Key/Secret, über seller-eu.temu.com ->
// Open Platform -> Client-Verwaltung) - genau wie bei Amazon SP-API/LWA.
// Erst danach kann ein einzelner Kunde diese App für seinen eigenen Shop
// autorisieren und einen shop-spezifischen Access Token bekommen.
//
// Code liegt fertig bereit, ist aber erst nutzbar, sobald Pack2EU diese
// Entwickler-Registrierung bei Temu abgeschlossen hat (siehe
// requireTemuConfigured). Bis dahin bleibt diese Route inaktiv (503),
// ohne dass sonst etwas kaputtgeht - gleiches Prinzip wie routes/amazon.js.
//
// WICHTIG (Vertrauenswürdigkeit der Details): App Key/Secret-Flow,
// Methodenname "bg.open.accesstoken.create" und das allgemeine
// "method + signierte Parameter an einen einzigen Gateway-Endpunkt"-
// Schema stammen aus Dritt-Integratoren-Dokumentation, nicht aus Temus
// eigener (nur nach Registrierung einsehbarer) Doku unter partner.temu.com.
// TEMU_API_BASE_URL ist deshalb bewusst eine Pflicht-Umgebungsvariable statt
// einer hier geratenen festen URL - und die Signatur-Methode muss beim
// ersten echten Test gegen die eigene App-Registrierung verifiziert werden.
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUnclassifiedProduct, isSkuUnclassified } = require('../lib/marketplace-auto-sku');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('../lib/weee-battery-items');
const { normalizeCountryCode } = require('../lib/country-normalize');

const router = express.Router();

const OAUTH_STATE_TTL_MINUTES = 15;

function requireTemuConfigured(req, res, next) {
  if (!process.env.TEMU_APP_KEY || !process.env.TEMU_APP_SECRET || !process.env.TEMU_API_BASE_URL) {
    return res.status(503).json({ error: 'Temu-Integration wartet noch auf die eigene Entwickler-Registrierung von Pack2EU im Temu Open Platform.' });
  }
  next();
}

// Temu/PDD-typisches Signatur-Schema: alle Parameter (inkl. app_key,
// timestamp, type, ggf. access_token) alphabetisch nach Key sortiert,
// aneinandergehängt als "key1value1key2value2...", davor und danach der
// App Secret, dann HMAC-SHA256 - siehe Warnhinweis oben, unbedingt gegen
// die echte Doku nach Registrierung prüfen.
function signTemuRequest(params, appSecret) {
  const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const message = `${appSecret}${sorted}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(message).digest('hex').toUpperCase();
}

async function temuRequest({ method, accessToken, data }) {
  const params = {
    type: method,
    app_key: process.env.TEMU_APP_KEY,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: 'JSON',
    ...(accessToken ? { access_token: accessToken } : {})
  };
  const sign = signTemuRequest(params, process.env.TEMU_APP_SECRET);

  const response = await axios.post(process.env.TEMU_API_BASE_URL, {
    ...params,
    sign,
    ...(data ? { ...data } : {})
  }, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Pack2EU (Inhouse_development)' },
    timeout: 20000
  });

  if (response.data?.success === false) {
    throw new Error(response.data.error_msg || response.data.errorMsg || 'Temu meldet einen Fehler.');
  }

  return response.data;
}

// ============================================================
// 1. Temu-Verbindung starten (Shop-Autorisierung)
// ============================================================
router.get('/auth', requireAuth, requireTemuConfigured, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (customer_id, provider, state, expires_at)
    VALUES (?, 'temu', ?, ?)
  `).run(req.auth.userId, state, expiresAt);

  const authUrl = new URL('https://seller-eu.temu.com/open-platform/client-manage');
  authUrl.searchParams.set('app_key', process.env.TEMU_APP_KEY);
  authUrl.searchParams.set('state', state);
  if (process.env.TEMU_REDIRECT_URI) {
    authUrl.searchParams.set('redirect_uri', process.env.TEMU_REDIRECT_URI);
  }

  res.json({ url: authUrl.toString() });
});

// ============================================================
// 2. Temu Callback (liefert code für den Access-Token-Austausch)
// ============================================================
router.get('/callback', requireTemuConfigured, async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Fehlende Parameter.');

  try {
    const stateRow = db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND provider = 'temu'
    `).get(state);

    if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
      return res.status(400).send('❌ Verbindung abgelaufen oder ungültig - bitte erneut versuchen.');
    }

    const tokenData = await temuRequest({
      method: 'bg.open.accesstoken.create',
      data: { code }
    });

    const accessToken = tokenData.access_token || tokenData.accessToken;
    const shopId = tokenData.shop_id || tokenData.shopId || null;

    db.prepare(`
      UPDATE customers SET temu_access_token = ?, temu_shop_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(accessToken, shopId ? String(shopId) : null, stateRow.customer_id);

    db.prepare('DELETE FROM oauth_states WHERE id = ?').run(stateRow.id);

    res.send('✅ Temu erfolgreich verbunden! Du kannst dieses Fenster jetzt schließen.');
  } catch (err) {
    console.error('❌ Temu Auth Fehler:', err.response?.data || err.message);
    res.status(500).send('❌ Fehler bei der Temu-Verbindung.');
  }
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET temu_access_token = NULL, temu_shop_id = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 3. Temu-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, requireTemuConfigured, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.temu_access_token) {
      return res.status(400).json({ error: 'Temu nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND temu_product_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.temu_product_id] = s; });

    const data = await temuRequest({
      method: 'bg.order.list.get',
      accessToken: customer.temu_access_token,
      data: { page_number: 1, page_size: 100 }
    });

    const orders = data.order_list || data.orderList || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];
      let hasUnclassifiedItem = false;
      const weeeBatteryItemSets = [];

      (order.order_item_list || order.orderItemList || []).forEach(item => {
        const externalId = String(item.product_id ?? item.productId ?? '');
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
        } else if (externalId) {
          ensureUnclassifiedProduct(db, customer.id, {
            field: 'temu_product_id',
            externalId,
            name: item.product_name || item.productName
          });
        }
      });

      const destinationCountry = normalizeCountryCode(
        order.region_code,
        order.regionCode,
        order.country
      ) || 'DE';

      const orderId = String(order.parent_order_sn || order.parentOrderSn || order.order_sn || order.orderSn);

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, has_unclassified_items, weee_battery_items_json)
        VALUES (?, 'temu', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        orderId,
        JSON.stringify(order),
        destinationCountry,
        totalWeight,
        JSON.stringify(packagingMaterials),
        hasUnclassifiedItem ? 1 : 0,
        JSON.stringify(mergeWeeeBatteryItems(...weeeBatteryItemSets))
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ Temu Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Temu-Sync.' });
  }
});

// ============================================================
// 4. Temu-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, has_unclassified_items, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'temu'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Temu Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Temu-Bestellungen.' });
  }
});

module.exports = router;
