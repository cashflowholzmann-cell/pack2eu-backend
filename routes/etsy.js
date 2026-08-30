// routes/etsy.js
//
// Etsy Open API v3 - Verbindung per OAuth 2.0 + PKCE (von Etsy für jeden
// Authorization-Code-Flow verpflichtend vorgeschrieben, anders als bei
// Shopify). Der Kunde registriert dafür einmalig eine "Seller App" im
// Etsy Developer Portal (developers.etsy.com) und hinterlegt
// ETSY_CLIENT_ID/ETSY_CLIENT_SECRET/ETSY_REDIRECT_URI im Backend - erst
// dann funktioniert der Connect-Flow live.
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ETSY_AUTH_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_API_BASE = 'https://api.etsy.com/v3/application';
const OAUTH_STATE_TTL_MINUTES = 10;

function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

// ============================================================
// 1. Etsy OAuth - Verbindung starten
// ============================================================
router.get('/auth', requireAuth, (req, res) => {
  if (!process.env.ETSY_CLIENT_ID || !process.env.ETSY_REDIRECT_URI) {
    return res.status(503).json({ error: 'Etsy-Integration ist noch nicht konfiguriert (ETSY_CLIENT_ID/ETSY_REDIRECT_URI fehlen).' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (customer_id, provider, state, code_verifier, expires_at)
    VALUES (?, 'etsy', ?, ?, ?)
  `).run(req.auth.userId, state, codeVerifier, expiresAt);

  const authUrl = new URL(ETSY_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.ETSY_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', process.env.ETSY_REDIRECT_URI);
  // transactions_r: Bestellungen (Receipts) lesen. listings_r: Produkte
  // lesen (für die Verpackungs-Zuordnung).
  authUrl.searchParams.set('scope', 'transactions_r listings_r');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(authUrl.toString());
});

// ============================================================
// 2. Etsy OAuth Callback
// ============================================================
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Fehlende Parameter.');

  try {
    const stateRow = db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND provider = 'etsy'
    `).get(state);

    if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
      return res.status(400).send('❌ Verbindung abgelaufen oder ungültig - bitte erneut versuchen.');
    }

    const tokenResponse = await axios.post(ETSY_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: process.env.ETSY_CLIENT_ID,
      redirect_uri: process.env.ETSY_REDIRECT_URI,
      code,
      code_verifier: stateRow.code_verifier
    }, { headers: { 'Content-Type': 'application/json' } });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    // Etsy-Access-Tokens haben das Format "{etsy_user_id}.{token}".
    const etsyUserId = access_token.split('.')[0];

    const shopResponse = await axios.get(`${ETSY_API_BASE}/users/${etsyUserId}/shops`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'x-api-key': process.env.ETSY_CLIENT_ID
      }
    });
    const shopId = shopResponse.data?.shop_id;

    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    db.prepare(`
      UPDATE customers
      SET etsy_shop_id = ?, etsy_access_token = ?, etsy_refresh_token = ?, etsy_token_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(shopId ? String(shopId) : null, access_token, refresh_token, expiresAt, stateRow.customer_id);

    db.prepare('DELETE FROM oauth_states WHERE id = ?').run(stateRow.id);

    res.send('✅ Etsy erfolgreich verbunden! Du kannst dieses Fenster jetzt schließen.');
  } catch (err) {
    console.error('❌ Etsy Auth Fehler:', err.response?.data || err.message);
    res.status(500).send('❌ Fehler bei der Etsy-Verbindung.');
  }
});

async function ensureFreshToken(customer) {
  if (!customer.etsy_refresh_token) return customer.etsy_access_token;
  if (customer.etsy_token_expires_at && new Date(customer.etsy_token_expires_at) > new Date(Date.now() + 60000)) {
    return customer.etsy_access_token;
  }

  const response = await axios.post(ETSY_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: process.env.ETSY_CLIENT_ID,
    refresh_token: customer.etsy_refresh_token
  }, { headers: { 'Content-Type': 'application/json' } });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  db.prepare(`
    UPDATE customers SET etsy_access_token = ?, etsy_refresh_token = ?, etsy_token_expires_at = ? WHERE id = ?
  `).run(access_token, refresh_token, expiresAt, customer.id);

  return access_token;
}

// ============================================================
// 3. Etsy-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.etsy_shop_id || !customer?.etsy_access_token) {
      return res.status(400).json({ error: 'Etsy nicht verbunden.' });
    }

    const accessToken = await ensureFreshToken(customer);

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND etsy_listing_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.etsy_listing_id] = s; });

    const receiptsResponse = await axios.get(`${ETSY_API_BASE}/shops/${customer.etsy_shop_id}/receipts`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'x-api-key': process.env.ETSY_CLIENT_ID },
      params: { limit: 50 }
    });

    const receipts = receiptsResponse.data?.results || [];
    let imported = 0;

    for (const receipt of receipts) {
      let totalWeight = 0;
      const packagingMaterials = [];

      (receipt.transactions || []).forEach(tx => {
        const sku = skuMap[String(tx.listing_id)];
        if (sku) {
          const weight = sku.total_weight_grams * (tx.quantity || 1);
          totalWeight += weight;
          const materials = JSON.parse(sku.materials_json || '[]');
          materials.forEach(m => {
            packagingMaterials.push({
              material: m.material,
              weight_grams: m.weight_grams * (tx.quantity || 1),
              is_recyclable: m.is_recyclable
            });
          });
        }
      });

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data)
        VALUES (?, 'etsy', ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(receipt.receipt_id),
        JSON.stringify(receipt),
        receipt.country_iso || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials)
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: receipts.length });
  } catch (err) {
    console.error('❌ Etsy Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Etsy-Sync.' });
  }
});

// ============================================================
// 4. Etsy-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'etsy'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Etsy Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Etsy-Bestellungen.' });
  }
});

module.exports = router;
