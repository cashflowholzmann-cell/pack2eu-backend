// routes/emag.js
//
// eMAG Marketplace API (Dante International SA) - kein OAuth: der Kunde
// bekommt Username/Passwort für seinen eigenen eMAG-Verkäuferaccount von
// seinem eMAG-Account-Betreuer (siehe marketplace.emag.ro/infocenter) und
// trägt beides hier zusammen mit seinem Land ein - gleiches
// Self-Service-Prinzip wie bei Kaufland/WooCommerce, nur mit HTTP Basic
// Auth statt HMAC-Signatur. eMAG betreibt pro Land eine eigene
// Marketplace-Instanz mit eigener API-Basis-URL (RO/BG/HU).
//
// Wichtig (noch nicht an einem echten Konto verifiziert): die hier
// verwendeten Endpunkt-/Feldnamen (POST /order/read, isError/results,
// products[].product_id) stammen aus mehreren unabhängigen Dritt-
// Integrationen (Magento-/WooCommerce-Connectoren), nicht aus eMAGs
// eigener (nicht öffentlich erreichbarer) Doku. Beim ersten echten Sync
// für einen Kunden unbedingt die Rohantwort (order_data_json) prüfen,
// falls Länder/Artikel nicht wie erwartet ankommen.
const express = require('express');
const axios = require('axios');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUnclassifiedProduct, isSkuUnclassified } = require('../lib/marketplace-auto-sku');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('../lib/weee-battery-items');
const { normalizeCountryCode } = require('../lib/country-normalize');

const router = express.Router();

const EMAG_COUNTRY_TLDS = { RO: 'ro', BG: 'bg', HU: 'hu' };

function emagBaseUrl(country) {
  const tld = EMAG_COUNTRY_TLDS[String(country || '').toUpperCase()];
  if (!tld) return null;
  return `https://marketplace-api.emag.${tld}/api-3`;
}

async function emagRequest({ country, username, password, resource, body }) {
  const baseUrl = emagBaseUrl(country);
  if (!baseUrl) throw new Error('Ungültiges eMAG-Land (nur RO/BG/HU unterstützt).');

  const response = await axios.post(`${baseUrl}/${resource}`, body || { data: {} }, {
    auth: { username, password },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Pack2EU (Inhouse_development)' },
    timeout: 20000
  });

  if (response.data?.isError) {
    throw new Error((response.data.messages || []).join('; ') || 'eMAG meldet einen Fehler.');
  }

  return response.data;
}

// ============================================================
// 1. eMAG-Zugangsdaten hinterlegen
// ============================================================
router.post('/connect', requireAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const country = String(req.body?.country || '').trim().toUpperCase();

  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich.' });
  }
  if (!EMAG_COUNTRY_TLDS[country]) {
    return res.status(400).json({ error: 'Land muss RO, BG oder HU sein.' });
  }

  // Zugangsdaten gleich prüfen, statt erst beim nächsten Sync einen
  // vertippten Zugang zu bemerken (gleicher Grundsatz wie bei WooCommerce/
  // Kaufland).
  try {
    await emagRequest({
      country, username, password,
      resource: 'order/read',
      body: { data: { currentPage: 1, itemsPerPage: 1 } }
    });
  } catch (err) {
    console.error('❌ eMAG Verbindungstest fehlgeschlagen:', err.response?.data || err.message);
    return res.status(400).json({ error: 'Verbindung zu eMAG fehlgeschlagen. Bitte Benutzername, Passwort und Land prüfen.' });
  }

  db.prepare(`
    UPDATE customers SET emag_username = ?, emag_password = ?, emag_country = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(username, password, country, req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers SET emag_username = NULL, emag_password = NULL, emag_country = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);
  res.json({ ok: true });
});

// ============================================================
// 2. eMAG-Bestellungen synchronisieren
// ============================================================
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.emag_username || !customer?.emag_password || !customer?.emag_country) {
      return res.status(400).json({ error: 'eMAG nicht verbunden.' });
    }

    const skus = db.prepare('SELECT * FROM product_packaging WHERE customer_id = ? AND emag_product_id IS NOT NULL').all(customer.id);
    const skuMap = {};
    skus.forEach(s => { skuMap[s.emag_product_id] = s; });

    // Keine Paginierungs-Schleife (gleicher Umfang wie Kaufland/
    // WooCommerce) - die letzte Seite (100 Bestellungen) reicht für einen
    // laufenden Abgleich.
    const data = await emagRequest({
      country: customer.emag_country,
      username: customer.emag_username,
      password: customer.emag_password,
      resource: 'order/read',
      body: { data: { currentPage: 1, itemsPerPage: 100 } }
    });

    const orders = data.results || [];
    let imported = 0;

    for (const order of orders) {
      let totalWeight = 0;
      const packagingMaterials = [];
      let hasUnclassifiedItem = false;
      const weeeBatteryItemSets = [];

      (order.products || []).forEach(item => {
        const externalId = String(item.product_id ?? item.part_number ?? '');
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
          // Noch kein Pack2EU-Artikel für dieses eMAG-Produkt - einen
          // leeren Artikel anlegen (siehe lib/marketplace-auto-sku.js).
          ensureUnclassifiedProduct(db, customer.id, {
            field: 'emag_product_id',
            externalId,
            name: item.name
          });
        }
      });

      const destinationCountry = normalizeCountryCode(
        order.customer?.shipping_country,
        order.customer?.billing_country,
        customer.emag_country
      ) || customer.emag_country;

      const result = db.prepare(`
        INSERT OR IGNORE INTO marketplace_orders
        (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, has_unclassified_items, weee_battery_items_json)
        VALUES (?, 'emag', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        String(order.id),
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
    console.error('❌ eMAG Sync Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim eMAG-Sync.' });
  }
});

// ============================================================
// 3. eMAG-Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, external_order_id, destination_country, total_weight_grams, packaging_data, has_unclassified_items, created_at
      FROM marketplace_orders
      WHERE customer_id = ? AND platform = 'emag'
      ORDER BY created_at DESC
    `).all(req.auth.userId);
    res.json(orders);
  } catch (error) {
    console.error('❌ eMAG Bestellungen Fehler:', error.message);
    res.status(500).json({ error: 'Fehler beim Laden der eMAG-Bestellungen.' });
  }
});

module.exports = router;
