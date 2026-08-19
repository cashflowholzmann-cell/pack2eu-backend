const express = require('express');
const router = express.Router();
const db = require('../db');

// ============================================================
// LAPPA-API REGISTRIERUNG
// ============================================================
router.post('/register', async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.user.id; // Aus der Authentifizierung

    try {
        // 1. Händlerdaten abrufen
        const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // 2. Lappa-API aufrufen (HIER KOMMT DIE ECHTE API-INTEGRATION)
        // ⚠️ ACHTUNG: Das ist aktuell ein MOCK (Test-Daten)!
        // Ersetzen Sie diesen Teil später mit der echten Lappa-API
        const lappaResponse = await mockLappaRegistration(country, packaging, customer);

        // 3. Ergebnis speichern
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
    // Simulierte Verzögerung (wie bei einer echten API)
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Simulierte Lappa-Antwort
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
