// routes/reports.js
const express = require('express');
const { db } = require('../db');
const PDFDocument = require('pdfkit');

const router = express.Router();

// 1. REPORT DATEN GENERIEREN
router.get('/annual/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.user.id; // Annahme: User ist authentifiziert

        // Hole alle Bestellungen + Verpackungsdaten für das Jahr
        const orders = db.prepare(`
            SELECT 
                o.destination_country,
                o.shopify_order_id,
                o.created_at,
                o.total_weight_grams,
                o.packaging_data
            FROM orders o
            JOIN skus s ON o.sku_id = s.id
            WHERE o.user_id = ? 
            AND strftime('%Y', o.created_at) = ?
        `).all(userId, String(year));

        // Aggregiere die Daten pro Land und Material
        const reportData = {};

        orders.forEach(order => {
            const country = order.destination_country || 'Unbekannt';
            const materials = JSON.parse(order.packaging_data || '[]');

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

        res.json({
            year: year,
            countries: reportData,
            total_kg: Object.values(reportData).reduce((sum, c) => sum + c.total_kg, 0)
        });

    } catch (error) {
        console.error('❌ Report Fehler:', error);
        res.status(500).json({ error: 'Report konnte nicht generiert werden' });
    }
});

// 2. PDF EXPORT
router.get('/export/pdf/:year', async (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.user.id;

        // Daten holen (gleiche Logik wie oben)
        const report = await getReportData(userId, year);

        // PDF generieren
        const doc = new PDFDocument({ margin: 50 });
        const filename = `Pack2EU_Report_${year}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        doc.pipe(res);

        // Kopf
        doc.fontSize(20).text('Pack2EU - Jahresreport', { align: 'center' });
        doc.fontSize(12).text(`Berichtsjahr: ${year}`, { align: 'center' });
        doc.moveDown();

        // Für jedes Land
        Object.entries(report.countries).forEach(([country, data]) => {
            doc.fontSize(14).text(`📦 ${country}`, { underline: true });
            doc.fontSize(10).text(`Gesamt: ${data.total_kg.toFixed(2)} kg`);
            
            // Materialien
            Object.entries(data.materials).forEach(([material, kg]) => {
                doc.text(`  • ${material}: ${kg.toFixed(2)} kg`);
            });
            
            doc.moveDown();
        });

        // Fuß
        doc.fontSize(10).text(`Erstellt am: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.end();

    } catch (error) {
        console.error('❌ PDF Export Fehler:', error);
        res.status(500).json({ error: 'PDF konnte nicht erstellt werden' });
    }
});

// 3. CSV EXPORT
router.get('/export/csv/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.user.id;

        // Daten holen
        const report = getReportData(userId, year);

        // CSV generieren
        const rows = [];
        rows.push(['Land', 'Material', 'Gewicht (kg)', 'Jahr']);

        Object.entries(report.countries).forEach(([country, data]) => {
            Object.entries(data.materials).forEach(([material, kg]) => {
                rows.push([country, material, kg.toFixed(3), year]);
            });
        });

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

// Hilfsfunktion
async function getReportData(userId, year) {
    const orders = db.prepare(`
        SELECT 
            o.destination_country,
            o.packaging_data
        FROM orders o
        WHERE o.user_id = ? 
        AND strftime('%Y', o.created_at) = ?
    `).all(userId, String(year));

    const reportData = {};

    orders.forEach(order => {
        const country = order.destination_country || 'Unbekannt';
        const materials = JSON.parse(order.packaging_data || '[]');

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

    return {
        year: year,
        countries: reportData,
        total_kg: Object.values(reportData).reduce((sum, c) => sum + c.total_kg, 0)
    };
}

module.exports = router;
