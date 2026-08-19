const express = require('express');
const router = express.Router();
const db = require('../db'); // ⭐ db ist jetzt direkt die Datenbank!
const { requireAuth } = require('../middleware/auth');

// ⭐ Auth für alle Routen in dieser Datei
router.use(requireAuth);

// ============================================================
// LAPPA-API REGISTRIERUNG
// ============================================================
router.post('/register', async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.customer.sub;

    console.log('🔍 Lappa-Registrierung für Land:', country);
    console.log('🔍 Customer ID:', customer_id);

    try {
        // 1. Händlerdaten abrufen
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        console.log('🔍 Gefundener Kunde:', customer);

        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // 2. Lappa-API aufrufen (MOCK)
        const lappaResponse = {
            status: 'success',
            epr_number: `EPR-${country}-${Date.now().toString().slice(-6)}`,
            message: 'Registrierung erfolgreich (MOCK)',
            country: country,
            packaging_count: packaging ? packaging.length : 0,
            customer: customer.company_name
        };

        console.log('🔍 Lappa-Antwort:', lappaResponse);

        // 3. Aktivierung in der Datenbank aktualisieren
        const updateResult = db.prepare(`
            UPDATE activations 
            SET lappa_epr_number = ?, lappa_status = ?, lappa_data = ?, status = 'active'
            WHERE customer_id = ? AND country_code = ?
        `).run(
            lappaResponse.epr_number || null,
            lappaResponse.status || 'pending',
            JSON.stringify(lappaResponse),
            customer_id,
            country
        );

        console.log('🔍 Update-Result:', updateResult);

        if (updateResult.changes === 0) {
            // Falls keine Aktivierung existiert, eine neue anlegen
            db.prepare(`
                INSERT INTO activations (customer_id, country_code, status, lappa_epr_number, lappa_status, lappa_data)
                VALUES (?, ?, 'active', ?, ?, ?)
            `).run(
                customer_id,
                country,
                lappaResponse.epr_number || null,
                lappaResponse.status || 'pending',
                JSON.stringify(lappaResponse)
            );
            console.log('🔍 Neue Aktivierung angelegt');
        }

        res.json(lappaResponse);

    } catch (error) {
        console.error('❌ Lappa API Fehler:', error);
        res.status(500).json({ error: 'Fehler bei der Lappa-Registrierung: ' + error.message });
    }
});

module.exports = router;
