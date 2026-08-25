// routes/reports.js
const express = require('express');
const { db } = require('../db');
const PDFDocument = require('pdfkit');

const router = express.Router();

// ============================================================
// 1. REPORT DATEN GENERIEREN (MIT DETAILIERTEM FEHLERLOGGING)
// ============================================================
router.get('/annual/:year', (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.user.id;

        // 1. Prüfe, ob die Tabelle 'orders' existiert
        const tableCheck = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='orders'
        `).get();

        if (!tableCheck) {
            console.warn('⚠️ Tabelle "orders" existiert nicht.');
            return res.status(404).json({
                error: 'Tabelle "orders" existiert nicht.',
                details: 'Bitte importiere zuerst Bestellungen.'
            });
        }

        // 2. Prüfe, ob die Spalte 'packaging_data' existiert
        const columns = db.prepare(`PRAGMA table_info(orders)`).all();
        const hasPackagingData = columns.some(col => col.name === 'packaging_data');
        const hasTotalWeight = columns.some(col => col.name === 'total_weight_grams');

        if (!hasPackagingData) {
            console.warn('⚠️ Spalte "packaging_data" existiert nicht.');
            return res.status(500).json({
                error: 'Spalte "packaging_data" fehlt.',
                details: 'Die Tabelle "orders" hat nicht die erwartete Struktur.'
            });
        }

        // 3. Daten abfragen
        const orders = db.prepare(`
            SELECT 
                destination_country,
                packaging_data
            FROM orders 
            WHERE user_id = ? 
            AND strftime('%Y', created_at) = ?
        `).all(userId, String(year));

        // 4. Daten aggregieren
        const reportData = {};

        orders.forEach(order => {
            const country = order.destination_country || 'Unbekannt';
            
            let materials = [];
            try {
                materials = JSON.parse(order.packaging_data || '[]');
            } catch (e) {
                console.warn(`⚠️ Ungültiges JSON in packaging_data:`, order.packaging_data);
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

        // 5. Erfolgreiche Antwort
        res.json({
            year: year,
            countries: reportData,
            total_kg: Object.values(reportData).reduce((sum, c) => sum + c.total_kg, 0),
            _debug: {
                orderCount: orders.length,
                tableExists: true
            }
        });

    } catch (error) {
        console.error('❌ Report Fehler (detailiert):', error);
        res.status(500).json({
            error: 'Report konnte nicht generiert werden',
            message: error.message,
            stack: error.stack
        });
    }
});

// ============================================================
// 2. MONTHLY REPORTS (MIT DETAILIERTEM FEHLERLOGGING)
// ============================================================
router.get('/monthly', (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Prüfe, ob die Tabelle 'orders' existiert
        const tableCheck = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='orders'
        `).get();

        if (!tableCheck) {
            console.warn('⚠️ Tabelle "orders" existiert nicht.');
            return res.status(404).json({
                error: 'Tabelle "orders" existiert nicht.',
                details: 'Bitte importiere zuerst Bestellungen.'
            });
        }

        // 2. Prüfe die Tabellen-Struktur
        const columns = db.prepare(`PRAGMA table_info(orders)`).all();
        const hasTotalWeight = columns.some(col => col.name === 'total_weight_grams');

        // 3. Daten abfragen
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
            // Fallback: nur Bestellungen zählen
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

        // 4. Formatiere die Daten
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
        console.error('❌ Monthly Reports Fehler (detailiert):', error);
        res.status(500).json({
            error: 'Monatsreports konnten nicht geladen werden',
            message: error.message,
            stack: error.stack
        });
    }
});

// ============================================================
// 3. PDF EXPORT
// ============================================================
router.get('/export/pdf/:year', async (req, res) => {
    try {
        const year = parseInt(req.params.year) || new Date().getFullYear();
        const userId = req.user.id;

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
        const userId = req.user.id;

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
