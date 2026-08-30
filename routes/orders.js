// routes/orders.js
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Herkunfts-Kanal einer manuellen Bestellung - rein zur Zuordnung/
// Auswertung ("woher kamen meine Bestellungen"), keine Sync-Funktion.
const VALID_SOURCE_PLATFORMS = ['own_shop', 'shopify', 'etsy', 'kaufland', 'amazon', 'ebay'];
function normalizeSourcePlatform(value) {
    return VALID_SOURCE_PLATFORMS.includes(value) ? value : 'own_shop';
}

// ============================================================
// MANUELLE BESTELLUNG
// ============================================================
router.post('/manual', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { order_id, destination_country, total_weight_grams, packaging_data, created_at, source_platform } = req.body;

        // Bestellung speichern
        const stmt = db.prepare(`
            INSERT INTO orders (
                user_id,
                shopify_order_id,
                destination_country,
                total_weight_grams,
                packaging_data,
                created_at,
                source_platform
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            userId,
            order_id || 'MANUAL-' + Date.now(),
            destination_country,
            total_weight_grams || 0,
            JSON.stringify(packaging_data || []),
            created_at || new Date().toISOString(),
            normalizeSourcePlatform(source_platform)
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
// MANUELLE BESTELLUNG KORRIGIEREN
//
// Nur für selbst angelegte Bestellungen (orders-Tabelle) - über Shopify
// synchronisierte Bestellungen (shopify_orders) werden hier absichtlich
// nicht angefasst, die kommen extern und müssten in Shopify selbst
// korrigiert werden.
// ============================================================
router.put('/manual/:id', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { id } = req.params;
        const { order_id, destination_country, total_weight_grams, packaging_data, created_at, source_platform } = req.body;

        const existing = db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').get(id, userId);
        if (!existing) {
            return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
        }

        db.prepare(`
            UPDATE orders
            SET shopify_order_id = ?,
                destination_country = ?,
                total_weight_grams = ?,
                packaging_data = ?,
                created_at = ?,
                source_platform = ?
            WHERE id = ? AND user_id = ?
        `).run(
            order_id || 'MANUAL-' + Date.now(),
            destination_country,
            total_weight_grams || 0,
            JSON.stringify(packaging_data || []),
            created_at || new Date().toISOString(),
            normalizeSourcePlatform(source_platform),
            id,
            userId
        );

        res.json({
            success: true,
            message: 'Bestellung erfolgreich aktualisiert'
        });

    } catch (error) {
        console.error('❌ Bestellung bearbeiten Fehler:', error);
        res.status(500).json({
            error: 'Bestellung konnte nicht aktualisiert werden',
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
        // (source, id) über beide Tabellen hinweg eindeutig identifizierbar
        // (u.a. für die Bearbeiten-Berechtigung in editOrder()).
        // "origin" ist der tatsächliche Herkunfts-Kanal fürs Anzeigen eines
        // Icons je Bestellung - bei Shopify/Marktplatz-Bestellungen identisch
        // mit "source", bei manuellen Bestellungen frei waehlbar (siehe
        // source_platform).
        const orders = db.prepare(`
            SELECT 'manual' AS source, COALESCE(source_platform, 'own_shop') AS origin, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, created_at
            FROM orders
            WHERE user_id = ?

            UNION ALL

            SELECT 'shopify' AS source, 'shopify' AS origin, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, created_at
            FROM shopify_orders
            WHERE customer_id = ?

            UNION ALL

            SELECT platform AS source, platform AS origin, id, external_order_id AS shopify_order_id, destination_country, total_weight_grams, packaging_data, created_at
            FROM marketplace_orders
            WHERE customer_id = ?

            ORDER BY created_at DESC
        `).all(userId, userId, userId);

        res.json(orders);

    } catch (error) {
        console.error('❌ Orders Fehler:', error);
        res.status(500).json({ error: 'Bestellungen konnten nicht geladen werden' });
    }
});

module.exports = router;
