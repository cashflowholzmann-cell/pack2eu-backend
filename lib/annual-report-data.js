// lib/annual-report-data.js
//
// Jahresreport-Aggregation - ausgelagert aus routes/reports.js (dort
// ursprünglich private Hilfsfunktionen für GET /annual/:year), damit
// dieselbe Logik auch vom künftigen LUCID-XML-Export (siehe
// lib/lucid-export.js) genutzt werden kann, statt sie ein zweites Mal zu
// pflegen. Verhalten unverändert gegenüber dem Original.
const { db } = require('../db');
const { normalizeCountryCode } = require('./country-normalize');
const { parseWeeeBatteryItems } = require('./weee-battery-items');

// Bestellungen stammen aus zwei (jetzt drei) Tabellen: manuell erfasste
// (orders), über Shopify synchronisierte (shopify_orders) und über
// Marktplätze synchronisierte (marketplace_orders). Für Reports müssen
// alle drei Quellen zusammengeführt werden.
function fetchOrdersForYear(userId, year) {
    return db.prepare(`
        SELECT destination_country, packaging_data, weee_battery_items_json, created_at
        FROM orders
        WHERE user_id = ?
        AND strftime('%Y', created_at) = ?

        UNION ALL

        SELECT destination_country, packaging_data, weee_battery_items_json, created_at
        FROM shopify_orders
        WHERE customer_id = ?
        AND strftime('%Y', created_at) = ?

        UNION ALL

        SELECT destination_country, packaging_data, weee_battery_items_json, created_at
        FROM marketplace_orders
        WHERE customer_id = ?
        AND strftime('%Y', created_at) = ?
    `).all(userId, String(year), userId, String(year), userId, String(year));
}

// Sicherheitsnetz beim Lesen: destination_country wird seit der Base/
// BaseLinker-Normalisierung (routes/baselinker.js + einmaliger Backfill
// in db/index.js) bereits als sauberer ISO-Code gespeichert - dieser
// zweite Normalisierungs-Schritt fängt nur ab, falls doch noch Klartext
// durchrutscht (z.B. eine künftige Marktplatz-Anbindung), statt still
// einen neuen Fehl-Bucket entstehen zu lassen.
function normalizedCountryOrUnknown(rawCountry) {
    return normalizeCountryCode(rawCountry) || 'Unbekannt';
}

function buildReportData(orders) {
    const reportData = {};

    orders.forEach(order => {
        const country = normalizedCountryOrUnknown(order.destination_country);
        let materials = [];
        try {
            materials = JSON.parse(order.packaging_data || '[]');
        } catch (e) {
            materials = [];
        }
        // packaging_data ist gültiges JSON, aber nicht zwingend ein Array
        // (z.B. '{}' oder 'null') - JSON.parse wirft dafür KEINEN Fehler,
        // das try/catch oben fängt das also nicht ab. Ohne diese Prüfung
        // riss eine einzige solche Bestellung mit "materials.forEach is
        // not a function" den kompletten Jahresreport (und damit auch den
        // PDF-/CSV-Export, die dieselbe Funktion nutzen) für ALLE
        // Bestellungen des Jahres ab, statt nur diese eine Zeile zu
        // überspringen - live beobachtet, "Report konnte nicht generiert
        // werden".
        if (!Array.isArray(materials)) {
            materials = [];
        }

        if (!reportData[country]) {
            reportData[country] = {
                total_kg: 0,
                materials: {},
                // Kundenwunsch: WEEE-/Batterieprodukte (z.B. ein batterie-
                // betriebenes Gerät neben Shampoo/Nagellack in derselben
                // Bestellung) werden separat nach Stückzahl je Kategorie/
                // Batterietyp gezählt statt nach Gewicht - siehe
                // lib/weee-battery-items.js. weeeItems/batteryItems bleiben
                // pro Land über alle Bestellungen des Jahres aufsummiert.
                weeeItems: {},
                batteryItems: {}
            };
        }

        materials.forEach(m => {
            const weightKg = (m.weight_grams || 0) / 1000;
            reportData[country].total_kg += weightKg;

            const material = m.material || 'sonstige';
            if (!reportData[country].materials[material]) {
                reportData[country].materials[material] = 0;
            }
            reportData[country].materials[material] += weightKg;
        });

        const weeeBatteryItems = parseWeeeBatteryItems(order.weee_battery_items_json);
        weeeBatteryItems.weee.forEach(entry => {
            const key = entry.category;
            if (!key) return;
            reportData[country].weeeItems[key] = (reportData[country].weeeItems[key] || 0) + (Number(entry.quantity) || 0);
        });
        weeeBatteryItems.battery.forEach(entry => {
            const key = entry.battery_type;
            if (!key) return;
            reportData[country].batteryItems[key] = (reportData[country].batteryItems[key] || 0) + (Number(entry.quantity) || 0);
        });
    });

    return reportData;
}

module.exports = { fetchOrdersForYear, buildReportData, normalizedCountryOrUnknown };
