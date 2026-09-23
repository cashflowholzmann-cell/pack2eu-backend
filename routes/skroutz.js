// routes/skroutz.js
//
// Skroutz Marketplace ("Smart Cart") - größte E-Commerce-Plattform
// Griechenlands (laut Similarweb ~46 Mio. Besuche/Monat, Stand 07/2026).
// Kein OAuth: der Händler generiert sich selbst einen API-Token in seinem
// eigenen Skroutz-Händler-Panel (Merchants > Services > Skroutz Marketplace)
// und trägt ihn hier ein - gleiches Prinzip wie bei Kaufland.
//
// Besonderheit gegenüber Shopify/Etsy/Kaufland: Skroutz schickt Webhooks
// OHNE jede Signatur/HMAC (laut offizieller Doku, developer.skroutz.gr/
// smart_cart/orders_webhook) - nur eine IP-Allowlist wird empfohlen, die
// hinter Cloud-Hosting (Render etc.) ohnehin kaum zuverlässig prüfbar ist.
// Der Webhook-Body wird deshalb NIE direkt übernommen, sondern nur als
// Trigger benutzt: wir holen die eigentlichen Bestelldaten per GET mit dem
// gespeicherten Bearer-Token des jeweiligen Kunden erneut ab. Das schützt
// gleich doppelt - ein gefälschter Webhook-Aufruf für eine fremde
// customerId würde mit DEREN Token versuchen, eine Bestellung abzurufen,
// die gar nicht zu deren Shop gehört, und bekäme von Skroutz selbst eine
// Fehlermeldung.
//
// Skroutz bietet laut Doku keinen Listen-Endpunkt für "alle Bestellungen"
// (nur GET /merchants/ecommerce/orders/:code für eine einzelne, per
// Webhook bekanntgegebene Bestellung) - ein manueller Bulk-Sync wie bei
// Etsy/Kaufland ist damit nicht möglich, der Webhook ist der einzige Weg.
const express = require('express');
const axios = require('axios');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SKROUTZ_API_BASE = 'https://api.skroutz.gr';
const SKROUTZ_ACCEPT_HEADER = 'application/vnd.skroutz+json; version=3.0';

function skroutzRequest({ method, path, apiToken }) {
  return axios({
    method,
    url: `${SKROUTZ_API_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: SKROUTZ_ACCEPT_HEADER
    }
  });
}

// ============================================================
// 1. Skroutz-API-Token hinterlegen
// ============================================================
router.post('/connect', requireAuth, (req, res) => {
  const { apiToken } = req.body || {};
  if (!apiToken) {
    return res.status(400).json({ error: 'API-Token ist erforderlich.' });
  }

  db.prepare(`
    UPDATE customers SET skroutz_api_token = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(apiToken.trim(), req.auth.userId);

  const appUrl = process.env.APP_URL || 'https://www.pack2eu.global';
  res.json({
    ok: true,
    webhookUrl: `${appUrl}/api/skroutz/webhook/${req.auth.userId}`
  });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET skroutz_api_token = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// Zeigt die eigene Webhook-URL erneut an (z.B. falls der Kunde sie beim
// ersten Verbinden nicht kopiert hat) - ohne den Token neu einzugeben.
router.get('/webhook-url', requireAuth, (req, res) => {
  const appUrl = process.env.APP_URL || 'https://www.pack2eu.global';
  res.json({ webhookUrl: `${appUrl}/api/skroutz/webhook/${req.auth.userId}` });
});

// ============================================================
// 2. Skroutz-Webhook: neue Bestellung
//
// Öffentlich erreichbar (kein requireAuth) - Skroutz selbst ruft das auf.
// Die customerId steckt im Pfad, weil jeder Händler in seinem eigenen
// Skroutz-Panel eine eigene, feste Webhook-URL hinterlegt (kein OAuth-
// Redirect wie bei Etsy, das die Zuordnung sonst übernehmen würde).
// ============================================================
router.post('/webhook/:customerId', async (req, res) => {
  const customerId = Number(req.params.customerId);
  const { event_type: eventType, order } = req.body || {};

  // Immer schnell 200 antworten, außer bei echten (evtl. vorübergehenden)
  // Fehlern - Skroutz wiederholt sonst bis zu 4x über 20 Minuten.
  if (!Number.isInteger(customerId) || !order?.code) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  if (eventType !== 'new_order') {
    // order_updated (Stornos, Statuswechsel etc.) wird bewusst nicht
    // verarbeitet - für die Verpackungs-Compliance zählt nur, dass die
    // Bestellung existiert hat, nicht ihr späterer Versandstatus.
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer?.skroutz_api_token) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ? AND skroutz_shop_uid IS NOT NULL
    `).all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.skroutz_shop_uid] = s; });

    // Bestelldaten NICHT aus dem Webhook-Body übernehmen (keine
    // Signaturprüfung möglich), sondern authentifiziert neu abrufen.
    const response = await skroutzRequest({
      method: 'GET',
      path: `/merchants/ecommerce/orders/${order.code}`,
      apiToken: customer.skroutz_api_token
    });
    const fullOrder = response.data?.order || response.data;

    let totalWeight = 0;
    const packagingMaterials = [];
    (fullOrder.line_items || []).forEach(item => {
      const sku = skuMap[String(item.shop_uid)];
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

    db.prepare(`
      INSERT OR IGNORE INTO marketplace_orders
      (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, fulfillment_type)
      VALUES (?, 'skroutz', ?, ?, ?, ?, ?, ?)
    `).run(
      customer.id,
      String(fullOrder.code),
      JSON.stringify(fullOrder),
      fullOrder.customer?.address?.country_code || 'GR',
      totalWeight,
      JSON.stringify(packagingMaterials),
      // order.fulfilled_by_skroutz laut offiziellem Order-Objekt-Schema
      // (developer.skroutz.gr/smart_cart/_order_object) - FBS: Skroutz
      // übernimmt Lagerung/Versand, sonst versendet der Händler selbst.
      fullOrder.fulfilled_by_skroutz ? 'fbs' : 'direct'
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Skroutz Webhook Fehler:', err.response?.data || err.message);
    // 500, damit Skroutz bei einem echten (evtl. vorübergehenden) Fehler
    // automatisch erneut zustellt statt die Bestellung stillschweigend zu verlieren.
    res.status(500).json({ error: 'Fehler bei der Skroutz-Webhook-Verarbeitung.' });
  }
});

// ============================================================
// 3. Skroutz-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, fulfillment_type, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'skroutz'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Skroutz Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Skroutz-Bestellungen.' });
  }
});

module.exports = router;
