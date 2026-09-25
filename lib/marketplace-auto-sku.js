// lib/marketplace-auto-sku.js
//
// Wenn eine Bestellung über einen Marktplatz (Base/BaseLinker, Amazon,
// eBay, Etsy, Kaufland, Skroutz) einen Artikel enthält, für den noch KEIN
// Pack2EU-Artikel (product_packaging) hinterlegt ist, legt Pack2EU jetzt
// automatisch einen Artikel-Eintrag OHNE Material an, statt das Gewicht
// nur als anonymen "sonstige"-Posten in der Bestellung zu verbuchen.
//
// Kundenwunsch (Audit-Fund): "sonstige" ohne echten Artikel-Eintrag
// bedeutet für die Bevollmächtigten/Sachbearbeiter (z.B. "Egon") manuelle
// Nacharbeit bei jeder Meldung. Mit einem echten, aber noch leeren
// Artikel-Eintrag taucht der Artikel direkt im SKU-Editor auf und muss
// nur EINMAL mit einem Material befüllt werden - danach ordnet ihm der
// nächste Sync automatisch die echten Materialien zu (siehe "Bereits
// importierte Bestellungen werden aktualisiert" in den jeweiligen
// Sync-Routen), die "sonstige"-Verbuchung verschwindet von selbst.
//
// Whitelist bewusst hart codiert (kein dynamisches SQL aus Nutzereingaben) -
// "field" kommt ausschließlich aus dem eigenen Route-Code, nie aus einem
// Request-Body.
const MARKETPLACE_SKU_FIELDS = [
  'baselinker_sku',
  'amazon_sku',
  'ebay_item_id',
  'etsy_listing_id',
  'kaufland_product_id',
  'skroutz_shop_uid'
];

// Gibt die id des (ggf. neu angelegten) Artikels zurück, oder null, wenn
// externalId fehlt oder field ungültig ist.
//
// totalWeightGrams: das PRO-STÜCK-Gewicht, falls der Marktplatz eins
// mitliefert (z.B. Base/BaseLinker über item.weight) - wird als Vorschlag
// gespeichert, damit der Nutzer im SKU-Editor direkt sieht "250g auf
// Materialien aufteilen" statt das Gewicht nochmal selbst eintippen zu
// müssen. Marktplätze ohne Artikelgewicht in der Order-API (Amazon, eBay,
// Etsy, Kaufland, Skroutz) lassen es einfach weg (0 - Nutzer trägt es
// selbst ein).
function ensureUnclassifiedProduct(db, customerId, { field, externalId, name, totalWeightGrams }) {
  if (!MARKETPLACE_SKU_FIELDS.includes(field)) return null;
  const key = String(externalId || '').trim();
  if (!key) return null;

  const existing = db.prepare(
    `SELECT id FROM product_packaging WHERE customer_id = ? AND ${field} = ?`
  ).get(customerId, key);
  if (existing) return existing.id;

  const skuName = String(name || '').trim() || `Unbekanntes Produkt (${key})`;
  const weight = Number(totalWeightGrams) > 0 ? Math.round(Number(totalWeightGrams)) : 0;

  const result = db.prepare(`
    INSERT INTO product_packaging (customer_id, sku_name, materials_json, total_weight_grams, ${field})
    VALUES (?, ?, '[]', ?, ?)
  `).run(customerId, skuName, weight, key);

  return result.lastInsertRowid;
}

module.exports = { ensureUnclassifiedProduct, MARKETPLACE_SKU_FIELDS };
