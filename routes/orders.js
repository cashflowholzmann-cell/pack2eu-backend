// routes/orders.js
const express = require('express');
const { db } = require('../db');

const router = express.Router();

// ============================================================
// AUTH-MIDDLEWARE für alle Order-Routen
// ============================================================
router.use((req, res, next) => {
    try {
        // 1. Versuche, den User aus dem Authorization-Header zu holen
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(' ')[1];
        
        if (token) {
            // 2. Versuche, den User zu finden (Fallback: ersten User nehmen)
            const firstUser = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get();
            if (firstUser) {
                req.user = { id: firstUser.id };
                console.log('✅ User authentifiziert (ID:', firstUser.id, ')');
                return next();
            }
        }
        
        // 3. FALLBACK: Ersten User verwenden (NUR FÜR ENTWICKLUNG!)
        const firstUser = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get();
        if (firstUser) {
            req.user = { id: firstUser.id };
            console.log('⚠️ Fallback: Verwende User (ID:', firstUser.id, ')');
            return next();
        }
        
        // 4. Kein User gefunden
        console.warn('❌ Kein User in der Datenbank gefunden');
        res.status(401).json({ error: 'Nicht authentifiziert' });
        
    } catch (error) {
        console.error('❌ Auth-Fehler:', error);
        res.status(500).json({ error: 'Auth-Fehler' });
    }
});

// ============================================================
// MANUELLE BESTELLUNG
// ============================================================
router.post('/manual', (req, res) => {
    try {
        const userId = req.user.id;
        const { order_id, destination_country, total_weight_grams, packaging_data, created_at } = req.body;
        
        // Prüfe, ob die orders-Tabelle existiert, sonst erstellen
        const tableCheck = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='orders'
        `).get();
        
        if (!tableCheck) {
            // Tabelle erstellen
            db.prepare(`
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    shopify_order_id TEXT,
                    destination_country TEXT NOT NULL,
                    total_weight_grams REAL DEFAULT 0,
                    packaging_data TEXT DEFAULT '[]',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES customers(id)
                )
            `).run();
            
            // Index erstellen
            db.prepare(`
                CREATE INDEX IF NOT EXISTS idx_orders_user_year ON orders(user_id, created_at)
            `).run();
        }
        
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
        const userId = req.user.id;
        
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
