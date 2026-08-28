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
// ============================================================
router.get('/', (req, res) => {
    try {
        const userId = req.customer.sub;

        const orders = db.prepare(`
            SELECT * FROM orders 
            WHERE user_id = ? 
            ORDER BY created_at DESC
        `).all(userId);
        
        res.json(orders);
        
    } catch (error) {
        console.error('❌ Orders Fehler:', error);
        res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden' });
    }
});

module.exports = router;
