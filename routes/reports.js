// routes/reports.js
const express = require('express');
const { db } = require('../db');
const PDFDocument = require('pdfkit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// ============================================================
// 1. REPORT DATEN GENERIEREN
// ============================================================
router.get('/annual/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.customer.sub;

        // Prüfe, ob die orders-Tabelle existiert
        const tableCheck = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='orders'
        `).get();

        if (!tableCheck) {
            return res.json({
                year: year,
                countries: {},
                total_kg: 0,
                message: 'Tabelle "orders" existiert noch nicht.'
            });
        }

        const orders = db.prepare(`
            SELECT 
                destination_country,
                packaging_data
            FROM orders 
            WHERE user_id = ? 
            AND strftime('%Y', created_at) = ?
        `).all(userId, String(year));

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

        const tableCheck = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='orders'
        `).get();

        if (!tableCheck) {
            return res.json([]);
        }

        // Prüfe, ob die Spalte total_weight_grams existiert
        const columns = db.prepare(`PRAGMA table_info(orders)`).all();
        const hasTotalWeight = columns.some(col => col.name === 'total_weight_grams');

        let reports;
        if (hasTotalWeight) {
            reports = db.prepare(`
                SELECT 
                    strftime('%Y-%m', created_at) as period,
                    destination_country as country,
                    COUNT(*) as orders,
                    SUM(total_weight_grams) / 1000.0 as total_kg
                FROM orders
                WHERE user_id = ?
                GROUP BY strftime('%Y-%m', created_at), destination_country
                ORDER BY period DESC
                LIMIT 12
            `).all(userId);
        } else {
            reports = db.prepare(`
                SELECT 
                    strftime('%Y-%m', created_at) as period,
                    destination_country as country,
                    COUNT(*) as orders,
                    0.0 as total_kg
                FROM orders
                WHERE user_id = ?
                GROUP BY strftime('%Y-%m', created_at), destination_country
                ORDER BY period DESC
                LIMIT 12
            `).all(userId);
        }

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

        const orders = db.prepare(`
            SELECT 
                destination_country,
                packaging_data
            FROM orders 
            WHERE user_id = ? 
            AND strftime('%Y', created_at) = ?
        `).all(userId, String(year));

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

        const doc = new PDFDocument({ margin: 50 });
        const filename = `Pack2EU_Report_${year}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        doc.pipe(res);

        doc.fontSize(20).text('Pack2EU - Jahresreport', { align: 'center' });
        doc.fontSize(12).text(`Berichtsjahr: ${year}`, { align: 'center' });
        doc.moveDown();

        if (Object.keys(reportData).length === 0) {
            doc.fontSize(12).text('Keine Verpackungsdaten für dieses Jahr vorhanden.');
        } else {
            Object.entries(reportData).forEach(([country, data]) => {
                doc.fontSize(14).text(`📦 ${country}`, { underline: true });
                doc.fontSize(10).text(`Gesamt: ${data.total_kg.toFixed(2)} kg`);
                
                Object.entries(data.materials).forEach(([material, kg]) => {
                    doc.text(`  • ${material}: ${kg.toFixed(2)} kg`);
                });
                
                doc.moveDown();
            });
        }

        doc.fontSize(10).text(`Erstellt am: ${new Date().toLocaleDateString()}`, { align: 'center' });
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

        const orders = db.prepare(`
            SELECT 
                destination_country,
                packaging_data
            FROM orders 
            WHERE user_id = ? 
            AND strftime('%Y', created_at) = ?
        `).all(userId, String(year));

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
