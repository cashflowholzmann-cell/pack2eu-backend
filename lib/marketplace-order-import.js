// lib/marketplace-order-import.js
//
// Gemeinsamer Kernblock für alle Marktplatz-Connectoren, die Bestellungen
// gegen Pack2EU-SKUs abgleichen (WooCommerce, Skroutz, Kaufland, eMAG,
// Base/BaseLinker, Etsy, Amazon, eBay, Temu, SHEIN): SKU-Zuordnung,
// Gewichts-/Material-Aggregation, WEEE-/Batterie-Extraktion, Anlage noch
// unbekannter Artikel und das deduplizierte Einfügen in marketplace_orders.
// Dieser Block war bislang in jeder Route fast identisch kopiert - jede
// weitere Marktplatz-Anbindung hätte die Dopplung nur vergrößert.
//
// Was bewusst NICHT hier landet (bleibt pro Connector eigenständig, weil
// es sich zwischen Marktplätzen tatsächlich unterscheidet): der API-Aufruf
// selbst (Auth, Paginierung, Request-Form), die Extraktion von
// externer Bestell-ID und Zielland aus der marktplatzspezifischen
// Order-Struktur.
const { ensureUnclassifiedProduct, isSkuUnclassified } = require('./marketplace-auto-sku');
const { extractWeeeBatteryItems, mergeWeeeBatteryItems } = require('./weee-battery-items');

// Lädt alle Pack2EU-Artikel des Kunden, die für dieses Marktplatz-Feld
// bereits eine externe ID hinterlegt haben, als Lookup-Map externe ID -> SKU.
function buildSkuMap(db, customerId, skuField) {
  const skus = db.prepare(
    `SELECT * FROM product_packaging WHERE customer_id = ? AND ${skuField} IS NOT NULL`
  ).all(customerId);

  const skuMap = {};
  skus.forEach(s => {
    const key = String(s[skuField] || '').trim();
    if (key) skuMap[key] = s;
  });
  return skuMap;
}

// Verarbeitet die Positionen EINER Bestellung gegen die SKU-Map: summiert
// Gewicht/Materialien bekannter Artikel, legt für unbekannte Artikel einen
// leeren Pack2EU-Eintrag an (siehe marketplace-auto-sku.js) und markiert die
// Bestellung, falls mindestens ein Artikel noch nicht klassifiziert ist.
//
// getExternalId/getQuantity/getName lesen die marktplatzspezifischen Felder
// aus einer einzelnen Position aus. getFallbackWeightGrams ist optional
// (bislang nur von Base/BaseLinker genutzt, siehe dortigen Kommentar zu
// source_weight_grams).
function processOrderItems({ db, customerId, items, skuField, skuMap, getExternalId, getQuantity, getName, getFallbackWeightGrams }) {
  let totalWeight = 0;
  const packagingMaterials = [];
  let hasUnclassifiedItem = false;
  const weeeBatteryItemSets = [];

  (items || []).forEach(item => {
    const externalId = getExternalId(item);
    const sku = skuMap[externalId];

    if (isSkuUnclassified(sku)) hasUnclassifiedItem = true;

    if (sku) {
      const qty = getQuantity(item) || 1;
      totalWeight += sku.total_weight_grams * qty;
      weeeBatteryItemSets.push(extractWeeeBatteryItems(sku, qty));

      let materials = [];
      try {
        materials = JSON.parse(sku.materials_json || '[]');
      } catch {
        materials = [];
      }

      materials.forEach(m => {
        packagingMaterials.push({
          material: m.material,
          weight_grams: m.weight_grams * qty,
          is_recyclable: m.is_recyclable
        });
      });
    } else {
      ensureUnclassifiedProduct(db, customerId, {
        field: skuField,
        externalId,
        name: getName(item),
        totalWeightGrams: getFallbackWeightGrams ? getFallbackWeightGrams(item) : undefined
      });
    }
  });

  return {
    totalWeight,
    packagingMaterials,
    hasUnclassifiedItem,
    weeeBatteryItemsJson: JSON.stringify(mergeWeeeBatteryItems(...weeeBatteryItemSets))
  };
}

// Fügt eine verarbeitete Bestellung dedupliziert in marketplace_orders ein
// (UNIQUE(platform, external_order_id) sorgt für den Dedupe - ein erneuter
// Sync fasst eine bereits importierte Bestellung nie an, siehe Kommentar in
// routes/baselinker.js). Gibt zurück, ob tatsächlich eine neue Zeile
// eingefügt wurde.
function insertMarketplaceOrder(db, {
  customerId, platform, externalOrderId, orderData,
  destinationCountry, totalWeight, packagingMaterials,
  hasUnclassifiedItem, weeeBatteryItemsJson, fulfillmentType
}) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO marketplace_orders
    (customer_id, platform, external_order_id, order_data_json, destination_country, total_weight_grams, packaging_data, fulfillment_type, has_unclassified_items, weee_battery_items_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customerId,
    platform,
    externalOrderId,
    JSON.stringify(orderData),
    destinationCountry,
    totalWeight,
    JSON.stringify(packagingMaterials),
    fulfillmentType || null,
    hasUnclassifiedItem ? 1 : 0,
    weeeBatteryItemsJson
  );

  return result.changes > 0;
}

module.exports = { buildSkuMap, processOrderItems, insertMarketplaceOrder };
