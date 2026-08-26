// routes/bulk-import.js
const express = require('express');
const { db } = require('../db');
const router = express.Router();

// ============================================================
// AUTH-MIDDLEWARE (OHNE FALLBACK!)
// ============================================================
router.use((req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(' ')[1];
        
        if (!token) {
            console.warn('❌ Bulk-Import: Kein Token gefunden');
            return res.status(401).json({ error: 'Nicht authentifiziert' });
        }
        
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
            const userId = payload.sub;
            
            if (!userId) {
                console.warn('❌ Bulk-Import: Keine User-ID im Token');
                return res.status(401).json({ error: 'Ungültiger Token' });
            }
            
            const user = db.prepare('SELECT id FROM customers WHERE id = ?').get(userId);
            if (!user) {
                console.warn('❌ Bulk-Import: User nicht gefunden (ID:', userId, ')');
                return res.status(401).json({ error: 'User nicht gefunden' });
            }
            
            req.user = { id: user.id };
            console.log('✅ Bulk-Import User authentifiziert (ID:', user.id, ')');
            next();
            
        } catch (e) {
            console.warn('❌ Bulk-Import: Token konnte nicht geparst werden');
            res.status(401).json({ error: 'Ungültiger Token' });
        }
        
    } catch (error) {
        console.error('❌ Bulk-Import Auth-Fehler:', error);
        res.status(500).json({ error: 'Auth-Fehler' });
    }
});

// ============================================================
// TABELLE SICHERSTELLEN
// ============================================================
function ensureSkusTable() {
    const tableCheck = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='skus'
    `).get();
    
    if (!tableCheck) {
        console.log('📦 Tabelle "skus" wird erstellt...');
        db.prepare(`
            CREATE TABLE IF NOT EXISTS skus (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                sku_name TEXT NOT NULL,
                shopify_product_id TEXT,
                destination TEXT NOT NULL,
                materials_json TEXT DEFAULT '[]',
                total_weight_grams REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES customers(id)
            )
        `).run();
        
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_skus_user_id ON skus(user_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_skus_destination ON skus(destination)`).run();
        console.log('✅ Tabelle "skus" erstellt');
    }
}

// ============================================================
// CSV IMPORT
// ============================================================
router.post('/csv', (req, res) => {
    try {
        ensureSkusTable();
        
        const userId = req.user.id;
        const { products } = req.body;
        
        let successCount = 0;
        let errorRows = [];

        products.forEach((row, index) => {
            const errors = validateRow(row, index + 2);
            
            if (errors.length > 0) {
                errorRows.push({ row: index + 2, errors, data: row });
                return;
            }
            
            try {
                saveProduct(userId, row);
                successCount++;
            } catch (dbError) {
                errorRows.push({
                    row: index + 2,
                    errors: ['Datenbankfehler: ' + dbError.message],
                    data: row
                });
            }
        });

        res.json({
            success: true,
            imported: successCount,
            errors: errorRows,
            total: products.length,
            message: errorRows.length === 0 
                ? `✅ ${successCount} Produkte erfolgreich importiert!`
                : `⚠️ ${successCount} Produkte importiert, ${errorRows.length} Fehler gefunden.`
        });

    } catch (error) {
        console.error('❌ CSV Import Fehler:', error);
        res.status(500).json({ error: 'CSV Import fehlgeschlagen: ' + error.message });
    }
});

// ============================================================
// VALIDIERUNG
// ============================================================
function validateRow(row, rowNumber) {
    const errors = [];
    const validMaterials = ['Karton/Pappe', 'Kunststoff', 'Papier', 'Glas', 'Metall', 'Holz', 'Sonstige'];
    const validRecyclable = ['Ja', 'Nein', 'TRUE', 'FALSE', 'true', 'false', '1', '0', 'Yes', 'No'];
    
    if (!row.sku || row.sku.trim().length === 0) {
        errors.push('SKU fehlt');
    }
    
    if (!row.produktname || row.produktname.trim().length === 0) {
        errors.push('Produktname fehlt');
    }
    
    if (!row.zielland || row.zielland.trim().length !== 2) {
        errors.push(`Zielland '${row.zielland}' ist ungültig`);
    }
    
    if (!row.material || !validMaterials.includes(row.material)) {
        errors.push(`Material '${row.material}' ist nicht erlaubt`);
    }
    
    const weight = parseFloat(row.gewicht_g);
    if (isNaN(weight) || weight <= 0) {
        errors.push(`Gewicht '${row.gewicht_g}' ist keine gültige Zahl`);
    }
    
    if (!row.recycelbar || !validRecyclable.includes(row.recycelbar)) {
        errors.push(`Recycelbar '${row.recycelbar}' ist ungültig`);
    }
    
    return errors;
}

// ============================================================
// SPEICHERN
// ============================================================
function saveProduct(userId, row) {
    const existing = db.prepare(`
        SELECT id, materials_json FROM skus 
        WHERE user_id = ? AND sku_name = ? AND destination = ?
    `).get(userId, row.produktname, row.zielland);
    
    const material = {
        material: row.material,
        weight_grams: parseFloat(row.gewicht_g),
        is_recyclable: ['Ja', 'TRUE', 'true', '1', 'Yes', 'yes'].includes(row.recycelbar) ? 1 : 0
    };
    
    if (existing) {
        const materials = JSON.parse(existing.materials_json || '[]');
        materials.push(material);
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);
        
        db.prepare(`
            UPDATE skus 
            SET materials_json = ?, total_weight_grams = ?
            WHERE id = ?
        `).run(JSON.stringify(materials), totalWeight, existing.id);
    } else {
        const materials = [material];
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);
        
        db.prepare(`
            INSERT INTO skus (
                user_id, sku_name, shopify_product_id, 
                destination, materials_json, total_weight_grams
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            userId,
            row.produktname,
            row.shopify_id || '',
            row.zielland,
            JSON.stringify(materials),
            totalWeight
        );
    }
}

module.exports = router;
