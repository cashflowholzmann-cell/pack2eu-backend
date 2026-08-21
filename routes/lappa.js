const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ============================================================
// LAPPA-API REGISTRIERUNG (MOCK)
// ============================================================
router.post('/register', async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.customer.sub;

    console.log('🔍 Lappa-Registrierung für Land:', country);
    console.log('🔍 Customer ID:', customer_id);

    try {
        // 1. Händlerdaten abrufen
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // 2. MOCK-Antwort
        const lappaResponse = {
            status: 'success',
            epr_number: `EPR-${country}-${Date.now().toString().slice(-6)}`,
            message: 'Registrierung erfolgreich (MOCK)',
            country: country,
            packaging_count: packaging ? packaging.length : 0,
            customer: customer.company_name
        };

        console.log('🔍 Lappa-Antwort:', lappaResponse);

        // 3. Aktivierung in der Datenbank AKTUALISIEREN
        const updateResult = db.prepare(`
            UPDATE activations 
            SET 
                provider_id = 'lappa',
                provider_epr_number = ?,
                provider_status = ?,
                provider_data = ?,
                status = 'active'
            WHERE customer_id = ? AND country_code = ?
        `).run(
            lappaResponse.epr_number || null,
            lappaResponse.status || 'pending',
            JSON.stringify(lappaResponse),
            customer_id,
            country
        );

        console.log('🔍 Update-Result:', updateResult);

        // 4. Falls keine Aktivierung existiert: Neue anlegen
        if (updateResult.changes === 0) {
            db.prepare(`
                INSERT INTO activations 
                (customer_id, country_code, status, provider_id, provider_epr_number, provider_status, provider_data)
                VALUES (?, ?, 'active', 'lappa', ?, ?, ?)
            `).run(
                customer_id,
                country,
                lappaResponse.epr_number || null,
                lappaResponse.status || 'pending',
                JSON.stringify(lappaResponse)
            );
            console.log('🔍 Neue Aktivierung angelegt');
        }

        res.json({
            status: lappaResponse.status,
            epr_number: lappaResponse.epr_number,
            message: lappaResponse.message
        });

    } catch (error) {
        console.error('❌ Lappa API Fehler:', error);
        res.status(500).json({ error: 'Fehler bei der Lappa-Registrierung: ' + error.message });
    }
});

module.exports = router;
