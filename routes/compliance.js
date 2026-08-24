const express = require('express');

const db = require('../db');

const {
  normalizeCountry,
  isEUCountry,
  calculateCompliance
} = require('../compliance-engine');

const {
  requireAuth
} = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/compliance/check
//
// Beispiel:
//
// /api/compliance/check?destination=FR
//
// Das Herkunftsland wird NICHT vom Frontend übergeben,
// sondern aus dem eingeloggten Händler geladen.
// ============================================================

router.get('/check', requireAuth, (req, res) => {
  try {
    const destination =
      normalizeCountry(req.query.destination);

    if (!destination) {
      return res.status(400).json({
        error: 'Zielland fehlt.'
      });
    }

    // --------------------------------------------------------
    // Händler aus DB laden
    // --------------------------------------------------------

    const customer = db.prepare(`
      SELECT
        id,
        company_name,
        origin_country,
        is_eu,
        plan
      FROM customers
      WHERE id = ?
    `).get(req.customer.sub);

    if (!customer) {
      return res.status(404).json({
        error: 'Händler nicht gefunden.'
      });
    }

    // --------------------------------------------------------
    // Zielland laden
    // --------------------------------------------------------

    const country = db.prepare(`
      SELECT
        code,
        name,
        register_body,
        representative_required,
        notary_required,
        notary_cost,
        registration_url,
        eco_fee,
        requirements_json,
        labeling_json,
        steps_json,
        flag
      FROM countries
      WHERE code = ?
    `).get(destination);

    if (!country) {
      return res.status(404).json({
        error:
          `Zielland ${destination} wird von Pack2EU noch nicht unterstützt.`
      });
    }

    // --------------------------------------------------------
    // Compliance berechnen
    // --------------------------------------------------------

    const compliance = calculateCompliance({
      originCountry:
        customer.origin_country,

      destinationCountry:
        destination,

      country
    });

    // --------------------------------------------------------
    // Zusätzliche Länderinformationen
    // --------------------------------------------------------

    let requirements = [];
    let labeling = [];
    let steps = [];

    try {
      requirements =
        JSON.parse(
          country.requirements_json || '[]'
        );
    } catch (_) {
      requirements = [];
    }

    try {
      labeling =
        JSON.parse(
          country.labeling_json || '[]'
        );
    } catch (_) {
      labeling = [];
    }

    try {
      steps =
        JSON.parse(
          country.steps_json || '[]'
        );
    } catch (_) {
      steps = [];
    }

    // --------------------------------------------------------
    // Antwort
    // --------------------------------------------------------

    res.json({
      ok: true,

      customer: {
        company_name:
          customer.company_name,

        origin_country:
          normalizeCountry(
            customer.origin_country
          ),

        origin_is_eu:
          isEUCountry(
            customer.origin_country
          ),

        plan:
          customer.plan
      },

      country: {
        code:
          country.code,

        name:
          country.name,

        flag:
          country.flag,

        register_body:
          country.register_body,

        registration_url:
          country.registration_url,

        eco_fee:
          country.eco_fee,

        requirements,

        labeling,

        steps,

        representative_required:
          Number(
            country.representative_required
          ) === 1,

        notary_required:
          Number(
            country.notary_required
          ) === 1,

        notary_cost:
          country.notary_cost || ''
      },

      compliance
    });

  } catch (error) {
    console.error(
      '❌ Compliance Check Fehler:',
      error
    );

    res.status(500).json({
      error:
        'Fehler bei der Compliance-Prüfung.'
    });
  }
});


// ============================================================
// GET /api/compliance/summary
//
// Liefert eine kompakte Übersicht für das Dashboard.
//
// Beispiel:
//
// /api/compliance/summary?destination=FR
// ============================================================

router.get(
  '/summary',
  requireAuth,
  (req, res) => {
    try {
      const destination =
        normalizeCountry(
          req.query.destination
        );

      if (!destination) {
        return res.status(400).json({
          error: 'Zielland fehlt.'
        });
      }

      const customer =
        db.prepare(`
          SELECT
            origin_country,
            plan
          FROM customers
          WHERE id = ?
        `).get(req.customer.sub);

      if (!customer) {
        return res.status(404).json({
          error:
            'Händler nicht gefunden.'
        });
      }

      const country =
        db.prepare(`
          SELECT
            code,
            name,
            representative_required,
            notary_required
          FROM countries
          WHERE code = ?
        `).get(destination);

      if (!country) {
        return res.status(404).json({
          error:
            'Zielland nicht gefunden.'
        });
      }

      const compliance =
        calculateCompliance({
          originCountry:
            customer.origin_country,

          destinationCountry:
            destination,

          country
        });

      res.json({
        ok: true,

        origin_country:
          normalizeCountry(
            customer.origin_country
          ),

        destination_country:
          destination,

        plan:
          customer.plan,

        ...compliance
      });

    } catch (error) {
      console.error(
        '❌ Compliance Summary Fehler:',
        error
      );

      res.status(500).json({
        error:
          'Fehler beim Erstellen der Compliance-Zusammenfassung.'
      });
    }
  }
);


module.exports = router;
