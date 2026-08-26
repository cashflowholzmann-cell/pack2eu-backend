// ============================================================
// MANUELLE BESTELLUNG (Backend)
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
            
            db.prepare(`
                CREATE INDEX IF NOT EXISTS idx_orders_user_year ON orders(user_id, created_at)
            `).run();
        }
        
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
