// routes/bulk-import.js
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);
router.use(requireActiveSubscription);

// ============================================================
// CSV IMPORT
// ============================================================
router.post('/csv', (req, res) => {
    try {
        const userId = req.customer.sub;
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
        SELECT id, materials_json FROM product_packaging
        WHERE customer_id = ? AND sku_name = ? AND destination = ?
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
            UPDATE product_packaging
            SET materials_json = ?, total_weight_grams = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify(materials), totalWeight, existing.id);
    } else {
        const materials = [material];
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);

        db.prepare(`
            INSERT INTO product_packaging (
                customer_id, sku_name, shopify_product_id,
                destination, materials_json, total_weight_grams
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            userId,
            row.produktname,
            row.shopify_id || null,
            row.zielland,
            JSON.stringify(materials),
            totalWeight
        );
    }
}

module.exports = router;
