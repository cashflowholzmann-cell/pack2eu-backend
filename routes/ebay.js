// routes/ebay.js
//
// eBay Sell API - Code liegt fertig bereit, ist aber erst live nutzbar,
// sobald eBay den Antrag auf Produktions-Zugang (Sandbox funktioniert
// sofort, Produktion erfordert eine Prüfung durch eBay) genehmigt hat.
// Bis dahin bleibt diese Route inaktiv (503).
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_API_BASE = 'https://api.ebay.com';
const OAUTH_STATE_TTL_MINUTES = 10;
// RuName (eBay-Bezeichnung für die registrierte Redirect-URI) statt
// einer rohen URL - wird beim App-Setup im eBay Developer Portal vergeben.
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';

function requireEbayConfigured(req, res, next) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET || !process.env.EBAY_RUNAME) {
    return res.status(503).json({ error: 'eBay-Integration wartet noch auf die Produktions-Freigabe durch eBay.' });
  }
  next();
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
}

// ============================================================
// 1. eBay-Verbindung starten
// ============================================================
router.get('/auth', requireAuth, requireEbayConfigured, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (customer_id, provider, state, expires_at)
    VALUES (?, 'ebay', ?, ?)
  `).run(req.auth.userId, state, expiresAt);

  const authUrl = new URL(EBAY_AUTH_URL);
  authUrl.searchParams.set('client_id', process.env.EBAY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', process.env.EBAY_RUNAME);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', EBAY_SCOPES);
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});

// ============================================================
// 2. eBay OAuth Callback
// ============================================================
router.get('/callback', requireEbayConfigured, async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Fehlende Parameter.');

  try {
    const stateRow = db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND provider = 'ebay'
    `).get(state);

    if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
      return res.status(400).send('❌ Verbindung abgelaufen oder ungültig - bitte erneut versuchen.');
    }

    const tokenResponse = await axios.post(EBAY_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_RUNAME
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader()
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    db.prepare(`
      UPDATE customers
      SET ebay_access_token = ?, ebay_refresh_token = ?, ebay_token_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(access_token, refresh_token, expiresAt, stateRow.customer_id);

    db.prepare('DELETE FROM oauth_states WHERE id = ?').run(stateRow.id);

    res.send('✅ eBay erfolgreich verbunden! Du kannst dieses Fenster jetzt schließen.');
  } catch (err) {
    console.error('❌ eBay Auth Fehler:', err.response?.data || err.message);
    res.status(500).send('❌ Fehler bei der eBay-Verbindung.');
  }
});

async function ensureFreshToken(customer) {
  if (customer.ebay_token_expires_at && new Date(customer.ebay_token_expires_at) > new Date(Date.now() + 60000)) {
    return customer.ebay_access_token;
  }

  const response = await axios.post(EBAY_TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: customer.ebay_refresh_token,
    scope: EBAY_SCOPES
  }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader()
    }
  });

  const { access_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  db.prepare(`
    UPDATE customers SET ebay_access_token = ?, ebay_token_expires_at = ? WHERE id = ?
  `).run(access_token, expiresAt, customer.id);

  return access_token;
}

// ============================================================
// 3. eBay-Bestellungen synchronisieren (Fulfillment API)
// ============================================================
router.post('/sync', requireAuth, requireEbayConfigured, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.ebay_refresh_token) {
      return res.status(400).json({ error: 'eBay nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND ebay_item_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.ebay_item_id] = s; });

    const accessToken = await ensureFreshToken(customer);

    const ordersResponse = await axios.get(`${EBAY_API_BASE}/sell/fulfillment/v1/order`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE'
      },
      params: { limit: 50 }
    });

    const orders = ordersResponse.data?.orders || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];

      (order.lineItems || []).forEach(item => {
        const sku = skuMap[item.legacyItemId];
        if (sku) {
          const qty = item.quantity || 1;
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
        VALUES (?, 'ebay', ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        order.orderId,
        JSON.stringify(order),
        order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials)
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ eBay Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim eBay-Sync.' });
  }
});

// ============================================================
// 4. eBay-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'ebay'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ eBay Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der eBay-Bestellungen.' });
  }
});

module.exports = router;
