// routes/baselinker.js
//
// Base.com (ehemals BaseLinker) - Multi-Channel-Management-Plattform, die
// mehrere Verkaufskanäle (Shopify, WooCommerce, Amazon, eBay, Skroutz,
// eMAG, ...) an einer Stelle bündelt. Für Kunden, die Base bereits nutzen,
// deckt EINE Anbindung hier potenziell mehrere ihrer Verkaufskanäle auf
// einmal ab.
//
// Kein OAuth: der Kunde generiert sich selbst einen API-Token in seinem
// Base-Konto (Account & other -> My account -> API) und trägt ihn hier
// ein - gleiches Prinzip wie bei Kaufland/Skroutz. Auth per
// X-BLToken-Header, ein einzelner Endpunkt (connector.php) mit
// method+parameters, siehe api.baselinker.com.
//
// Base.com veröffentlicht kein offiziell dokumentiertes Webhook-Payload-
// Format (nur inoffizielle Hinweise aus der Entwickler-Community) - daher
// bewusst KEIN Webhook-Endpunkt hier, um kein rätselhaftes Format zu
// raten. Stattdessen Polling per getOrders, ausgelöst über einen
// manuellen "Sync"-Button im Dashboard (gleiches Prinzip wie Kaufland).
//
// Feld-Namen (order_id, order_source, delivery_country, products[].sku)
// stammen aus mehreren unabhängigen Quellen (offizielle Doku-Suche +
// Community-Wrapper-Bibliotheken), da api.baselinker.com selbst über
// den Netzwerk-Proxy dieser Umgebung nicht direkt abrufbar war - vor dem
// ersten echten Kunden-Sync unbedingt gegen eine echte Antwort verifizieren.
const express = require('express');
const axios = require('axios');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BASELINKER_API_URL = 'https://api.baselinker.com/connector.php';

async function baselinkerRequest({ method, parameters, apiToken }) {
  const body = new URLSearchParams();
  body.set('method', method);
  body.set('parameters', JSON.stringify(parameters || {}));
  return axios.post(BASELINKER_API_URL, body.toString(), {
    headers: {
      'X-BLToken': apiToken,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
}

// ============================================================
// 1. Base.com-API-Token hinterlegen
// ============================================================
router.post('/connect', requireAuth, (req, res) => {
  const { apiToken } = req.body || {};
  if (!apiToken) {
    return res.status(400).json({ error: 'API-Token ist erforderlich.' });
  }

  db.prepare(`
    UPDATE customers SET baselinker_api_token = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(apiToken.trim(), req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET baselinker_api_token = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 2. Bestellungen synchronisieren (Polling)
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.baselinker_api_token) {
      return res.status(400).json({ error: 'Base.com nicht verbunden.' });
    }

    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ? AND baselinker_sku IS NOT NULL
    `).all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.baselinker_sku] = s; });

    // Letzte 30 Tage - reicht für den laufenden Betrieb. Ein voller
    // Erstimport (älter) wäre ein Sonderfall, aktuell nicht gebaut.
    const dateFrom = Math.floor((Date.now() - 30 * 86400000) / 1000);
    const response = await baselinkerRequest({
      method: 'getOrders',
      parameters: { date_from: dateFrom, get_unconfirmed_orders: true },
      apiToken: customer.baselinker_api_token
    });

    if (response.data?.status !== 'SUCCESS') {
      throw new Error(response.data?.error_message || 'Unbekannter Fehler von Base.com.');
    }

    const orders = response.data.orders || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];

      (order.products || []).forEach(item => {
        const sku = skuMap[String(item.sku)];
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

      const destinationCountry = String(
        order.delivery_country || order.delivery_country_code || ''
      ).trim().toUpperCase() || null;

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, fulfillment_type)
        VALUES (?, 'baselinker', ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(order.order_id),
        JSON.stringify(order),
        destinationCountry,
        totalWeight,
        JSON.stringify(packagingMaterials),
        // fulfillment_type wird hier zweckentfremdet, um order_source zu
        // speichern (welcher Base-verbundene Kanal - Shopify/Amazon/
        // Skroutz/... - die Bestellung geliefert hat), da die Spalte
        // ohnehin nur ein generisches Klassifizierungs-Label ist.
        order.order_source || null
      );
      if (result.changes > 0) imported++;
    }

    res.json({ ok: true, imported, total: orders.length });
  } catch (err) {
    console.error('❌ Base.com Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Base.com-Sync.' });
  }
});

// ============================================================
// 3. Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data,
             fulfillment_type AS order_source, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'baselinker'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ Base.com Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der Base.com-Bestellungen.' });
  }
});

module.exports = router;
