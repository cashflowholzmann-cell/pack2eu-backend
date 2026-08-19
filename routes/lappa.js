const express = require('express');
const router = express.Router();
const dbModule = require('../db'); // ⭐ GEÄNDERT!
const db = dbModule.db; // ⭐ GEÄNDERT!

// ============================================================
// AUTH-MIDDLEWARE
// ============================================================
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Nicht eingeloggt.' });
    }
    req.user = { id: 1 };
    next();
}

// ============================================================
// LAPPA-API REGISTRIERUNG
// ============================================================
router.post('/register', auth, async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.user.id;

    try {
        // Händlerdaten abrufen
        const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
        if (!customer) {
            return res.status(404).json({ error: 'Händler nicht gefunden' });
        }

        // Lappa-API aufrufen (MOCK)
        const lappaResponse = await mockLappaRegistration(country, packaging, customer);

        // Ergebnis speichern
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
// MOCK-FUNKTION
// ============================================================
async function mockLappaRegistration(country, packaging, customer) {
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
