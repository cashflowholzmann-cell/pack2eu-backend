// routes/bulk-import.js
const express = require('express');
const { db } = require('../db');
const router = express.Router();

// ============================================================
// AUTH-MIDDLEWARE
// ============================================================
router.use((req, res, next) => {
    try {
        // 1. Versuche, den User aus dem Authorization-Header zu holen
        const authHeader = req.headers.authorization;
        const token = authHeader?.split(' ')[1];
        
        if (token) {
            try {
                // 2. Token parsen und User-ID extrahieren
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                const userId = payload.sub;
                
                if (userId) {
                    const user = db.prepare('SELECT id FROM customers WHERE id = ?').get(userId);
                    if (user) {
                        req.user = { id: user.id };
                        console.log('✅ Bulk-Import User authentifiziert (ID:', user.id, ')');
                        return next();
                    }
                }
            } catch (e) {
                console.warn('⚠️ Bulk-Import: Token konnte nicht geparst werden');
            }
        }
        
        // 3. FALLBACK: Ersten User verwenden (NUR FÜR ENTWICKLUNG!)
        console.warn('⚠️ Bulk-Import: Kein gültiger Token, verwende Fallback-User');
        const firstUser = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get();
        if (firstUser) {
            req.user = { id: firstUser.id };
            console.warn('⚠️ Bulk-Import Fallback: Verwende User (ID:', firstUser.id, ')');
            return next();
        }
        
        // 4. Kein User gefunden
        console.warn('❌ Bulk-Import: Kein User in der Datenbank gefunden');
        res.status(401).json({ error: 'Nicht authentifiziert' });
        
    } catch (error) {
        console.error('❌ Bulk-Import Auth-Fehler:', error);
        res.status(500).json({ error: 'Auth-Fehler' });
    }
});

// ============================================================
// CSV IMPORT
// ============================================================
router.post('/csv', (req, res) => {
    try {
        const userId = req.user.id;
        const { products } = req.body;
        
        let successCount = 0;
        let errorRows = [];

        // Validiere jede Zeile
        products.forEach((row, index) => {
            const errors = validateRow(row, index + 2); // +2 wegen Header und 0-basiert
            
            if (errors.length > 0) {
                errorRows.push({ row: index + 2, errors, data: row });
                return;
            }
            
            // Speichere das Produkt
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
    
    // 1. SKU prüfen
    if (!row.sku || row.sku.trim().length === 0) {
        errors.push('SKU fehlt');
    }
    
    // 2. Produktname prüfen
    if (!row.produktname || row.produktname.trim().length === 0) {
        errors.push('Produktname fehlt');
    }
    
    // 3. Zielland prüfen
    if (!row.zielland || row.zielland.trim().length !== 2) {
        errors.push(`Zielland '${row.zielland}' ist ungültig (z.B. DE, AT, FR)`);
    }
    
    // 4. Material prüfen
    if (!row.material || !validMaterials.includes(row.material)) {
        errors.push(`Material '${row.material}' ist nicht erlaubt. Erlaubt: ${validMaterials.join(', ')}`);
    }
    
    // 5. Gewicht prüfen (muss Zahl sein)
    const weight = parseFloat(row.gewicht_g);
    if (isNaN(weight) || weight <= 0) {
        errors.push(`Gewicht '${row.gewicht_g}' ist keine gültige Zahl`);
    }
    
    // 6. Recycelbar prüfen
    if (!row.recycelbar || !validRecyclable.includes(row.recycelbar)) {
        errors.push(`Recycelbar '${row.recycelbar}' ist ungültig. Erlaubt: Ja/Nein oder TRUE/FALSE`);
    }
    
    return errors;
}

// ============================================================
// SPEICHERN
// ============================================================
function saveProduct(userId, row) {
    // Prüfe, ob das SKU bereits existiert
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
        // Bestehendes SKU: Material hinzufügen
        const materials = JSON.parse(existing.materials_json || '[]');
        materials.push(material);
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);
        
        db.prepare(`
            UPDATE skus 
            SET materials_json = ?, total_weight_grams = ?
            WHERE id = ?
        `).run(JSON.stringify(materials), totalWeight, existing.id);
    } else {
        // Neues SKU anlegen
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
