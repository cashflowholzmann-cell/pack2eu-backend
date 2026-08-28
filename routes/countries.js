const express = require('express');
const { db } = require('../db');

const router = express.Router();

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
        flag
      FROM countries
      ORDER BY name
    `).all();

    const countries = rows.map((r) => ({
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
      registration_url: r.registration_url || '',
      representative_provider_name: r.representative_provider_name || '',
      representative_provider_url: r.representative_provider_url || '',
      representative_data_status: r.representative_data_status || 'needs_verification',
      data_status: r.data_status || 'needs_verification',
      flag: r.flag || '🇪🇺'
    }));
    res.json(countries);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Länder:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Länder' });
  }
});

module.exports = router;
