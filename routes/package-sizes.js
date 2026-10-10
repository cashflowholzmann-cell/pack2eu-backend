const express = require('express');
const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveSubscription);

// ============================================================
// EIGENE PAKETGRÖSSEN DES KUNDEN
//
// Die drei Standardgrößen (S/M/L) sind im Frontend fest hinterlegt
// und erscheinen nicht hier - diese Route liefert nur die vom Kunden
// selbst über den Produkt-Konfigurator hinzugefügten Größen.
// ============================================================
router.get('/', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT * FROM customer_package_sizes
            WHERE customer_id = ?
            ORDER BY created_at ASC
        `).all(req.customer.sub);
        res.json(rows);
    } catch (error) {
        console.error('❌ Fehler beim Laden der Paketgrößen:', error);
        res.status(500).json({ error: 'Fehler beim Laden der Paketgrößen' });
    }
});

router.post('/', (req, res) => {
    try {
        const label = String(req.body?.label || '').trim();
        const weight_grams = parseInt(req.body?.weight_grams);
        // Kundenwunsch: Umkartons sind so gut wie immer Vollpappe - Default,
        // aber pro Paketgröße frei überschreibbar (z.B. Versandbeutel statt
        // Karton).
        const material_subtype = String(req.body?.material_subtype || '').trim() || 'vollpappe';
        // Innenmaße optional (für die Karton-Empfehlung bei Bestellungen) -
        // ungültige/fehlende Werte werden als "keine Angabe" gespeichert.
        const readCm = (v) => {
            const n = parseFloat(String(v ?? '').replace(',', '.'));
            return Number.isFinite(n) && n > 0 && n <= 500 ? n : null;
        };
        const length_cm = readCm(req.body?.length_cm);
        const width_cm = readCm(req.body?.width_cm);
        const height_cm = readCm(req.body?.height_cm);

        if (!label || !Number.isInteger(weight_grams) || weight_grams <= 0) {
            return res.status(400).json({ error: 'Bezeichnung und Gewicht (g) sind erforderlich.' });
        }

        const result = db.prepare(`
            INSERT INTO customer_package_sizes (customer_id, label, weight_grams, material_subtype, length_cm, width_cm, height_cm)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(req.customer.sub, label, weight_grams, material_subtype, length_cm, width_cm, height_cm);

        const created = db.prepare('SELECT * FROM customer_package_sizes WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(created);
    } catch (error) {
        console.error('❌ Fehler beim Anlegen der Paketgröße:', error);
        res.status(500).json({ error: 'Fehler beim Anlegen der Paketgröße: ' + error.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const result = db.prepare(`
            DELETE FROM customer_package_sizes WHERE id = ? AND customer_id = ?
        `).run(req.params.id, req.customer.sub);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Paketgröße nicht gefunden.' });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Fehler beim Löschen der Paketgröße:', error);
        res.status(500).json({ error: 'Fehler beim Löschen der Paketgröße' });
    }
});

module.exports = router;
