// routes/baselinker.js
//
// Base.com (ehemals BaseLinker) – Bestellimport per API.
// Base liefert Produktgewichte in Kilogramm. Pack2EU speichert und zeigt
// Gewichte in Gramm an.
//
// Wichtig: Gibt es für eine SKU bereits Pack2EU-Verpackungsdaten, bleiben
// diese für die EPR-Berechnung maßgeblich. Gibt es keine passende Pack2EU-SKU,
// verwenden wir das von Base gelieferte Artikelgewicht als Fallback, damit
// importierte Bestellungen nicht mehr mit 0 g erscheinen.

const express = require('express');
const axios = require('axios');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizeCountryCode } = require('../lib/country-normalize');
const { buildSkuMap, processOrderItems, insertMarketplaceOrder } = require('../lib/marketplace-order-import');
const { encrypt, decryptCustomerCredentials } = require('../lib/credential-crypto');
const { linkSkuRow } = require('./skus');

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

/**
 * Base.com liefert das Artikelgewicht üblicherweise in kg.
 * Beispiel: "0.500" wird zu 500 Gramm.
 */
function baseWeightToGrams(weightKg) {
  const normalized = String(weightKg ?? '')
    .trim()
    .replace(',', '.');

  const weight = Number(normalized);

  if (!Number.isFinite(weight) || weight <= 0) {
    return 0;
  }

  return Math.round(weight * 1000);
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
    UPDATE customers
    SET baselinker_api_token = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(encrypt(apiToken.trim()), req.auth.userId);

  res.json({ ok: true });
});

router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare(`
    UPDATE customers
    SET baselinker_api_token = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.auth.userId);

  res.json({ ok: true });
});

// ============================================================
// 2. Bestellungen synchronisieren (Polling)
// ============================================================
//
// syncBaselinkerOrdersForCustomer() enthält die eigentliche Sync-Logik,
// losgelöst von req/res, damit sie sowohl vom manuellen "Sync"-Button
// (Route unten) als auch vom automatischen Hintergrund-Scheduler
// (lib/baselinker-scheduler.js) aufgerufen werden kann.
async function syncBaselinkerOrdersForCustomer(customer) {
    if (!customer?.baselinker_api_token) {
      throw new Error('Base.com nicht verbunden.');
    }
    decryptCustomerCredentials(customer);

    const skuMap = buildSkuMap(db, customer.id, 'baselinker_sku');

    // Importiert Bestellungen der letzten 30 Tage.
    const dateFrom = Math.floor((Date.now() - 30 * 86400000) / 1000);

    const response = await baselinkerRequest({
      method: 'getOrders',
      parameters: {
        date_from: dateFrom,
        get_unconfirmed_orders: true
      },
      apiToken: customer.baselinker_api_token
    });

    if (response.data?.status !== 'SUCCESS') {
      throw new Error(
        response.data?.error_message || 'Unbekannter Fehler von Base.com.'
      );
    }

    const orders = response.data.orders || [];
    let imported = 0;
    let skipped = 0;

    for (const order of orders) {
      // Audit-Fund: viele über Base/BaseLinker aggregierte Bestellungen
      // (z.B. aus Shops ohne eigene SKU-Pflege) liefern GAR KEIN item.sku -
      // Fallback auf den Artikelnamen als Schlüssel, matcht künftige
      // Bestellungen desselben Artikelnamens genauso automatisch wie eine
      // echte SKU.
      const { totalWeight, packagingMaterials, hasUnclassifiedItem, weeeBatteryItemsJson } = processOrderItems({
        db, customerId: customer.id, items: order.products, skuField: 'baselinker_sku', skuMap,
        getExternalId: item => String(item.sku || '').trim() || String(item.name || '').trim(),
        getQuantity: item => Number(item.quantity) > 0 ? Number(item.quantity) : 1,
        getName: item => item.name,
        // WICHTIG (Kundenmeldung): Base liefert hier ein Gewicht, das sich
        // i.d.R. auf das PRODUKT bezieht, nicht auf die Verpackung - es
        // darf deshalb NICHT als "sonstige"-Verpackungsgewicht in diese
        // Bestellung übernommen werden (würde die Öko-Gebühr-/Meldepflicht
        // auf Basis des falschen Gewichts verzerren). Bis der Nutzer den
        // Artikel klassifiziert, trägt diese Bestellung für dieses Item
        // also bewusst 0g bei - die Funktion speichert das Base-Gewicht nur
        // als unverbindliche Referenz (source_weight_grams), nie als
        // Verpackungsgewicht. Pro-Stück-Gewicht (nicht mit quantity
        // multipliziert) - der SKU-Editor bildet ein einzelnes Stück ab,
        // nicht die ganze Bestellposition.
        getFallbackWeightGrams: item => baseWeightToGrams(item.weight)
      });

      // delivery_country_code ist bei Base i.d.R. schon ein ISO-Code,
      // delivery_country dagegen Klartext (oft in der Sprache des
      // Marktplatzes) - Code zuerst versuchen, Klartext nur als Fallback
      // über die Namenszuordnung normalisieren. Vorher stand delivery_country
      // zuerst und wurde nur uppercase(), wodurch z.B. "Italy" als eigener
      // Report-Bucket "ITALY" neben "IT" landete statt normalisiert zu werden.
      const destinationCountry = normalizeCountryCode(
        order.delivery_country_code,
        order.delivery_country
      );

      // Kundenentscheidung (nach einem Vorfall, bei dem ein erneuter Sync
      // eine manuell korrigierte Bestellung wieder auf den falschen Stand
      // aus Base zurückgesetzt hat): ein Sync fasst eine bereits
      // importierte Bestellung GAR NICHT MEHR an, auch nicht ihre Metadaten
      // - er ergänzt ausschließlich neue, noch nicht bekannte Bestellungen
      // (Dedupe-Schlüssel: external_order_id, siehe insertMarketplaceOrder).
      // Identisch zum Verhalten aller anderen Marktplatz-Integrationen.
      // Ein falsches Anfangsgewicht/-Zielland wird über die Korrektur-
      // Maske behoben, nicht implizit durch einen künftigen Sync.
      const inserted = insertMarketplaceOrder(db, {
        customerId: customer.id,
        platform: 'baselinker',
        externalOrderId: String(order.order_id),
        orderData: order,
        destinationCountry,
        fulfillmentType: order.order_source || null,
        totalWeight, packagingMaterials, hasUnclassifiedItem, weeeBatteryItemsJson
      });

      if (inserted) imported++; else skipped++;
    }

    return { ok: true, imported, skipped, total: orders.length };
}

router.post('/sync', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare(`
      SELECT *
      FROM customers
      WHERE id = ?
    `).get(req.auth.userId);

    if (!customer?.baselinker_api_token) {
      return res.status(400).json({ error: 'Base.com nicht verbunden.' });
    }

    const result = await syncBaselinkerOrdersForCustomer(customer);
    res.json(result);
  } catch (err) {
    console.error(
      '❌ Base.com Sync Fehler:',
      err.response?.data || err.message
    );

    res.status(500).json({ error: 'Fehler beim Base.com-Sync.' });
  }
});

// ============================================================
// 3. Bestellungen fürs Dashboard
// ============================================================
router.get('/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT
        id,
        external_order_id,
        destination_country,
        total_weight_grams,
        packaging_data,
        fulfillment_type AS order_source,
        has_unclassified_items,
        created_at
      FROM marketplace_orders
      WHERE customer_id = ?
        AND platform = 'baselinker'
      ORDER BY created_at DESC
    `).all(req.auth.userId);

    res.json(orders);
  } catch (error) {
    console.error(
      '❌ Base.com Bestellungen Fehler:',
      error.message
    );

    res.status(500).json({
      error: 'Fehler beim Laden der Base.com-Bestellungen.'
    });
  }
});

