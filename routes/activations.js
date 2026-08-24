const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);


// ============================================================
// ALLE AKTIVIERUNGEN DES HÄNDLERS
// ============================================================

router.get('/', (req, res) => {

  try {

    const rows = db.prepare(`
      SELECT

        a.id,
        a.country_code,
        a.status,

        a.signed_at,

        a.existing_number,

        a.representative_name,
        a.representative_company,
        a.representative_email,

        a.provider_id,
        a.provider_epr_number,
        a.provider_status,

        a.lappa_representative_id,
        a.lappa_status,

        a.mode,
        a.mode_updated_at,

        a.created_at,

        c.name,
        c.register_body,
        c.flag,

        c.representative_required,
        c.notary_required,
        c.notary_cost,

        c.registration_url

      FROM activations a

      JOIN countries c
        ON c.code = a.country_code

      WHERE a.customer_id = ?

      ORDER BY c.name ASC

    `).all(req.customer.sub);


    res.json(

      rows.map(row => ({

        ...row,

        mode:
          row.mode || 'grauzone',

        has_existing_number:
          !!row.existing_number,

        has_representative:
          !!row.representative_name,

        representative_complete:
          !!(
            row.representative_name &&
            row.representative_email
          )

      }))

    );


  } catch (error) {

    console.error(
      '❌ Fehler beim Laden der Aktivierungen:',
      error
    );

    res.status(500).json({
      error:
        'Fehler beim Laden der Aktivierungen.'
    });

  }

});


// ============================================================
// LAND AKTIVIEREN
// ============================================================

router.post('/:countryCode', (req, res) => {

  try {

    const countryCode =
      String(req.params.countryCode || '')
        .trim()
        .toUpperCase();


    // --------------------------------------------------------
    // EPR-NUMMER
    // --------------------------------------------------------

    const existingNumber =
      String(
        req.body?.existing_number || ''
      ).trim();


    // --------------------------------------------------------
    // BEVOLLMÄCHTIGTER
    // --------------------------------------------------------

    const representativeName =
      String(
        req.body?.representative_name || ''
      ).trim();


    const representativeCompany =
      String(
        req.body?.representative_company || ''
      ).trim();


    const representativeEmail =
      String(
        req.body?.representative_email || ''
      ).trim();


    // --------------------------------------------------------
    // LAND PRÜFEN
    // --------------------------------------------------------

    const country =
      db.prepare(`
        SELECT

          code,
          name,

          representative_required,
          notary_required,
          notary_cost,

          registration_url

        FROM countries

        WHERE code = ?

      `).get(countryCode);


    if (!country) {

      return res.status(404).json({

        error:
          `Land ${countryCode} wird von Pack2EU noch nicht unterstützt.`

      });

    }


    // --------------------------------------------------------
    // BEREITS AKTIVIERT?
    // --------------------------------------------------------

    const existing =
      db.prepare(`
        SELECT

          id,
          status,
          existing_number,

          representative_name,
          representative_company,
          representative_email,

          mode

        FROM activations

        WHERE customer_id = ?

          AND country_code = ?

      `).get(
        req.customer.sub,
        countryCode
      );


    if (existing) {

      return res.status(409).json({

        error:
          'Dieses Land ist bereits aktiviert.',

        activation:
          existing

      });

    }


    // --------------------------------------------------------
    // STATUS BESTIMMEN
    // --------------------------------------------------------

    const hasNumber =
      Boolean(existingNumber);


    const hasRepresentative =
      Boolean(
        representativeName &&
        representativeEmail
      );


    let status = 'pending';


    /*
      Wenn eine bestehende EPR-Nummer vorhanden ist,
      kann das Land direkt als aktiv gelten.

      Wenn ein Bevollmächtigter ebenfalls vorhanden ist,
      sind beide vorhandenen Daten gespeichert.
    */

    if (hasNumber) {

      status = 'active';

    }


    // --------------------------------------------------------
    // AKTIVIERUNG ERSTELLEN
    // --------------------------------------------------------

    const result =
      db.prepare(`

        INSERT INTO activations (

          customer_id,
          country_code,

          status,

          existing_number,

          representative_name,
          representative_company,
          representative_email,

          mode

        )

        VALUES (

          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?

        )

      `).run(

        req.customer.sub,

        countryCode,

        status,

        existingNumber || null,

        representativeName || null,

        representativeCompany || null,

        representativeEmail || null,

        'grauzone'

      );


    // --------------------------------------------------------
    // NEUE AKTIVIERUNG LADEN
    // --------------------------------------------------------

    const activation =
      db.prepare(`

        SELECT

          a.*,

          c.name,
          c.flag,
          c.register_body,

          c.representative_required,
          c.notary_required,
          c.notary_cost,

          c.registration_url

        FROM activations a

        JOIN countries c
          ON c.code = a.country_code

        WHERE a.id = ?

      `).get(
        result.lastInsertRowid
      );


    console.log(
      `✅ Land aktiviert: ${countryCode} / Kunde ${req.customer.sub}`
    );


    // --------------------------------------------------------
    // ANTWORT
    // --------------------------------------------------------

    res.status(201).json({

      ok: true,

      message:

        existingNumber

          ? `${country.name} wurde mit bestehender EPR-Nummer aktiviert.`

          : `${country.name} wurde zur Registrierung vorgemerkt.`,

      activation

    });


  } catch (error) {

    console.error(
      '❌ Fehler bei der Länderaktivierung:',
      error
    );


    res.status(500).json({

      error:
        'Fehler bei der Länderaktivierung: ' +
        error.message

    });

  }

});


