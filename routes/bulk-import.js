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
// MATERIAL-NAMEN NORMALISIEREN
//
// Kundenwunsch 10/2026 (Bellarosa): eigene CSV-Vorlagen nutzen oft
// englische oder anders geschriebene Materialnamen. Wichtiger als der
// reine Komfort: der CSV-Import speicherte bisher die ANZEIGE-Strings
// ('Karton/Pappe', 'Kunststoff', ...) direkt als Material-Schlüssel -
// jeder andere Teil der App (materialLabel() im Dashboard, die
// Material-Charts im Beauftragten-Portal, die Anomalie-Erkennung in
// lib/sku-anomalies.js, der Material-Spar-Check in
// lib/material-savings.js) erwartet dagegen die kleingeschriebenen
// Schlüssel aus MATERIAL_KEYS (karton, kunststoff, papier, glas,
// metall, holz, sonstige). Nur zufällig fiel das bisher kaum auf, weil
// findRate() in material-savings.js ohnehin lowercased - "Karton/Pappe"
// matchte dort trotzdem nie (der Schrägstrich blieb), und in
// Material-Charts/Anomalie-Erkennung liefen CSV-importierte Produkte
// dadurch unbemerkt als eigene, falsch sortierte Kategorie statt sich
// mit manuell erfassten Produkten zusammenzufassen. Ab hier wird JEDER
// erkannte Materialname auf genau diese kanonischen Schlüssel
// normalisiert, bevor er gespeichert wird.
const MATERIAL_SYNONYMS = {
    karton: 'karton', pappe: 'karton', 'karton/pappe': 'karton', kartonpappe: 'karton',
    cardboard: 'karton', carton: 'karton', box: 'karton',
    kunststoff: 'kunststoff', plastik: 'kunststoff', plastic: 'kunststoff',
    papier: 'papier', paper: 'papier',
    glas: 'glas', glass: 'glas',
    metall: 'metall', metal: 'metall',
    holz: 'holz', wood: 'holz',
    sonstige: 'sonstige', sonstiges: 'sonstige', other: 'sonstige', misc: 'sonstige', miscellaneous: 'sonstige'
};

function normalizeMaterial(value) {
    if (!value) return null;
    const key = String(value).trim().toLowerCase().replace(/[^a-zäöüß/]/g, '');
    return MATERIAL_SYNONYMS[key] || null;
}

const YES_VALUES = ['ja', 'yes', 'true', '1'];
const NO_VALUES = ['nein', 'no', 'false', '0', ''];

function parseYesNo(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (YES_VALUES.includes(normalized)) return true;
    if (NO_VALUES.includes(normalized)) return false;
    return null; // unerkannt - Aufrufer entscheidet, ob das ein Fehler oder ein harmloses "nein" ist
}

// ============================================================
// VALIDIERUNG
//
// "zielland" ist bewusst NICHT mehr Pflicht (Kundenwunsch 10/2026,
// siehe oben): die physische Verpackungs-Zusammensetzung eines
// Produkts ist unabhängig vom Zielland - nur die rechtlichen Pflichten
// pro Land hängen daran, und die laufen über die Meldungen
// (submissions), nicht über product_packaging. Ein Produkt ohne
// hinterlegtes Zielland gilt einfach für alle Länder.
// ============================================================
function validateRow(row, rowNumber) {
    const errors = [];

    if (!row.sku || row.sku.trim().length === 0) {
        errors.push('SKU fehlt');
    }

    if (!row.produktname || row.produktname.trim().length === 0) {
        errors.push('Produktname fehlt');
    }

    if (row.zielland && row.zielland.trim().length > 0 && row.zielland.trim().length !== 2) {
        errors.push(`Zielland '${row.zielland}' ist ungültig`);
    }

    if (!normalizeMaterial(row.material)) {
        errors.push(`Material '${row.material}' ist nicht erlaubt`);
    }

    const weight = parseFloat(row.gewicht_g);
    if (isNaN(weight) || weight <= 0) {
        errors.push(`Gewicht '${row.gewicht_g}' ist keine gültige Zahl`);
    }

    if (parseYesNo(row.recycelbar) === null) {
        errors.push(`Recycelbar '${row.recycelbar}' ist ungültig`);
    }

    // WEEE-/Batterie-Angaben sind optional - nur geprüft, wenn das
    // CSV sie überhaupt mitbringt (siehe sku-config.js-Pendant im
    // Produkt-Editor: dieselben vier Felder dort sind ebenfalls optional).
    if (row.contains_electronics !== undefined && row.contains_electronics !== '' && parseYesNo(row.contains_electronics) === null) {
        errors.push(`Enthält Elektronik '${row.contains_electronics}' ist ungültig`);
    }
    if (row.contains_battery !== undefined && row.contains_battery !== '' && parseYesNo(row.contains_battery) === null) {
        errors.push(`Enthält Batterie '${row.contains_battery}' ist ungültig`);
    }

    return errors;
}

// ============================================================
// SPEICHERN
//
// Mehrere Zeilen mit demselben Produktnamen (+ Zielland) fasst das
// bereits bestehende Merge-Verhalten unten automatisch zu EINEM
// Produkt mit mehreren Materialzeilen zusammen - praktisch für
// mehrteilige Verpackungen (Flasche + Deckel + Etikett als eigene
// Zeilen, gleicher Produktname).
// ============================================================
function saveProduct(userId, row) {
    const destination = row.zielland && row.zielland.trim() ? row.zielland.trim().toUpperCase() : null;

    const existing = db.prepare(`
        SELECT id, materials_json FROM product_packaging
        WHERE customer_id = ? AND sku_name = ? AND destination IS ?
    `).get(userId, row.produktname, destination);

    const material = {
        material: normalizeMaterial(row.material),
        weight_grams: parseFloat(row.gewicht_g),
        is_recyclable: parseYesNo(row.recycelbar) ? 1 : 0
    };

    const containsElectronics = row.contains_electronics !== undefined ? parseYesNo(row.contains_electronics) === true : false;
    const containsBattery = row.contains_battery !== undefined ? parseYesNo(row.contains_battery) === true : false;
    const weeeCategory = containsElectronics && row.weee_category ? String(row.weee_category).trim() : null;
    const batteryType = containsBattery && row.battery_type ? String(row.battery_type).trim() : null;

    if (existing) {
        const materials = JSON.parse(existing.materials_json || '[]');
        materials.push(material);
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);

        db.prepare(`
            UPDATE product_packaging
            SET materials_json = ?, total_weight_grams = ?,
                is_electrical_equipment = CASE WHEN ? THEN 1 ELSE is_electrical_equipment END,
                weee_category = COALESCE(?, weee_category),
                contains_battery = CASE WHEN ? THEN 1 ELSE contains_battery END,
                battery_type = COALESCE(?, battery_type),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            JSON.stringify(materials), totalWeight,
            containsElectronics ? 1 : 0, weeeCategory,
            containsBattery ? 1 : 0, batteryType,
            existing.id
        );
    } else {
        const materials = [material];
        const totalWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);

        db.prepare(`
            INSERT INTO product_packaging (
                customer_id, sku_name, shopify_product_id,
                destination, materials_json, total_weight_grams,
                is_electrical_equipment, weee_category, contains_battery, battery_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            userId,
            row.produktname,
            row.shopify_id || null,
            destination,
            JSON.stringify(materials),
            totalWeight,
            containsElectronics ? 1 : 0,
            weeeCategory,
            containsBattery ? 1 : 0,
            batteryType
        );
    }
}

module.exports = router;
