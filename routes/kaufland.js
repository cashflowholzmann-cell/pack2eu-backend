// routes/kaufland.js
//
// Kaufland Marketplace Seller API - kein OAuth: der Kunde erstellt in
// seinem eigenen Kaufland-Verkäuferkonto ein API-Zugangsdatenpaar
// (Client Key + Secret Key, siehe sellerapi.kaufland.com) und trägt es
// hier ein. Jede Anfrage muss laut Kaufland-Doku per HMAC-SHA256 signiert
// werden: HMAC(secretKey, "{method}\n{full_url}\n{body}\n{unix_timestamp}"),
// Base64-kodiert, in den Headern Shop-Client-Key/Shop-Timestamp/
// Shop-Signature.
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const KAUFLAND_BASE_URL = 'https://sellerapi.kaufland.com/v2';

function signKauflandRequest({ method, url, body, secretKey }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyString = body ? JSON.stringify(body) : '';
  const message = [method, url, bodyString, timestamp].join('\n');
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('base64');
  return { timestamp, signature, bodyString };
}

async function kauflandRequest({ method, path, clientKey, secretKey, body }) {
  const url = `${KAUFLAND_BASE_URL}${path}`;
  const { timestamp, signature, bodyString } = signKauflandRequest({ method, url, body, secretKey });

  return axios({
    method,
    url,
    data: bodyString || undefined,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Pack2EU (Inhouse_development)',
      'Shop-Client-Key': clientKey,
      'Shop-Timestamp': String(timestamp),
      'Shop-Signature': signature
    }
  });
}

// ============================================================
// 1. Kaufland-Zugangsdaten hinterlegen
// ============================================================
router.post('/connect', requireAuth, (req, res) => {
  const { clientKey, secretKey } = req.body || {};
  if (!clientKey || !secretKey) {
    return res.status(400).json({ error: 'Client Key und Secret Key sind erforderlich.' });
  }

  db.prepare(`
    UPDATE customers SET kaufland_client_key = ?, kaufland_secret_key = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(clientKey.trim(), secretKey.trim(), req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET kaufland_client_key = NULL, kaufland_secret_key = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 2. Kaufland-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.kaufland_client_key || !customer?.kaufland_secret_key) {
      return res.status(400).json({ error: 'Kaufland nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND kaufland_product_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.kaufland_product_id] = s; });

    const response = await kauflandRequest({
      method: 'GET',
      path: '/orders/',
      clientKey: customer.kaufland_client_key,
      secretKey: customer.kaufland_secret_key
    });

    const orders = response.data?.data || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];

      (order.units || order.order_units || []).forEach(unit => {
        const sku = skuMap[String(unit.storefront_product_id || unit.product_id)];
        if (sku) {
          const qty = unit.quantity || 1;
          const weight = sku.total_weight_grams * qty;
          totalWeight += weight;
          const materials = JSON.parse(sku.materials_json || '[]');
          materials.forEach(m => {
            packagingMaterials.push({
              material: m.material,
              weight_grams: m.weight_grams * qty,
              is_recyclable: m.is_recyclable
            });
          });
        }
      });

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data)
        VALUES (?, 'kaufland', ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(order.id || order.order_id),
        JSON.stringify(order),
        order.shipping_address?.country_iso || order.delivery_address?.country_code || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials)
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ Kaufland Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Kaufland-Sync.' });
  }
});

// ============================================================
// 3. Kaufland-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'kaufland'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Kaufland Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Kaufland-Bestellungen.' });
  }
});

module.exports = router;