// ============================================================
// 4. Base-Katalog: Varianten automatisch verknüpfen
// ============================================================
// Kundenwunsch: bei sehr vielen Farb-/Größenvarianten (z.B. Nagellack in
// mehreren Farben) soll Pack2EU die ohnehin in Base gepflegte
// Produkt->Varianten-Gruppierung nutzen, statt jede Variante einzeln oder
// per CSV verknüpfen zu müssen. Base führt das nativ: ein "Produkt" bündelt
// mehrere "Varianten", jede mit eigener SKU - genau diese Struktur bilden
// wir hier auf unsere bestehende linked_to_sku_id-Verknüpfung ab.
router.post('/sync-catalog-links', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.auth.userId);
    if (!customer?.baselinker_api_token) {
      return res.status(400).json({ error: 'Base.com nicht verbunden.' });
    }
    decryptCustomerCredentials(customer);

    const inventoriesResponse = await baselinkerRequest({
      method: 'getInventories',
      parameters: {},
      apiToken: customer.baselinker_api_token
    });
    if (inventoriesResponse.data?.status !== 'SUCCESS') {
      throw new Error(inventoriesResponse.data?.error_message || 'Unbekannter Fehler von Base.com.');
    }
    const inventories = inventoriesResponse.data.inventories || [];
    if (inventories.length === 0) {
      return res.status(400).json({ error: 'Kein Produktkatalog (Lager) in Base.com gefunden.' });
    }
    const inventoryId = inventories[0].inventory_id;

    // Alle Produkt-IDs des Katalogs sammeln (Base liefert max. 1000 pro Seite).
    const productIds = [];
    let page = 1;
    while (true) {
      const listResponse = await baselinkerRequest({
        method: 'getInventoryProductsList',
        parameters: { inventory_id: inventoryId, page },
        apiToken: customer.baselinker_api_token
      });
      if (listResponse.data?.status !== 'SUCCESS') {
        throw new Error(listResponse.data?.error_message || 'Unbekannter Fehler von Base.com.');
      }
      const pageProductIds = Object.keys(listResponse.data.products || {});
      if (pageProductIds.length === 0) break;
      productIds.push(...pageProductIds);
      if (pageProductIds.length < 1000) break;
      page++;
    }

    if (productIds.length === 0) {
      return res.json({
        ok: true,
        groups_found: 0,
        linked: 0,
        skipped: 0,
        errors: [],
        message: 'Keine Produkte im Base-Katalog gefunden.'
      });
    }

    // Volle Produktdaten inkl. Varianten in Batches zu je 1000 IDs laden.
    const productsById = {};
    for (let i = 0; i < productIds.length; i += 1000) {
      const batch = productIds.slice(i, i + 1000);
      const dataResponse = await baselinkerRequest({
        method: 'getInventoryProductsData',
        parameters: { inventory_id: inventoryId, products: batch },
        apiToken: customer.baselinker_api_token
      });
      if (dataResponse.data?.status !== 'SUCCESS') {
        throw new Error(dataResponse.data?.error_message || 'Unbekannter Fehler von Base.com.');
      }
      Object.assign(productsById, dataResponse.data.products || {});
    }

    // Pack2EU-SKUs des Kunden nach Base-SKU indizieren.
    const pack2euSkus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ? AND baselinker_sku IS NOT NULL
    `).all(customer.id);
    const pack2euByBaseSku = {};
    pack2euSkus.forEach((sku) => {
      const key = String(sku.baselinker_sku || '').trim();
      if (key) pack2euByBaseSku[key] = sku;
    });

    function isClassified(sku) {
      try {
        const materials = JSON.parse(sku.materials_json || '[]');
        return Array.isArray(materials) && materials.length > 0;
      } catch {
        return false;
      }
    }

    let groupsFound = 0;
    let linked = 0;
    let skipped = 0;
    const errors = [];

    Object.values(productsById).forEach((product) => {
      const variantEntries = Object.values(product.variants || {});
      // Nur echte Variantengruppen (>=2 Varianten) sind für uns relevant -
      // ein Produkt ohne Varianten gibt es nichts zu gruppieren.
      const memberBaseSkus = variantEntries
        .map((v) => String(v.sku || '').trim())
        .filter(Boolean);
      if (memberBaseSkus.length < 2) return;

      groupsFound++;

      const groupName = product.text_fields?.name || product.sku || String(product.id);
      const matchedSkus = memberBaseSkus.map((baseSku) => pack2euByBaseSku[baseSku]).filter(Boolean);
      if (matchedSkus.length < 2) {
        skipped++;
        return; // zu wenige bereits bekannte Pack2EU-Artikel in dieser Gruppe
      }

      // Hauptartikel-Kandidat: bereits klassifiziert und noch nicht
      // anderweitig verknüpft. Lieber nichts verknüpfen als falsch
      // zusammenführen, wenn die Gruppe uneindeutig ist.
      const candidates = matchedSkus.filter((s) => isClassified(s) && !s.linked_to_sku_id);

      if (candidates.length === 0) {
        skipped++;
        errors.push({ group: groupName, error: 'Keine klassifizierte Variante in dieser Gruppe gefunden - bitte zuerst eine Variante manuell klassifizieren.' });
        return;
      }

      if (candidates.length > 1) {
        const distinctWeights = new Set(candidates.map((c) => c.total_weight_grams));
        if (distinctWeights.size > 1) {
          skipped++;
          errors.push({ group: groupName, error: 'Mehrere unterschiedlich klassifizierte Varianten gefunden - bitte manuell prüfen.' });
          return;
        }
      }

      const mainSku = candidates[0];
      matchedSkus.forEach((sku) => {
        if (sku.id === mainSku.id || sku.linked_to_sku_id === mainSku.id) return;
        try {
          linkSkuRow(customer.id, sku.id, mainSku.id);
          linked++;
        } catch (linkError) {
          errors.push({ group: groupName, error: linkError.message });
        }
      });
    });

    res.json({
      ok: true,
      groups_found: groupsFound,
      linked,
      skipped,
      errors,
      message: linked > 0
        ? `✅ ${linked} Variante(n) automatisch anhand des Base-Katalogs verknüpft (${groupsFound} Gruppen gefunden).`
        : `ℹ️ Keine neuen Verknüpfungen gefunden (${groupsFound} Gruppen im Base-Katalog erkannt).`
    });
  } catch (err) {
    console.error('❌ Base-Katalog-Verknüpfung Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fehler beim Verknüpfen aus dem Base-Katalog: ' + err.message });
  }
});

module.exports = router;
module.exports.syncBaselinkerOrdersForCustomer = syncBaselinkerOrdersForCustomer;
