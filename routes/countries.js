const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Dieser Endpoint war zuvor komplett ohne Login abrufbar und hat für
// ALLE Länder registration_url + representative_provider_name/url
// öffentlich ausgeliefert - also genau die von uns recherchierten
// Bevollmächtigten-Kontakte, die ein zentrales USP sind. Ab hier: Login
// erforderlich, und die Kontakt-/Register-Felder werden weiter unten
// zusätzlich auf tatsächlich aktivierte Länder eingeschränkt.
router.use(requireAuth);

// ⭐ ALLE LÄNDER MIT ALLEN DETAILS
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        code,
        name,
        register_body,
        labeling_reqs,
        requirements_json,
        labeling_json,
        eco_fee,
        steps_json,
        representative_required,
        notary_required,
        notary_cost,
        registration_url,
        representative_provider_name,
        representative_provider_url,
        representative_data_status,
        data_status,
        registration_generally_required,
        reporting_frequency,
        eco_fee_rates_json,
        flag
      FROM countries
      ORDER BY name
    `).all();

    const activatedCodes = new Set(
      db.prepare(`
        SELECT country_code
        FROM activations
        WHERE customer_id = ?
      `).all(req.auth.userId).map(a => a.country_code)
    );

    const countries = rows.map((r) => {
      const isActivated = activatedCodes.has(r.code);
      return {
        code: r.code,
        name: r.name,
        register_body: r.register_body,
        labeling_reqs: JSON.parse(r.labeling_reqs || '[]'),
        requirements: JSON.parse(r.requirements_json || '[]'),
        labeling: JSON.parse(r.labeling_json || '[]'),
        eco_fee: r.eco_fee || '',
        steps: JSON.parse(r.steps_json || '[]'),
        representative_required: r.representative_required === 1,
        notary_required: r.notary_required === 1,
        notary_cost: r.notary_cost || '',
        // Kontakt-/Registrierungslink: nur für bereits aktivierte Länder -
        // siehe Kommentar oben.
        registration_url: isActivated ? (r.registration_url || '') : '',
        representative_provider_name: isActivated ? (r.representative_provider_name || '') : '',
        representative_provider_url: isActivated ? (r.representative_provider_url || '') : '',
        representative_data_status: r.representative_data_status || 'needs_verification',
        data_status: r.data_status || 'needs_verification',
        registration_generally_required: Number(r.registration_generally_required) !== 0,
        reporting_frequency: r.reporting_frequency || 'needs_verification',
        eco_fee_rates: r.eco_fee_rates_json ? JSON.parse(r.eco_fee_rates_json) : null,
        flag: r.flag || '🇪🇺'
      };
    });
    res.json(countries);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Länder:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Länder' });
  }
});

module.exports = router;
