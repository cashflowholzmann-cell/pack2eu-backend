const express = require('express');
const router = express.Router();
const { db } = require('../db'); // ⭐ GEÄNDERT! Wie in activations.js
const { requireAuth } = require('../middleware/auth'); // ⭐ NEU! Für echte Auth

// ============================================================
// LAPPA-API REGISTRIERUNG (MIT ECHTER AUTH)
// ============================================================
router.post('/register', requireAuth, async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.customer.sub; // ⭐ Von der echten Auth-Middleware

    try {
        // 1. Händlerdaten abrufen
        const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // 2. Lappa-API aufrufen (MOCK)
        const lappaResponse = await mockLappaRegistration(country, packaging, customer);

        // 3. Ergebnis speichern (mit UPDATE, weil die Aktivierung bereits existiert)
        await db.run(`
            UPDATE activations 
            SET lappa_epr_number = ?, lappa_status = ?, lappa_data = ?
            WHERE customer_id = ? AND country_code = ?
        `, [
            lappaResponse.epr_number || null,
            lappaResponse.status || 'pending',
            JSON.stringify(lappaResponse),
            customer_id,
            country
        ]);

        res.json(lappaResponse);

    } catch (error) {
        console.error('Lappa API Fehler:', error);
        res.status(500).json({ error: 'Fehler bei der Lappa-Registrierung: ' + error.message });
    }
});

// ============================================================
// MOCK-FUNKTION (NUR ZUM TESTEN!)
// ============================================================
async function mockLappaRegistration(country, packaging, customer) {
    // Simulierte Verzögerung
    await new Promise(resolve => setTimeout(resolve, 1000));

    return {
        status: 'success',
        epr_number: `EPR-${country}-${Date.now().toString().slice(-6)}`,
        message: 'Registrierung erfolgreich (MOCK)',
        country: country,
        packaging_count: packaging.length,
        customer: customer.company_name
    };
}

module.exports = router;
