const express = require('express');
const router = express.Router();
const db = require('../db');
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
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // ⭐ MOCK-Antwort
        const lappaResponse = {
            status: 'success',
            epr_number: `EPR-${country}-${Date.now().toString().slice(-6)}`,
            message: 'Registrierung erfolgreich (MOCK)',
            country: country,
            packaging_count: packaging ? packaging.length : 0,
            customer: customer.company_name
        };

        console.log('🔍 Lappa-Antwort:', lappaResponse);

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

        if (updateResult.changes === 0) {
            db.prepare(`
                INSERT INTO activations 
                (customer_id, country_code, status, provider_id, provider_epr_number, provider_status, provider_data, mode)
                VALUES (?, ?, 'active', 'lappa', ?, ?, ?, ?)
            `).run(
                customer_id,
                country,
                lappaResponse.epr_number || null,
                lappaResponse.status || 'pending',
                JSON.stringify(lappaResponse),
                'premium' // ⭐ NEU: Bei Lappa-Registrierung automatisch Premium
            );
            console.log('🔍 Neue Aktivierung mit Premium-Modus angelegt');
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

// ============================================================
// ⭐ NEU: BEVOLLMÄCHTIGTEN BUCHEN (FÜR PREMIUM-UPGRADE)
// ============================================================
router.post('/book-representative', async (req, res) => {
    const { country } = req.body;
    const customer_id = req.customer.sub;

    console.log('🔍 Bevollmächtigten buchen für Land:', country);

    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // ⭐ MOCK: Bevollmächtigten buchen
        const representativeResponse = {
            status: 'success',
            representative_id: `REP-${country}-${Date.now().toString().slice(-6)}`,
            message: 'Bevollmächtigter erfolgreich gebucht (MOCK)',
            country: country,
            customer: customer.company_name,
            valid_until: '2027-12-31'
        };

        console.log('🔍 Bevollmächtigten-Antwort:', representativeResponse);

        // ⭐ Aktivierung auf Premium setzen
        const updateResult = db.prepare(`
            UPDATE activations 
            SET 
                mode = 'premium',
                provider_id = 'lappa',
                provider_status = 'success',
                provider_data = ?,
                status = 'active'
            WHERE customer_id = ? AND country_code = ?
        `).run(
            JSON.stringify(representativeResponse),
            customer_id,
            country
        );

        if (updateResult.changes === 0) {
            return res.status(404).json({ error: 'Land nicht aktiviert.' });
        }

        res.json({
            success: true,
            message: representativeResponse.message,
            representative_id: representativeResponse.representative_id,
            country: country,
            valid_until: representativeResponse.valid_until
        });

    } catch (error) {
        console.error('❌ Fehler beim Buchen des Bevollmächtigten:', error);
        res.status(500).json({ error: 'Fehler beim Buchen des Bevollmächtigten: ' + error.message });
    }
});

module.exports = router;
