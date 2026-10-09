// routes/orders.js
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { normalizeCountryCode } = require('../lib/country-normalize');
const { emptyWeeeBatteryItems } = require('../lib/weee-battery-items');
const { resolveSkuByIdentifier } = require('./skus');

const router = express.Router();

router.use(requireAuth);
router.use(requireActiveSubscription);

// Herkunfts-Kanal einer manuellen Bestellung - rein zur Zuordnung/
// Auswertung ("woher kamen meine Bestellungen"), keine Sync-Funktion.
const VALID_SOURCE_PLATFORMS = ['own_shop', 'shopify', 'etsy', 'kaufland', 'amazon', 'ebay'];
function normalizeSourcePlatform(value) {
    return VALID_SOURCE_PLATFORMS.includes(value) ? value : 'own_shop';
}

// Kundenwunsch: eine manuelle Bestellung kann neben reinen
// Verpackungsartikeln auch Elektro-/Batterieprodukte enthalten (z.B. ein
// batteriebetriebenes Gerät). Der Bestellungs-Konfigurator im Frontend
// berechnet das Stückzahl-Aggregat bereits clientseitig aus den
// ausgewählten SKUs (siehe computeOrderWeeeBatteryItems() in
// dashboard.html, analog zu computeOrderAggregate() für packaging_data) -
// hier nur grob auf die erwartete Form {weee:[...], battery:[...]}
// validieren, nicht die einzelnen SKUs erneut nachschlagen (genau wie
// packaging_data bereits unverändert vom Client übernommen wird).
function normalizeWeeeBatteryItems(value) {
    if (!value || typeof value !== 'object') return emptyWeeeBatteryItems();
    return {
        weee: Array.isArray(value.weee) ? value.weee : [],
        battery: Array.isArray(value.battery) ? value.battery : []
    };
}

