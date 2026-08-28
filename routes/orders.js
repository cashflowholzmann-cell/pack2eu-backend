// routes/orders.js
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// ============================================================
// MANUELLE BESTELLUNG
// ============================================================
router.post('/manual', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { order_id, destination_country, total_weight_grams, packaging_data, created_at } = req.body;

        // Bestellung speichern
        const stmt = db.prepare(`
            INSERT INTO orders (
                user_id, 
                shopify_order_id, 
                destination_country, 
                total_weight_grams, 
                packaging_data,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        
        const result = stmt.run(
            userId,
            order_id || 'MANUAL-' + Date.now(),
            destination_country,
            total_weight_grams || 0,
            JSON.stringify(packaging_data || []),
            created_at || new Date().toISOString()
        );
        
        res.json({
            success: true,
            order_id: result.lastInsertRowid,
            message: 'Bestellung erfolgreich angelegt'
        });
        
    } catch (error) {
        console.error('❌ Manuelle Bestellung Fehler:', error);
        res.status(500).json({ 
            error: 'Bestellung konnte nicht angelegt werden',
            details: error.message 
        });
    }
});

// ============================================================
// BESTELLUNGEN ABFRAGEN
//
// Vereint manuell angelegte Bestellungen (orders) und über Shopify
// synchronisierte Bestellungen (shopify_orders) in einer Liste - beide
// füllen denselben "Bestellungen"-Bereich im Dashboard, waren vorher aber
// versehentlich getrennt (das Dashboard fragte nur /api/shopify/orders ab,
// wodurch manuell angelegte Bestellungen nie im Dashboard erschienen).
// ============================================================
router.get('/', (req, res) => {
    try {
        const userId = req.customer.sub;

        // "id" ist pro Tabelle nur eigenständig eindeutig (beide sind
        // unabhängige AUTOINCREMENT-Spalten) - "source" macht das Paar
        // (source, id) über beide Tabellen hinweg eindeutig identifizierbar.
        const orders = db.prepare(`
            SELECT 'manual' AS source, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, created_at
            FROM orders
            WHERE user_id = ?

            UNION ALL

            SELECT 'shopify' AS source, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, created_at
            FROM shopify_orders
            WHERE customer_id = ?

            ORDER BY created_at DESC
        `).all(userId, userId);

        res.json(orders);

    } catch (error) {
        console.error('❌ Orders Fehler:', error);
        res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden' });
    }
});

module.exports = router;
