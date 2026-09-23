// routes/reports.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const PDFDocument = require('pdfkit');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');

const router = express.Router();

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

function buildReportData(orders) {
    const reportData = {};

    orders.forEach(order => {
        const country = order.destination_country || 'Unbekannt';
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

        const reports = db.prepare(`
            SELECT
                strftime('%Y-%m', created_at) as period,
                destination_country as country,
                COUNT(*) as orders,
                SUM(total_weight_grams) / 1000.0 as total_kg
            FROM (
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
            )
            GROUP BY strftime('%Y-%m', created_at), destination_country
            ORDER BY period DESC
            LIMIT 12
        `).all(userId, userId, userId);

        const formatted = reports.map(r => ({
            period: r.period,
            country_code: r.country || 'Unbekannt',
            totals: {
                orders: r.orders || 0,
                orderPackagingKg: r.total_kg || 0,
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
