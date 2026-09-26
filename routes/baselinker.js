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
const { ensureUnclassifiedProduct } = require('../lib/marketplace-auto-sku');

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
  `).run(apiToken.trim(), req.auth.userId);

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

    const skus = db.prepare(`
      SELECT *
      FROM product_packaging
      WHERE customer_id = ?
        AND baselinker_sku IS NOT NULL
    `).all(customer.id);

    const skuMap = {};

    skus.forEach((sku) => {
      const key = String(sku.baselinker_sku || '').trim();

      if (key) {
        skuMap[key] = sku;
      }
    });

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
      let totalWeight = 0;
      const packagingMaterials = [];

      (order.products || []).forEach((item) => {
        const itemSku = String(item.sku || '').trim();
        // Audit-Fund: viele über Base/BaseLinker aggregierte Bestellungen
        // (z.B. aus Shops ohne eigene SKU-Pflege) liefern GAR KEIN item.sku
        // - itemSku war dann immer '', ensureUnclassifiedProduct() bricht
        // bei leerem externalId sofort ab (kein Dedupe-Schlüssel möglich),
        // und für diese Bestellungen wurde NIE ein Pack2EU-Artikel angelegt.
        // Ergebnis: sie blieben dauerhaft nur als anonymer "sonstige"-Posten
        // hängen, ganz ohne Möglichkeit, sie im SKU-Editor zu klassifizieren
        // (siehe Kundenwunsch weiter oben: "dann muss man doch einfach den
        // Namen bei uns hinterlegen können"). Fallback auf den Artikelnamen
        // als Schlüssel, wenn keine SKU vorhanden ist - matcht künftige
        // Bestellungen desselben Artikelnamens genauso automatisch wie eine
        // echte SKU (siehe skuMap-Lookup unten).
        const matchKey = itemSku || String(item.name || '').trim();
        const sku = skuMap[matchKey];
        const quantity = Number(item.quantity) > 0
          ? Number(item.quantity)
          : 1;

        if (sku) {
          // Pack2EU-Verpackungsdaten haben Vorrang.
          totalWeight += Number(sku.total_weight_grams || 0) * quantity;

          let materials = [];

          try {
            materials = JSON.parse(sku.materials_json || '[]');
          } catch {
            materials = [];
          }

          materials.forEach((material) => {
            packagingMaterials.push({
              material: material.material,
              weight_grams: Number(material.weight_grams || 0) * quantity,
              is_recyclable: material.is_recyclable
            });
          });
        } else {
          // Kein Pack2EU-SKU vorhanden: Base-Artikelgewicht in kg in
          // Gramm umrechnen. WICHTIG: das Gewicht muss zusätzlich als
          // packagingMaterials-Eintrag ("sonstige", da uns Base keine
          // Materialaufschlüsselung liefert) gespeichert werden, nicht
          // nur in totalWeight - Verpackungsstatistik, Jahresreport und
          // Öko-Gebühr-Schätzung lesen ausschließlich packaging_data,
          // nicht total_weight_grams (Audit-Fund: Bestellungen mit
          // Gewicht > 0 erschienen in der Verpackungsstatistik trotzdem
          // als 0 kg, weil hier bisher NUR totalWeight erhöht wurde).
          // is_recyclable: false als konservative Annahme, solange die
          // tatsächliche Materialzusammensetzung unbekannt ist.
          //
          // Zusätzlich einen echten (noch leeren) Pack2EU-Artikel für
          // diese Base-SKU anlegen, statt den Artikel nur anonym als
          // "sonstige" zu verbuchen - Kundenwunsch: der Artikel soll im
          // SKU-Editor auftauchen und nur EINMAL mit einem Material
          // befüllt werden müssen. Der nächste Sync ordnet ihm dann
          // automatisch die echten Materialien zu (siehe skuMap oben).
          ensureUnclassifiedProduct(db, customer.id, {
            field: 'baselinker_sku',
            externalId: matchKey,
            name: item.name,
            // Pro-Stück-Gewicht (nicht mit quantity multipliziert) - der
            // SKU-Editor bildet ein einzelnes Stück ab, nicht die ganze
            // Bestellposition.
            totalWeightGrams: baseWeightToGrams(item.weight)
          });

          const fallbackWeight = baseWeightToGrams(item.weight) * quantity;
          totalWeight += fallbackWeight;
          if (fallbackWeight > 0) {
            packagingMaterials.push({
              material: 'sonstige',
              weight_grams: fallbackWeight,
              is_recyclable: false
            });
          }
        }
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

      const externalOrderId = String(order.order_id);

      // Kundenentscheidung (nach einem Vorfall, bei dem ein erneuter Sync
      // eine manuell korrigierte Bestellung wieder auf den falschen Stand
      // aus Base zurückgesetzt hat - das vorherige manually_corrected-Flag
      // half nur für Korrekturen NACH dessen Einführung, nicht für bereits
      // vorher korrigierte Bestellungen): ein Sync fasst eine bereits
      // importierte Bestellung GAR NICHT MEHR an, auch nicht ihre Metadaten
      // - er ergänzt ausschließlich neue, noch nicht bekannte Bestellungen
      // (Dedupe-Schlüssel: external_order_id). Identisch zum Verhalten
      // aller anderen Marktplatz-Integrationen (Etsy, Kaufland, Amazon,
      // eBay, Skroutz), die ebenfalls nie nachträglich überschreiben.
      // Ein falsches Anfangsgewicht/-Zielland wird über die Korrektur-
      // Maske behoben, nicht implizit durch einen künftigen Sync.
      const existingOrder = db.prepare(`
        SELECT id
        FROM marketplace_orders
        WHERE customer_id = ?
          AND platform = 'baselinker'
          AND external_order_id = ?
      `).get(customer.id, externalOrderId);

      if (existingOrder) {
        skipped++;
      } else {
        db.prepare(`
          INSERT INTO marketplace_orders
          (
            customer_id,
            platform,
            external_order_id,
            order_data_json,
            destination_country,
            total_weight_grams,
            packaging_data,
            fulfillment_type
          )
          VALUES (?, 'baselinker', ?, ?, ?, ?, ?, ?)
        `).run(
          customer.id,
          externalOrderId,
          JSON.stringify(order),
          destinationCountry,
          totalWeight,
          JSON.stringify(packagingMaterials),
          order.order_source || null
        );

        imported++;
      }
    }

    res.json({
      ok: true,
      imported,
      skipped,
      total: orders.length
    });
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

module.exports = router;