// ============================================================
// AKTIVIERUNG AKTUALISIEREN
//
// Damit kann das Dashboard später auch eine bereits
// bestehende Aktivierung bearbeiten.
// ============================================================

router.put('/:countryCode', (req, res) => {

  try {

    const countryCode =
      String(req.params.countryCode || '')
        .trim()
        .toUpperCase();


    const existingNumber =
      String(
        req.body?.existing_number || ''
      ).trim();


    const representativeName =
      String(
        req.body?.representative_name || ''
      ).trim();


    const representativeCompany =
      String(
        req.body?.representative_company || ''
      ).trim();


    const representativeEmail =
      String(
        req.body?.representative_email || ''
      ).trim();


    const existing =
      db.prepare(`

        SELECT id

        FROM activations

        WHERE customer_id = ?

          AND country_code = ?

      `).get(
        req.customer.sub,
        countryCode
      );


    if (!existing) {

      return res.status(404).json({

        error:
          'Land nicht aktiviert.'

      });

    }


    const status =
      existingNumber
        ? 'active'
        : 'pending';


    db.prepare(`

      UPDATE activations

      SET

        existing_number = ?,

        representative_name = ?,
        representative_company = ?,
        representative_email = ?,

        status = ?

      WHERE customer_id = ?

        AND country_code = ?

    `).run(

      existingNumber || null,

      representativeName || null,

      representativeCompany || null,

      representativeEmail || null,

      status,

      req.customer.sub,

      countryCode

    );


    const activation =
      db.prepare(`

        SELECT

          a.*,

          c.name,
          c.flag,
          c.register_body,

          c.representative_required,
          c.notary_required,
          c.notary_cost,

          c.registration_url

        FROM activations a

        JOIN countries c
          ON c.code = a.country_code

        WHERE a.id = ?

      `).get(existing.id);


    res.json({

      ok: true,

      activation

    });


  } catch (error) {

    console.error(
      '❌ Fehler beim Aktualisieren:',
      error
    );


    res.status(500).json({

      error:
        'Fehler beim Aktualisieren der Aktivierung.'

    });

  }

});


// ============================================================
// VOLLMACHT SIGNIEREN
// ============================================================

router.post('/:countryCode/sign', (req, res) => {

  try {

    const countryCode =
      String(req.params.countryCode || '')
        .trim()
        .toUpperCase();


    const result =
      db.prepare(`

        UPDATE activations

        SET

          status = 'signed',

          signed_at = datetime('now')

        WHERE customer_id = ?

          AND country_code = ?

      `).run(

        req.customer.sub,

        countryCode

      );


    if (result.changes === 0) {

      return res.status(404).json({

        error:
          'Keine Aktivierung für dieses Land gefunden.'

      });

    }


    res.json({

      ok: true,

      countryCode,

      status: 'signed'

    });


  } catch (error) {

    console.error(
      '❌ Fehler beim Signieren:',
      error
    );


    res.status(500).json({

      error:
        'Fehler beim Signieren: ' +
        error.message

    });

  }

});


// ============================================================
// STATUS
// ============================================================

router.get('/:countryCode/status', (req, res) => {

  try {

    const countryCode =
      String(req.params.countryCode || '')
        .trim()
        .toUpperCase();


    const activation =
      db.prepare(`

        SELECT

          mode,
          status,

          existing_number,

          representative_name,
          representative_company,
          representative_email,

          provider_id,
          provider_epr_number,
          provider_status

        FROM activations

        WHERE customer_id = ?

          AND country_code = ?

      `).get(

        req.customer.sub,

        countryCode

      );


    if (!activation) {

      return res.status(404).json({

        error:
          'Land nicht aktiviert.'

      });

    }


    res.json({

      ok: true,

      countryCode,

      mode:
        activation.mode ||
        'grauzone',

      status:
        activation.status,

      existing_number:
        activation.existing_number,

      representative_name:
        activation.representative_name,

      representative_company:
        activation.representative_company,

      representative_email:
        activation.representative_email,

      provider_id:
        activation.provider_id,

      epr_number:
        activation.provider_epr_number,

      provider_status:
        activation.provider_status

    });


  } catch (error) {

    console.error(
      '❌ Fehler beim Status:',
      error
    );


    res.status(500).json({

      error:
        'Fehler beim Abrufen des Status.'

    });

  }

});


module.exports = router;
