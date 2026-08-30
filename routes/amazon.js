// routes/amazon.js
//
// Amazon Selling Partner API (SP-API) - Code liegt fertig bereit, ist
// aber erst nutzbar, sobald Amazon die formale Entwickler-/Rollen-
// Freigabe erteilt hat (professioneller Verkäufer-Account, öffentliche
// Beschreibungs-Website, seit 2026 zusätzlich Abrechnungsdaten bei
// Amazon hinterlegt - siehe developer.amazonservices.com). Bis dahin
// bleibt diese Route inaktiv (503), ohne dass sonst etwas kaputtgeht.
//
// Auth läuft über "Login with Amazon" (LWA), keine AWS-SigV4-Signatur
// mehr nötig (das wurde von Amazon abgeschafft) - nur der LWA-Access-
// Token im Header "x-amz-access-token".
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
// EU-Endpunkt, da unsere Kunden aus/nach EU verkaufen. Bei Bedarf um
// weitere Regionen (NA/FE) erweiterbar.
const SP_API_BASE_URL = 'https://sellingpartnerapi-eu.amazon.com';
const OAUTH_STATE_TTL_MINUTES = 15;

function requireAmazonConfigured(req, res, next) {
  if (!process.env.AMAZON_LWA_CLIENT_ID || !process.env.AMAZON_LWA_CLIENT_SECRET || !process.env.AMAZON_APP_ID) {
    return res.status(503).json({ error: 'Amazon-Integration wartet noch auf die Entwickler-Freigabe durch Amazon.' });
  }
  next();
}

// Amazon ist (anders als Shopify/Etsy/Kaufland/eBay) für uns nicht
// kostenlos - deshalb erst nutzbar, wenn das kostenpflichtige Zusatzmodul
// gebucht ist (siehe routes/billing.js: /create-amazon-addon-session).
function requireAmazonAddon(req, res, next) {
  const customer = db.prepare('SELECT amazon_addon_active FROM customers WHERE id = ?').get(req.auth.userId);
  if (!customer?.amazon_addon_active) {
    return res.status(402).json({ error: 'Amazon ist ein kostenpflichtiges Zusatzmodul - bitte zuerst buchen.' });
  }
  next();
}

// ============================================================
// 1. Amazon-Verbindung starten (Seller Central Consent-Flow)
// ============================================================
router.get('/auth', requireAuth, requireAmazonAddon, requireAmazonConfigured, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO oauth_states (customer_id, provider, state, expires_at)
    VALUES (?, 'amazon', ?, ?)
  `).run(req.auth.userId, state, expiresAt);

  const authUrl = new URL('https://sellercentral.amazon.de/apps/authorize/consent');
  authUrl.searchParams.set('application_id', process.env.AMAZON_APP_ID);
  authUrl.searchParams.set('state', state);
  if (process.env.AMAZON_REDIRECT_URI) {
    authUrl.searchParams.set('redirect_uri', process.env.AMAZON_REDIRECT_URI);
  }

  // JSON statt redirect, siehe Kommentar in routes/etsy.js.
  res.json({ url: authUrl.toString() });
});

// ============================================================
// 2. Amazon Callback (liefert spapi_oauth_code + selling_partner_id)
// ============================================================
router.get('/callback', requireAmazonConfigured, async (req, res) => {
  const { spapi_oauth_code: code, state, selling_partner_id: sellingPartnerId } = req.query;
  if (!code || !state) return res.status(400).send('Fehlende Parameter.');

  try {
    const stateRow = db.prepare(`
      SELECT * FROM oauth_states WHERE state = ? AND provider = 'amazon'
    `).get(state);

    if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
      return res.status(400).send('❌ Verbindung abgelaufen oder ungültig - bitte erneut versuchen.');
    }

    const tokenResponse = await axios.post(LWA_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.AMAZON_LWA_CLIENT_ID,
      client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { refresh_token } = tokenResponse.data;

    db.prepare(`
      UPDATE customers
      SET amazon_selling_partner_id = ?, amazon_refresh_token = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(sellingPartnerId || null, refresh_token, stateRow.customer_id);

    db.prepare('DELETE FROM oauth_states WHERE id = ?').run(stateRow.id);

    res.send('✅ Amazon erfolgreich verbunden! Du kannst dieses Fenster jetzt schließen.');
  } catch (err) {
    console.error('❌ Amazon Auth Fehler:', err.response?.data || err.message);
    res.status(500).send('❌ Fehler bei der Amazon-Verbindung.');
  }
});

async function getAccessToken(refreshToken) {
  const response = await axios.post(LWA_TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.AMAZON_LWA_CLIENT_ID,
    client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return response.data.access_token;
}

// ============================================================
// 3. Amazon-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, requireAmazonAddon, requireAmazonConfigured, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.amazon_refresh_token) {
      return res.status(400).json({ error: 'Amazon nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND amazon_sku IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.amazon_sku] = s; });

    const accessToken = await getAccessToken(customer.amazon_refresh_token);

    const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ordersResponse = await axios.get(`${SP_API_BASE_URL}/orders/v0/orders`, {
      headers: { 'x-amz-access-token': accessToken },
      params: {
        MarketplaceIds: process.env.AMAZON_MARKETPLACE_IDS || 'A1PA6795UKMFR9', // Standard: Amazon.de
        CreatedAfter: createdAfter
      }
    });

    const orders = ordersResponse.data?.payload?.Orders || [];
    let imported = 0;

    for (const order of orders) {
      // SP-API liefert Artikel-Details über einen separaten Aufruf
      // (GetOrderItems) - hier bewusst schlank gehalten: Gewicht wird
      // aus den lokal hinterlegten Produkten anhand der Amazon-SKU
      // ermittelt, sobald der Kunde seine Artikel zugeordnet hat.
      let itemsResponse;
      try {
        itemsResponse = await axios.get(`${SP_API_BASE_URL}/orders/v0/orders/${order.AmazonOrderId}/orderItems`, {
          headers: { 'x-amz-access-token': accessToken }
        });
      } catch (itemErr) {
        continue;
      }

      let totalWeight = 0;
      const packagingMaterials = [];
      const items = itemsResponse.data?.payload?.OrderItems || [];

      items.forEach(item => {
        const sku = skuMap[item.SellerSKU];
        if (sku) {
          const qty = parseInt(item.QuantityOrdered, 10) || 1;
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
        VALUES (?, 'amazon', ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        order.AmazonOrderId,
        JSON.stringify(order),
        order.ShippingAddress?.CountryCode || 'DE',
        totalWeight,
        JSON.stringify(packagingMaterials)
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ Amazon Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Amazon-Sync.' });
  }
});

// ============================================================
// 4. Amazon-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'amazon'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Amazon Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Amazon-Bestellungen.' });
  }
});

module.exports = router;
