// routes/reports.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const PDFDocument = require('pdfkit');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { normalizeCountryCode } = require('../lib/country-normalize');

const router = express.Router();

// Marktplatz-Bestellungen (marketplace_orders) lassen sich seit
// PUT /orders/marketplace/:id korrigieren, manuelle über
// PUT /orders/manual/:id (bereits vorhanden) - Shopify-Bestellungen
// bewusst nicht (siehe routes/orders.js).
const CORRECTABLE_MARKETPLACE_PLATFORMS = ['etsy', 'kaufland', 'amazon', 'ebay', 'skroutz', 'baselinker'];

// LOGO_PATH: lokaler Dateipfad (nicht URL, anders als bei E-Mails) - pdfkit
// bettet die Datei direkt ein statt sie zu laden. Fehlt die Datei/Env-Var,
// wird der Header ohne Logo gerendert statt den Export crashen zu lassen.
const BRAND_COLOR = '#0A2540';
const LOGO_PATH = process.env.PDF_LOGO_PATH || path.join(__dirname, '..', 'assets', 'logo.png');

function drawPdfHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 50, 15, { height: 60 });
  } else {
    doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text('Pack2EU', 50, 34);
  }

  doc.y = 110;
  doc.fillColor('#1a1a1a').font('Helvetica-Bold').fontSize(18).text(title, { align: 'left' });
  if (subtitle) {
    doc.font('Helvetica').fontSize(11).fillColor('#555555').text(subtitle);
  }
  doc.moveDown();
  doc.strokeColor('#dddddd').moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
  doc.moveDown();
  doc.fillColor('#1a1a1a').font('Helvetica');
}

function drawPdfFooter(doc) {
  // Bewusst deutlich über der unteren Seitenmarge (nicht genau auf ihr) -
  // sonst zählt pdfkit die Zeilenhöhe der Fußzeile selbst schon als
  // Überlauf und hängt automatisch eine (leere) Folgeseite an.
  const bottom = doc.page.height - 70;
  doc.fontSize(8).fillColor('#999999').font('Helvetica')
    .text('Pack2EU · pack2eu.global', 50, bottom, { align: 'left', width: doc.page.width - 100, lineBreak: false });
  doc.text(`Erstellt am ${new Date().toLocaleDateString('de-DE')}`, 50, bottom, { align: 'right', width: doc.page.width - 100, lineBreak: false });
}

router.use(requireAuth);
router.use(requireActiveSubscription);