// ============================================================
// MANUELLE BESTELLUNG
// ============================================================
router.post('/manual', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { order_id, destination_country, total_weight_grams, packaging_data, weee_battery_items, created_at, source_platform } = req.body;

        // Bestellung speichern
        const stmt = db.prepare(`
            INSERT INTO orders (
                user_id,
                shopify_order_id,
                destination_country,
                total_weight_grams,
                packaging_data,
                weee_battery_items_json,
                created_at,
                source_platform
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            userId,
            order_id || 'MANUAL-' + Date.now(),
            destination_country,
            total_weight_grams || 0,
            JSON.stringify(packaging_data || []),
            JSON.stringify(normalizeWeeeBatteryItems(weee_battery_items)),
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
        const { order_id, destination_country, total_weight_grams, packaging_data, weee_battery_items, created_at, source_platform } = req.body;

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
                weee_battery_items_json = ?,
                created_at = ?,
                source_platform = ?
            WHERE id = ? AND user_id = ?
        `).run(
            order_id || 'MANUAL-' + Date.now(),
            destination_country,
            total_weight_grams || 0,
            JSON.stringify(packaging_data || []),
            JSON.stringify(normalizeWeeeBatteryItems(weee_battery_items)),
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
        // has_unclassified_items: nur marketplace_orders (Base/BaseLinker,
        // Amazon, eBay, Etsy, Kaufland, Skroutz) kennt automatisch
        // angelegte, noch unklassifizierte Artikel (siehe lib/marketplace-
        // auto-sku.js) - manuelle und Shopify-Bestellungen liefern hier
        // konstant 0, damit die Spaltenzahl in allen drei UNION-ALL-
        // Zweigen übereinstimmt.
        const orders = db.prepare(`
            SELECT 'manual' AS source, COALESCE(source_platform, 'own_shop') AS origin, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, 0 AS has_unclassified_items, created_at
            FROM orders
            WHERE user_id = ?

            UNION ALL

            SELECT 'shopify' AS source, 'shopify' AS origin, id, shopify_order_id, destination_country, total_weight_grams, packaging_data, 0 AS has_unclassified_items, created_at
            FROM shopify_orders
            WHERE customer_id = ?

            UNION ALL

            SELECT platform AS source, platform AS origin, id, external_order_id AS shopify_order_id, destination_country, total_weight_grams, packaging_data, has_unclassified_items, created_at
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

// ============================================================
// MARKTPLATZ-BESTELLUNG KORRIGIEREN (Zielland und/oder Gewicht)
//
// Marktplatz-Bestellungen (marketplace_orders - Base/BaseLinker, Etsy,
// Kaufland, Amazon, eBay, Skroutz) kommen per Sync/Webhook rein und
// hatten bisher KEINE Korrekturmöglichkeit, falls die Quelle ein
// falsches/unbekanntes Zielland liefert (z.B. Base/BaseLinker lieferte
// vor der Normalisierung in routes/baselinker.js teils Klartext wie
// "Italy" statt "IT" - Audit-Fund aus dem Jahresreport) oder ein
// offensichtlich falsches Gewicht (z.B. Tippfehler beim Kunden in Base
// selbst, wie "3480000g" statt "348g"). Shopify- und manuelle
// Bestellungen haben ihre eigene Korrektur bereits (siehe PUT
// /manual/:id oben bzw. Shopify-Design-Entscheidung, dort bewusst
// keine Korrektur anzubieten).
//
// Beide Felder sind optional, nur mitgeschickte werden geändert. Bei
// einer Gewichtskorrektur bleiben echte, aus einer SKU-Zuordnung
// stammende Materialien unangetastet - nur der nicht zugeordnete
// "sonstige"-Rest (siehe routes/baselinker.js) wird auf die neue
// Differenz angepasst, damit Verpackungsstatistik/Jahresreport/
// Öko-Gebühr-Schätzung wieder zum korrigierten Gewicht passen.
// ============================================================
router.put('/marketplace/:id', (req, res) => {
    try {
        const userId = req.customer.sub;
        const { id } = req.params;
        const { destination_country, total_weight_grams, packaging_data } = req.body;

        const existing = db.prepare(
            'SELECT id, packaging_data FROM marketplace_orders WHERE id = ? AND customer_id = ?'
        ).get(id, userId);
        if (!existing) {
            return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
        }

        const updates = [];
        const params = [];

        if (destination_country !== undefined) {
            const normalized = normalizeCountryCode(destination_country);
            if (!normalized) {
                return res.status(400).json({ error: 'Ungültiger Ländercode.' });
            }
            updates.push('destination_country = ?');
            params.push(normalized);
        }

        if (Array.isArray(packaging_data)) {
            // Nutzer teilt das Gewicht jetzt explizit auf echte Materialien
            // auf (gleiche Maske wie im Produkte-Editor, inkl. material_
            // subtype) - ersetzt die reine "sonstige"-Restlogik unten
            // komplett, weil hier kein anonymer Rest mehr übrig bleiben
            // soll. Kundenwunsch: eine einzige, konsistente Korrektur-
            // Maske für alle Bestellquellen statt nur Zielland+Gesamt-
            // gewicht.
            const materials = packaging_data
                .map(m => {
                    const cleaned = {
                        material: String(m.material || 'sonstige').trim() || 'sonstige',
                        weight_grams: Math.max(0, Math.round(Number(m.weight_grams) || 0)),
                        is_recyclable: Boolean(m.is_recyclable)
                    };
                    const subtype = String(m.material_subtype || '').trim();
                    if (subtype) cleaned.material_subtype = subtype;
                    return cleaned;
                })
                .filter(m => m.weight_grams > 0);

            if (materials.length === 0) {
                return res.status(400).json({ error: 'Mindestens ein Material mit Gewicht über 0g ist erforderlich.' });
            }

            const newWeight = materials.reduce((sum, m) => sum + m.weight_grams, 0);
            updates.push('total_weight_grams = ?', 'packaging_data = ?');
            params.push(newWeight, JSON.stringify(materials));
        } else if (total_weight_grams !== undefined) {
            const newWeight = Number(total_weight_grams);
            if (!Number.isFinite(newWeight) || newWeight < 0) {
                return res.status(400).json({ error: 'Ungültiges Gewicht.' });
            }

            let materials;
            try {
                materials = JSON.parse(existing.packaging_data || '[]');
            } catch (e) {
                materials = [];
            }
            if (!Array.isArray(materials)) materials = [];

            const matchedMaterials = materials.filter(m => m.material !== 'sonstige');
            const matchedWeight = matchedMaterials.reduce((sum, m) => sum + (Number(m.weight_grams) || 0), 0);
            const remainder = Math.max(newWeight - matchedWeight, 0);

            const newMaterials = remainder > 0
                ? [...matchedMaterials, { material: 'sonstige', weight_grams: remainder, is_recyclable: false }]
                : matchedMaterials;

            updates.push('total_weight_grams = ?', 'packaging_data = ?');
            params.push(newWeight, JSON.stringify(newMaterials));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'Keine Änderungen angegeben.' });
        }

        // Markiert die Zeile als manuell korrigiert - der nächste Sync
        // (aktuell nur routes/baselinker.js, siehe dortiger Kommentar)
        // überschreibt Zielland/Gewicht/Materialien dann nicht mehr
        // stillschweigend mit dem Stand aus der Marktplatz-Quelle. Über
        // genau diese Maske bleibt die Korrektur trotzdem jederzeit
        // änderbar (z.B. falls sich beim ersten Korrigieren selbst ein
        // Tippfehler eingeschlichen hat).
        updates.push('manually_corrected = 1');

        // Die Korrektur legt die Materialaufteilung jetzt explizit fest -
        // die Bestellung trägt damit keinen unklassifizierten Posten mehr
        // und verliert die rote Markierung in der Bestellliste (siehe
        // marketplace_orders.has_unclassified_items).
        updates.push('has_unclassified_items = 0');

        params.push(id, userId);
        db.prepare(`UPDATE marketplace_orders SET ${updates.join(', ')} WHERE id = ? AND customer_id = ?`).run(...params);

        res.json({ success: true });

    } catch (error) {
        console.error('❌ Marktplatz-Bestellung korrigieren Fehler:', error);
        res.status(500).json({ error: 'Bestellung konnte nicht korrigiert werden.' });
    }
});

// ============================================================
// CSV-BESTELLUNGS-BULK-IMPORT
//
// Kundenwunsch (Bella Rosa/bmind, Griechenland): Verkäufe über einen
// Marktplatz ohne eigene Pack2EU-Integration (z.B. bmind) lassen sich
// nicht automatisch synchronisieren. Statt jede Bestellung einzeln über
// POST /manual anzulegen, können mehrere Bestellungen per CSV importiert
// werden - analog zum bestehenden CSV-Massen-Link (routes/skus.js,
// POST /skus/bulk-link): CSV wird clientseitig geparst, die Zeilen kommen
// hier als JSON an.
//
// Erwartete Spalten je Zeile: artikel (Pack2EU-SKU-Name oder Base-SKU,
// wie bei resolveSkuByIdentifier), menge, zielland (Code oder Klartext),
// optional bestellnummer (zum Gruppieren mehrerer Artikel-Zeilen zu EINER
// Bestellung - siehe packaging_data als Array bei POST /manual) und datum.
// ============================================================
router.post('/bulk-import', (req, res) => {
    try {
        const userId = req.customer.sub;
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Keine Zeilen zum Verarbeiten übermittelt.' });
        }

        const errors = [];
        const orderGroups = new Map();

        rows.forEach((row, index) => {
            const rowNumber = index + 2; // Zeile 1 ist der CSV-Header
            const articleIdentifier = String(row.artikel || '').trim();
            const quantity = Number(row.menge) > 0 ? Number(row.menge) : 1;
            const destinationRaw = String(row.zielland || '').trim();
            const orderRef = String(row.bestellnummer || '').trim();

            if (!articleIdentifier) {
                errors.push({ row: rowNumber, error: 'Spalte "artikel" fehlt.' });
                return;
            }
            if (!destinationRaw) {
                errors.push({ row: rowNumber, error: 'Spalte "zielland" fehlt.' });
                return;
            }

            const destination_country = normalizeCountryCode(destinationRaw);
            if (!destination_country) {
                errors.push({ row: rowNumber, error: `Zielland "${destinationRaw}" nicht erkannt.` });
                return;
            }

            const sku = resolveSkuByIdentifier(userId, articleIdentifier);
            if (!sku) {
                errors.push({ row: rowNumber, error: `Artikel "${articleIdentifier}" nicht gefunden.` });
                return;
            }

            let materials = [];
            try { materials = JSON.parse(sku.materials_json || '[]'); } catch { materials = []; }

            // Ohne Bestellnummer gilt jede Zeile als eigene Bestellung -
            // sonst werden mehrere Zeilen mit derselben Bestellnummer zu
            // einer Bestellung mit mehreren Verpackungs-Posten zusammengefasst.
            const groupKey = orderRef || `__row_${index}`;
            if (!orderGroups.has(groupKey)) {
                orderGroups.set(groupKey, {
                    order_ref: orderRef || null,
                    destination_country,
                    created_at: row.datum ? String(row.datum).trim() : null,
                    totalWeight: 0,
                    packaging_data: []
                });
            }
            const group = orderGroups.get(groupKey);

            group.totalWeight += Number(sku.total_weight_grams || 0) * quantity;
            materials.forEach((material) => {
                group.packaging_data.push({
                    material: material.material,
                    material_subtype: material.material_subtype || null,
                    weight_grams: Number(material.weight_grams || 0) * quantity,
                    is_recyclable: material.is_recyclable
                });
            });
        });

        const insertStmt = db.prepare(`
            INSERT INTO orders (
                user_id, shopify_order_id, destination_country, total_weight_grams,
                packaging_data, weee_battery_items_json, created_at, source_platform
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let imported = 0;
        orderGroups.forEach((group) => {
            insertStmt.run(
                userId,
                group.order_ref || ('CSV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
                group.destination_country,
                group.totalWeight,
                JSON.stringify(group.packaging_data),
                JSON.stringify(emptyWeeeBatteryItems()),
                group.created_at || new Date().toISOString(),
                'own_shop'
            );
            imported++;
        });

        res.json({
            success: true,
            imported,
            errors,
            total: rows.length,
            message: errors.length === 0
                ? `✅ ${imported} Bestellung(en) erfolgreich importiert!`
                : `⚠️ ${imported} Bestellung(en) importiert, ${errors.length} Fehler gefunden.`
        });
    } catch (error) {
        console.error('❌ Bestellungs-Bulk-Import Fehler:', error);
        res.status(500).json({ error: 'Bulk-Import fehlgeschlagen: ' + error.message });
    }
});

module.exports = router;
