const express = require('express');
const router = express.Router();
const db = require('../db');

// ============================================================
// AUTH-MIDDLEWARE
// ============================================================
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Nicht eingeloggt.' });
    }
    // ⚠️ NUR ZUM TESTEN! Später durch echte JWT-Validierung ersetzen
    // Für den Moment: Wir nehmen die ID 1 (Admin/Test-User)
    req.user = { id: 1 };
    next();
}

// ============================================================
// LAPPA-API REGISTRIERUNG
// ============================================================
router.post('/register', auth, async (req, res) => {
    const { country, packaging, existing_number } = req.body;
    const customer_id = req.user.id;

    // ⭐ DEBUG: In den Logs prüfen
    console.log('🔍 Lappa-Registrierung für Land:', country);
    console.log('🔍 Customer ID:', customer_id);
    console.log('🔍 Packaging:', packaging);

    try {
        // 1. Händlerdaten abrufen
        const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
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
            packaging_count: packaging.length,
            customer: customer.company_name
        };

        console.log('🔍 Lappa-Antwort:', lappaResponse);

        // 3. Ergebnis in der Datenbank speichern
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
        console.error('❌ Lappa API Fehler:', error);
        // ⭐ GENAUE FEHLERMELDUNG ANZEIGEN
        res.status(500).json({ error: 'Fehler bei der Lappa-Registrierung: ' + error.message });
    }
});

module.exports = router;
