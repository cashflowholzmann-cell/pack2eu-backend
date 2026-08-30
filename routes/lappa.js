const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireActiveSubscription);


// ============================================================
// LAPPA REGISTRIERUNG
//
// WICHTIG:
// Diese Route erstellt KEINE Aktivierung.
//
// Das Land muss vorher über
// POST /api/activations/:countryCode
// angelegt worden sein.
// ============================================================

router.post('/register', async (req, res) => {

  const {
    country,
    packaging,
    existing_number
  } = req.body;

  const customerId =
    req.customer.sub;

  const countryCode =
    String(country || '')
      .trim()
      .toUpperCase();

  try {

    const customer = db.prepare(`
      SELECT
        id,
        company_name
      FROM customers
      WHERE id = ?
    `).get(customerId);

    if (!customer) {

      return res.status(404).json({
        error: 'Händler nicht gefunden.'
      });

    }


    // --------------------------------------------------------
    // AKTIVIERUNG MUSS BEREITS EXISTIEREN
    // --------------------------------------------------------

    const activation = db.prepare(`
      SELECT *
      FROM activations
      WHERE customer_id = ?
        AND country_code = ?
    `).get(
      customerId,
      countryCode
    );

    if (!activation) {

      return res.status(409).json({
        error:
          'Für dieses Land existiert noch keine Aktivierung. ' +
          'Bitte zuerst das Land aktivieren.'
      });

    }


    // --------------------------------------------------------
    // MOCK PROVIDER RESPONSE
    //
    // Später wird hier die echte Lappa-API angeschlossen.
    // --------------------------------------------------------

    const lappaResponse = {

      status: 'success',

      epr_number:
        existing_number ||
        `EPR-${countryCode}-${Date.now()
          .toString()
          .slice(-6)}`,

      message:
        'Registrierung erfolgreich (MOCK)',

      country:
        countryCode,

      packaging_count:
        Array.isArray(packaging)
          ? packaging.length
          : 0,

      customer:
        customer.company_name
    };


    // --------------------------------------------------------
    // BESTEHENDE AKTIVIERUNG AKTUALISIEREN
    // --------------------------------------------------------

    db.prepare(`
      UPDATE activations

      SET
        provider_id = ?,
        provider_epr_number = ?,
        provider_status = ?,
        provider_data = ?,
        status = 'active'

      WHERE customer_id = ?
        AND country_code = ?
    `).run(

      'lappa',

      lappaResponse.epr_number,

      lappaResponse.status,

      JSON.stringify(lappaResponse),

      customerId,

      countryCode
    );


    console.log(
      '✅ Lappa Registrierung verarbeitet:',
      countryCode
    );


    res.json({

      ok: true,

      status:
        lappaResponse.status,

      epr_number:
        lappaResponse.epr_number,

      message:
        lappaResponse.message

    });

  } catch (error) {

    console.error(
      '❌ Lappa API Fehler:',
      error
    );

    res.status(500).json({
      error:
        'Fehler bei der Lappa-Registrierung: ' +
        error.message
    });
  }
});


// ============================================================
// BEVOLLMÄCHTIGTEN BUCHEN
// ============================================================

router.post('/book-representative', async (req, res) => {

  const { country } = req.body;

  const customerId =
    req.customer.sub;

  const countryCode =
    String(country || '')
      .trim()
      .toUpperCase();

  try {

    const activation = db.prepare(`
      SELECT id
      FROM activations
      WHERE customer_id = ?
        AND country_code = ?
    `).get(
      customerId,
      countryCode
    );

    if (!activation) {

      return res.status(404).json({
        error:
          'Land ist noch nicht aktiviert.'
      });

    }


    const representativeResponse = {

      status: 'success',

      representative_id:
        `REP-${countryCode}-${Date.now()
          .toString()
          .slice(-6)}`,

      message:
        'Bevollmächtigter erfolgreich gebucht (MOCK)',

      country:
        countryCode,

      valid_until:
        '2027-12-31'
    };


    db.prepare(`
      UPDATE activations

      SET
        mode = 'premium',
        provider_id = 'lappa',
        provider_status = 'success',
        provider_data = ?,
        lappa_representative_id = ?,
        lappa_status = 'active',
        lappa_data = ?,
        status = 'active'

      WHERE customer_id = ?
        AND country_code = ?
    `).run(

      JSON.stringify(representativeResponse),

      representativeResponse.representative_id,

      JSON.stringify(representativeResponse),

      customerId,

      countryCode
    );


    res.json({

      ok: true,

      success: true,

      message:
        representativeResponse.message,

      representative_id:
        representativeResponse.representative_id,

      country:
        countryCode,

      valid_until:
        representativeResponse.valid_until
    });

  } catch (error) {

    console.error(
      '❌ Fehler beim Buchen des Bevollmächtigten:',
      error
    );

    res.status(500).json({
      error:
        'Fehler beim Buchen des Bevollmächtigten: ' +
        error.message
    });
  }
});


module.exports = router;
