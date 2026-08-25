const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);


// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function clean(value) {
  return String(value ?? '').trim();
}

function getRepresentative(body) {

  // Neues Format:
  //
  // representative: {
  //   name,
  //   company,
  //   email
  // }

  if (
    body?.representative &&
    typeof body.representative === 'object'
  ) {

    return {
      name: clean(body.representative.name),
      company: clean(body.representative.company),
      email: clean(body.representative.email)
    };

  }

  // Altes Format weiterhin unterstützen

  return {
    name: clean(body?.representative_name),
    company: clean(body?.representative_company),
    email: clean(body?.representative_email)
  };
}


function hasRepresentative(representative) {

  return Boolean(
    representative?.name &&
    representative?.email
  );

}


// ============================================================
// COMPLIANCE-ENTSCHEIDUNG
//
// Wichtig:
// Diese Funktion versucht die vorhandene Compliance-Engine
// zu verwenden.
//
// Falls die Engine nicht geladen werden kann, wird NICHT
// automatisch "active" gesetzt.
// ============================================================

function getComplianceDecision(countryCode) {

  try {

    const complianceEngine =
      require('../compliance-engine');

    const {
      normalizeCountry,
      calculateCompliance
    } = complianceEngine;

    if (
      typeof normalizeCountry !== 'function' ||
      typeof calculateCompliance !== 'function'
    ) {

      return {
        available: false,
        confidence: 'needs_review',
        registrationRequired: true,
        representativeRequired: false
      };

    }

    const customer =
      db.prepare(`
        SELECT
          origin_country,
          is_eu,
          plan
        FROM customers
        WHERE id = ?
      `).get(
        this.customerId
      );

    if (!customer) {

      return {
        available: false,
        confidence: 'needs_review',
        registrationRequired: true,
        representativeRequired: false
      };

    }

    const destination =
      normalizeCountry(countryCode);

    const country =
      db.prepare(`
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

      return {
        available: false,
        confidence: 'needs_review',
        registrationRequired: true,
        representativeRequired: false
      };

    }

    const decision =
      calculateCompliance({

        originCountry:
          customer.origin_country,

        destinationCountry:
          destination,

        country

      }) || {};

    return {
      available: true,
      ...decision
    };

  } catch (error) {

    console.error(
      '⚠️ Compliance-Engine konnte nicht geladen werden:',
      error
    );

    return {
      available: false,
      confidence: 'needs_review',
      registrationRequired: true,
      representativeRequired: false
    };

  }

}


// ============================================================
// COMPLIANCE-STATUS ERMITTELN
//
// Grün / active gibt es NUR wenn:
//
// 1. Länderregel verifiziert
// 2. Registrierung nicht erforderlich ODER EPR vorhanden
// 3. kein Bevollmächtigter erforderlich ODER vorhanden
//
// Eine EPR-Nummer alleine macht NICHT automatisch active.
// ============================================================

function calculateActivationStatus({
  existingNumber,
  representative,
  compliance
}) {

  const hasNumber =
    Boolean(existingNumber);

  const hasRep =
    hasRepresentative(representative);

  const confidence =
    compliance?.confidence || 'needs_review';

  const ruleVerified =
    confidence === 'primary_source_verified';

  const ruleNeedsReview =
    confidence === 'needs_national_rule' ||
    confidence === 'needs_review';

  const registrationRequired =
    Boolean(
      compliance?.registrationRequired
    );

  const representativeRequired =
    Boolean(
      compliance?.representativeRequired
    );

  const registrationComplete =
    !registrationRequired ||
    hasNumber;

  const representativeComplete =
    !representativeRequired ||
    hasRep;

  const fullyConfigured =
    ruleVerified &&
    registrationComplete &&
    representativeComplete;

  let status = 'pending';

  if (fullyConfigured) {

    status = 'active';

  }

  return {

    status,

    fullyConfigured,

    hasNumber,

    hasRepresentative: hasRep,

    registrationRequired,

    representativeRequired,

    registrationComplete,

    representativeComplete,

    ruleVerified,

    ruleNeedsReview,

    confidence

  };

}


// ============================================================
// ALLE AKTIVIERUNGEN DES HÄNDLERS
// ============================================================

router.get('/', (req, res) => {

  try {

    const rows =
      db.prepare(`
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

          a.compliance_status,
          a.registration_status,
          a.representative_status,

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

      `).all(
        req.customer.sub
      );


    const result =
      rows.map(row => {

        const representative = {

          name:
            row.representative_name || '',

          company:
            row.representative_company || '',

          email:
            row.representative_email || ''

        };


        const compliance =
          getComplianceDecision.call(
            {
              customerId:
                req.customer.sub
            },
            row.country_code
          );


        const calculated =
          calculateActivationStatus({

            existingNumber:
              row.existing_number,

            representative,

            compliance

          });


        return {

          ...row,

          mode:
            row.mode || 'grauzone',

          representative_name:
            representative.name,

          representative_company:
            representative.company,

          representative_email:
            representative.email,

          has_existing_number:
            calculated.hasNumber,

          has_representative:
            calculated.hasRepresentative,

          representative_complete:
            calculated.hasRepresentative,

          compliance_confidence:
            calculated.confidence,

          registration_required:
            calculated.registrationRequired,

          representative_required:
            calculated.representativeRequired,

          registration_complete:
            calculated.registrationComplete,

          representative_status_calculated:
            calculated.representativeComplete
              ? 'active'
              : calculated.representativeRequired
                ? 'required'
                : 'not_required',

          calculated_status:
            calculated.status,

          fully_configured:
            calculated.fullyConfigured,

          rule_verified:
            calculated.ruleVerified,

          rule_needs_review:
            calculated.ruleNeedsReview

        };

      });


    res.json(result);


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
      clean(req.params.countryCode)
        .toUpperCase();


    const existingNumber =
      clean(
        req.body?.existing_number
      );


    const representative =
      getRepresentative(req.body);


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
    // COMPLIANCE PRÜFEN
    // --------------------------------------------------------

    const compliance =
      getComplianceDecision.call(

        {
          customerId:
            req.customer.sub
        },

        countryCode

      );


    // --------------------------------------------------------
    // STATUS BERECHNEN
    // --------------------------------------------------------

    const calculated =
      calculateActivationStatus({

        existingNumber,

        representative,

        compliance

      });


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

          compliance_status,
          registration_status,
          representative_status,

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

          ?,
          ?,
          ?,

          ?

        )

      `).run(

        req.customer.sub,

        countryCode,

        calculated.status,

        existingNumber || null,

        representative.name || null,

        representative.company || null,
        representative.email || null,

        calculated.ruleVerified
          ? 'verified'
          : calculated.ruleNeedsReview
            ? 'needs_review'
            : 'pending',

        calculated.registrationRequired
          ? (
              calculated.hasNumber
                ? 'active'
                : 'required'
            )
          : 'not_required',

        calculated.representativeRequired
          ? (
              calculated.hasRepresentative
                ? 'active'
                : 'required'
            )
          : (
              calculated.hasRepresentative
                ? 'active'
                : 'not_required'
            ),

        'grauzone'

      );


    // --------------------------------------------------------
    // AKTIVIERUNG NEU LADEN
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

    console.log(
      '📊 Aktivierungsstatus:',
      calculated
    );


    // --------------------------------------------------------
    // ANTWORT
    // --------------------------------------------------------

    res.status(201).json({

      ok: true,

      message:
        calculated.status === 'active'

          ? `${country.name} wurde vollständig aktiviert.`

          : `${country.name} wurde hinzugefügt. Noch nicht alle Anforderungen sind erfüllt.`,

      activation: {

        ...activation,

        calculated_status:
          calculated.status,

        fully_configured:
          calculated.fullyConfigured,

        compliance_confidence:
          calculated.confidence,

        registration_required:
          calculated.registrationRequired,

        representative_required:
          calculated.representativeRequired,

        registration_complete:
          calculated.registrationComplete,

        representative_complete:
          calculated.representativeComplete,

        rule_verified:
          calculated.ruleVerified,

        rule_needs_review:
          calculated.ruleNeedsReview

      }

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
// ============================================================

router.put('/:countryCode', (req, res) => {

  try {

    const countryCode =
      clean(req.params.countryCode)
        .toUpperCase();


    const existingNumber =
      clean(
        req.body?.existing_number
      );


    const representative =
      getRepresentative(req.body);


    const existing =
      db.prepare(`

        SELECT

          id

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


    // --------------------------------------------------------
    // COMPLIANCE ERNEUT BERECHNEN
    // --------------------------------------------------------

    const compliance =
      getComplianceDecision.call(

        {
          customerId:
            req.customer.sub
        },

        countryCode

      );


    const calculated =
      calculateActivationStatus({

        existingNumber,

        representative,

        compliance

      });


    // --------------------------------------------------------
    // AKTUALISIEREN
    // --------------------------------------------------------

    db.prepare(`

      UPDATE activations

      SET

        existing_number = ?,

        representative_name = ?,
        representative_company = ?,
        representative_email = ?,

        status = ?,

        compliance_status = ?,
        registration_status = ?,
        representative_status = ?

      WHERE customer_id = ?

        AND country_code = ?

    `).run(

      existingNumber || null,

      representative.name || null,

      representative.company || null,

      representative.email || null,

      calculated.status,

      calculated.ruleVerified
        ? 'verified'
        : calculated.ruleNeedsReview
          ? 'needs_review'
          : 'pending',

      calculated.registrationRequired
        ? (
            calculated.hasNumber
              ? 'active'
              : 'required'
          )
        : 'not_required',

      calculated.representativeRequired
        ? (
            calculated.hasRepresentative
              ? 'active'
              : 'required'
          )
        : (
            calculated.hasRepresentative
              ? 'active'
              : 'not_required'
          ),

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

      `).get(
        existing.id
      );


    res.json({

      ok: true,

      activation: {

        ...activation,

        calculated_status:
          calculated.status,

        fully_configured:
          calculated.fullyConfigured,

        compliance_confidence:
          calculated.confidence,

        registration_required:
          calculated.registrationRequired,

        representative_required:
          calculated.representativeRequired,

        registration_complete:
          calculated.registrationComplete,

        representative_complete:
          calculated.representativeComplete,

        rule_verified:
          calculated.ruleVerified,

        rule_needs_review:
          calculated.ruleNeedsReview

      }

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
      clean(req.params.countryCode)
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
      clean(req.params.countryCode)
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


    const compliance =
      getComplianceDecision.call(

        {
          customerId:
            req.customer.sub
        },

        countryCode

      );


    const calculated =
      calculateActivationStatus({

        existingNumber:
          activation.existing_number,

        representative: {

          name:
            activation.representative_name,

          company:
            activation.representative_company,

          email:
            activation.representative_email

        },

        compliance

      });


    res.json({

      ok: true,

      countryCode,

      mode:
        activation.mode ||
        'grauzone',

      status:
        calculated.status,

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
        activation.provider_status,

      compliance_confidence:
        calculated.confidence,

      registration_required:
        calculated.registrationRequired,

      representative_required:
        calculated.representativeRequired,

      registration_complete:
        calculated.registrationComplete,

      representative_complete:
        calculated.representativeComplete,

      fully_configured:
        calculated.fullyConfigured,

      rule_verified:
        calculated.ruleVerified,

      rule_needs_review:
        calculated.ruleNeedsReview

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
