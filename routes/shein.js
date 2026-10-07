// routes/shein.js
//
// SHEIN Marketplace (Open Platform) - kein Pack2EU-weiter App-Key nötig
// wie bei Temu: der Kunde beantragt sich Open-Key-ID + Secret-Key selbst
// in seinem eigenen SHEIN Seller Hub (Personal Center -> Drittanbieter-
// Anwendungen -> offizielles Integrations-Plugin), bekommt beides per SMS
// zugeschickt und trägt sie hier ein - gleiches Self-Service-Prinzip wie
// bei Kaufland/eMAG.
//
// WICHTIG (noch nicht live verifiziert): die genaue API-Basis-URL und das
// Signatur-Schema (HMAC-SHA256 über Open-Key-ID + Timestamp + Random-Key +
// Pfad, getrennte US-/EU-/MENA-/LATAM-Endpunkte) stammen ausschließlich aus
// Dritt-Integratoren-Beschreibungen (z.B. Odoo-Connector), nicht aus SHEINs
// eigener Seller-Hub-Doku. Deshalb ist SHEIN_API_BASE_URL bewusst eine
// Pflicht-Umgebungsvariable statt einer hier geratenen festen URL - die
// Route bleibt inaktiv (503), bis sie gesetzt UND einmal gegen ein echtes
// Bella-Rosa-Konto getestet wurde. Gleiches Prinzip wie bei
// routes/amazon.js (Code fertig, wartet auf Freigabe/Verifizierung).
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUnclassifiedProduct, isSkuUnclassified } = require('../lib/marketplace-auto-sku');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('../lib/weee-battery-items');
const { normalizeCountryCode } = require('../lib/country-normalize');

const router = express.Router();

function requireSheinConfigured(req, res, next) {
  if (!process.env.SHEIN_API_BASE_URL) {
    return res.status(503).json({ error: 'SHEIN-Integration ist vorbereitet, aber noch nicht gegen ein echtes Konto verifiziert.' });
  }
  next();
}

function signSheinRequest({ openKeyId, secretKey, timestamp, path, randomKey }) {
  const message = `${openKeyId}&${timestamp}&${path}`;
  const key = `${secretKey}${randomKey}`;
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

async function sheinRequest({ openKeyId, secretKey, path, body }) {
  const timestamp = String(Date.now());
  const randomKey = crypto.randomBytes(8).toString('hex');
  const signature = signSheinRequest({ openKeyId, secretKey, timestamp, path, randomKey });

  const response = await axios.post(`${process.env.SHEIN_API_BASE_URL}${path}`, body || {}, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Pack2EU (Inhouse_development)',
      'x-lt-openKeyId': openKeyId,
      'x-lt-timestamp': timestamp,
      'x-lt-signature': `${randomKey}${Buffer.from(signature).toString('base64')}`
    },
    timeout: 20000
  });

  if (response.data?.code && String(response.data.code) !== '0') {
    throw new Error(response.data.msg || response.data.message || 'SHEIN meldet einen Fehler.');
  }

  return response.data;
}

// ============================================================
// 1. SHEIN-Zugangsdaten hinterlegen
// ============================================================
router.post('/connect', requireAuth, requireSheinConfigured, async (req, res) => {
  const openKeyId = String(req.body?.openKeyId || '').trim();
  const secretKey = String(req.body?.secretKey || '').trim();
  if (!openKeyId || !secretKey) {
    return res.status(400).json({ error: 'Open-Key-ID und Secret-Key sind erforderlich.' });
  }

  try {
    await sheinRequest({
      openKeyId, secretKey,
      path: '/open-api/order/list',
      body: { page: 1, pageSize: 1 }
    });
  } catch (err) {
    console.error('❌ SHEIN Verbindungstest fehlgeschlagen:', err.response?.data || err.message);
    return res.status(400).json({ error: 'Verbindung zu SHEIN fehlgeschlagen. Bitte Open-Key-ID und Secret-Key prüfen.' });
  }

  db.prepare(`
    UPDATE customers SET shein_open_key_id = ?, shein_secret_key = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(openKeyId, secretKey, req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET shein_open_key_id = NULL, shein_secret_key = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 2. SHEIN-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, requireSheinConfigured, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.shein_open_key_id || !customer?.shein_secret_key) {
      return res.status(400).json({ error: 'SHEIN nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND shein_product_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.shein_product_id] = s; });

    const data = await sheinRequest({
      openKeyId: customer.shein_open_key_id,
      secretKey: customer.shein_secret_key,
      path: '/open-api/order/list',
      body: { page: 1, pageSize: 100 }
    });

    const orders = data.info?.list || data.data?.list || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];
      let hasUnclassifiedItem = false;
      const weeeBatteryItemSets = [];

      (order.itemList || order.item_list || []).forEach(item => {
        const externalId = String(item.skuCode ?? item.sku_code ?? item.productId ?? '');
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
            field: 'shein_product_id',
            externalId,
            name: item.productName || item.product_name
          });
        }
      });

      const destinationCountry = normalizeCountryCode(
        order.countryCode,
        order.country_code,
        order.country
      ) || 'DE';

      const orderId = String(order.orderNo || order.order_no || order.orderId);

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, has_unclassified_items, weee_battery_items_json)
        VALUES (?, 'shein', ?, ?, ?, ?, ?, ?, ?)
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
    console.error('❌ SHEIN Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim SHEIN-Sync.' });
  }
});

// ============================================================
// 3. SHEIN-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, has_unclassified_items, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'shein'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ SHEIN Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der SHEIN-Bestellungen.' });
  }
});

module.exports = router;