// ============================================================
// HILFSFUNKTIONEN
//
// Bestellungen stammen aus zwei Tabellen: manuell erfasste
// (orders) und über Shopify synchronisierte (shopify_orders).
// Für Reports müssen beide Quellen zusammengeführt werden.
// ============================================================
function fetchOrdersForYear(userId, year) {
    return db.prepare(`
        SELECT destination_country, packaging_data, created_at
        FROM orders
        WHERE user_id = ?
        AND strftime('%Y', created_at) = ?

        UNION ALL

        SELECT destination_country, packaging_data, created_at
        FROM shopify_orders
        WHERE customer_id = ?
        AND strftime('%Y', created_at) = ?

        UNION ALL

        SELECT destination_country, packaging_data, created_at
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

        if (!reportData[country]) {
            reportData[country] = {
                total_kg: 0,
                materials: {}
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
    });

    return reportData;
}

// ============================================================
// 1. REPORT DATEN GENERIEREN
// ============================================================
router.get('/annual/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.customer.sub;

        const orders = fetchOrdersForYear(userId, year);
        const reportData = buildReportData(orders);

        res.json({
            year: year,
            countries: reportData,
            total_kg: Object.values(reportData).reduce((sum, c) => sum + c.total_kg, 0)
        });

    } catch (error) {
        console.error('❌ Report Fehler:', error);
        res.status(500).json({ 
            error: 'Report konnte nicht generiert werden',
            message: error.message 
        });
    }
});

// ============================================================
// 2. MONTHLY REPORTS
// ============================================================
router.get('/monthly', (req, res) => {
    try {
        const userId = req.customer.sub;

        // Gruppierung nach Zielland passiert bewusst in JS statt in SQL
        // (GROUP BY destination_country) - sonst würden z.B. Alt-Zeilen
        // mit noch nicht normalisiertem Freitext wieder als eigene Zeile
        // neben dem ISO-Code auftauchen. normalizedCountryOrUnknown()
        // fasst pro (Monat, Land) zusammen, was inhaltlich dasselbe Land ist.
        const rawRows = db.prepare(`
            SELECT created_at, destination_country, total_weight_grams
            FROM orders
            WHERE user_id = ?

            UNION ALL

            SELECT created_at, destination_country, total_weight_grams
            FROM shopify_orders
            WHERE customer_id = ?

            UNION ALL

            SELECT created_at, destination_country, total_weight_grams
            FROM marketplace_orders
            WHERE customer_id = ?
        `).all(userId, userId, userId);

        const grouped = {};
        rawRows.forEach(row => {
            const period = String(row.created_at || '').slice(0, 7);
            const country = normalizedCountryOrUnknown(row.destination_country);
            const key = period + '|' + country;
            if (!grouped[key]) {
                grouped[key] = { period, country, orders: 0, total_kg: 0 };
            }
            grouped[key].orders += 1;
            grouped[key].total_kg += (row.total_weight_grams || 0) / 1000;
        });

        const formatted = Object.values(grouped)
            .sort((a, b) => b.period.localeCompare(a.period))
            .slice(0, 12)
            .map(r => ({
                period: r.period,
                country_code: r.country,
                totals: {
                    orders: r.orders,
                    orderPackagingKg: r.total_kg,
                    submissionKg: 0
                },
                status: 'draft'
            }));

        res.json(formatted);

    } catch (error) {
        console.error('❌ Monthly Reports Fehler:', error);
        res.status(500).json({
            error: 'Monatsreports konnten nicht geladen werden',
            message: error.message
        });
    }
});

// ============================================================
// 2b. BESTELLUNGEN HINTER EINER REPORT-ZEILE (Klick-Durchstieg)
//
// Sowohl der Monats- als auch der Jahresreport gruppieren Bestellungen
// nach (Zeitraum, Zielland) - ein Klick auf eine Report-Zeile soll genau
// diese zugrundeliegenden Bestellungen zeigen, u.a. damit man ein
// "Unbekannt" oder ein falsch zugeordnetes Land direkt korrigieren kann
// (siehe PUT /orders/manual/:id und PUT /orders/marketplace/:id).
// Query-Parameter: entweder period=YYYY-MM ODER year=YYYY (period hat
// Vorrang, falls beides mitgeschickt wird), plus country=<ISO-Code|Unbekannt>.
// ============================================================
router.get('/orders', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { period, year, country } = req.query;

        if (!country) {
            return res.status(400).json({ error: 'country ist erforderlich.' });
        }
        if (!period && !year) {
            return res.status(400).json({ error: 'period oder year ist erforderlich.' });
        }

        const rows = db.prepare(`
            SELECT 'manual' AS source, COALESCE(source_platform, 'own_shop') AS origin, id, shopify_order_id AS order_number, destination_country, total_weight_grams, created_at
            FROM orders
            WHERE user_id = ?

            UNION ALL

            SELECT 'shopify' AS source, 'shopify' AS origin, id, shopify_order_id AS order_number, destination_country, total_weight_grams, created_at
            FROM shopify_orders
            WHERE customer_id = ?

            UNION ALL

            SELECT platform AS source, platform AS origin, id, external_order_id AS order_number, destination_country, total_weight_grams, created_at
            FROM marketplace_orders
            WHERE customer_id = ?
        `).all(userId, userId, userId);

        const filtered = rows.filter(row => {
            const rowPeriod = String(row.created_at || '').slice(0, 7);
            const rowYear = rowPeriod.slice(0, 4);
            const matchesTime = period ? rowPeriod === period : rowYear === String(year);
            if (!matchesTime) return false;
            return normalizedCountryOrUnknown(row.destination_country) === country;
        });

        const result = filtered
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .map(row => ({
                source: row.source,
                origin: row.origin,
                id: row.id,
                order_number: row.order_number,
                destination_country: row.destination_country,
                weight_kg: (row.total_weight_grams || 0) / 1000,
                created_at: row.created_at,
                correctable: row.source === 'manual' || CORRECTABLE_MARKETPLACE_PLATFORMS.includes(row.source)
            }));

        res.json(result);

    } catch (error) {
        console.error('❌ Report-Bestellungen Fehler:', error);
        res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden.' });
    }
});

// ============================================================
// 3. PDF EXPORT
// ============================================================
router.get('/export/pdf/:year', async (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.customer.sub;

        const orders = fetchOrdersForYear(userId, year);
        const reportData = buildReportData(orders);

        const doc = new PDFDocument({ margin: 50 });
        const filename = `Pack2EU_Report_${year}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        doc.pipe(res);

        drawPdfHeader(doc, 'Jahresreport', `Berichtsjahr ${year}`);

        if (Object.keys(reportData).length === 0) {
            doc.fontSize(12).text('Keine Verpackungsdaten für dieses Jahr vorhanden.');
        } else {
            Object.entries(reportData).forEach(([country, data]) => {
                doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND_COLOR).text(country);
                doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(`Gesamt: ${data.total_kg.toFixed(2)} kg`);

                Object.entries(data.materials).forEach(([material, kg]) => {
                    doc.text(`  •  ${material}: ${kg.toFixed(2)} kg`);
                });

                doc.moveDown();
            });
        }

        drawPdfFooter(doc);
        doc.end();

    } catch (error) {
        console.error('❌ PDF Export Fehler:', error);
        res.status(500).json({ error: 'PDF konnte nicht erstellt werden' });
    }
});

// ============================================================
// 4. CSV EXPORT
// ============================================================
router.get('/export/csv/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.customer.sub;

        const orders = fetchOrdersForYear(userId, year);
        const reportData = buildReportData(orders);

        const rows = [];
        rows.push(['Land', 'Material', 'Gewicht (kg)', 'Jahr']);

        if (Object.keys(reportData).length === 0) {
            rows.push(['Keine Daten', '-', '0', year]);
        } else {
            Object.entries(reportData).forEach(([country, data]) => {
                Object.entries(data.materials).forEach(([material, kg]) => {
                    rows.push([country, material, kg.toFixed(3), year]);
                });
            });
        }

        const csv = rows.map(row => row.join(';')).join('\n');
        const filename = `Pack2EU_Report_${year}.csv`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);

    } catch (error) {
        console.error('❌ CSV Export Fehler:', error);
        res.status(500).json({ error: 'CSV konnte nicht erstellt werden' });
    }
});

module.exports = router;
