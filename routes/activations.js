const express = require('express');
const db = require('../db');

const {
  requireAuth,
  requireCustomer
} = require('../middleware/auth');

const {
  decide,
  normalizeCode,
  isVerifiedDecision
} = require('../compliance-engine');

const router = express.Router();


// ============================================================
// AUTH
// ============================================================

router.use(
  requireAuth,
  requireCustomer
);


// ============================================================
// HILFSFUNKTIONEN
// ============================================================

function clean(value) {
  return String(value ?? '').trim();
}


// ============================================================
// HÄNDLER LADEN
// ============================================================

function getCustomer(customerId) {

  return db.prepare(`
    SELECT
      id,
      company_name,
      origin_country,
      is_eu,
      plan
    FROM customers
    WHERE id = ?
  `).get(customerId);

}


// ============================================================
// LAND LADEN
// ============================================================

function getCountry(countryCode) {

  return db.prepare(`
    SELECT *
    FROM countries
    WHERE code = ?
  `).get(
    normalizeCode(countryCode)
  );

}


// ============================================================
// COMPLIANCE-REGEL LADEN
//
// WICHTIG:
// Es wird ausschließlich eine aktive Regel verwendet.
// Keine Regel = keine Rechtssicherheit = niemals grün.
// ============================================================

function getRule(originCountry, destinationCountry) {

  return db.prepare(`
    SELECT *
    FROM compliance_rules
    WHERE origin_code = ?
      AND destination_code = ?
      AND active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get(
    normalizeCode(originCountry),
    normalizeCode(destinationCountry)
  );

}


// ============================================================
// COMPLIANCE ENTSCHEIDUNG
// ============================================================

function getDecision(customerId, countryCode) {

  const customer =
    getCustomer(customerId);

  const country =
    getCountry(countryCode);

  if (!customer || !country) {
    return null;
  }

  const rule =
    getRule(
      customer.origin_country,
      country.code
    );

  const decision =
    decide({
      originCountry:
        customer.origin_country,

      destinationCountry:
        country.code,

      rule,

      destinationMeta:
        country
    });

  return {
    customer,
    country,
    rule,
    decision
  };

}


// ============================================================
// BEVOLLMÄCHTIGTEN AUS REQUEST LESEN
//
// Wir akzeptieren beide Formate:
//
// 1.
// representative: {
//   name,
//   company,
//   email
// }
//
// 2.
// representative_name
// representative_company
// representative_email
// ============================================================

function readRepresentative(body = {}) {

  const nested =
    body.representative &&
    typeof body.representative === 'object'
      ? body.representative
      : {};

  return {

    name:
      clean(
        nested.name ??
        body.representative_name ??
        ''
      ),

    company:
      clean(
        nested.company ??
        body.representative_company ??
        ''
      ),

    email:
      clean(
        nested.email ??
        body.representative_email ??
        ''
      )

  };

}


// ============================================================
// BEVOLLMÄCHTIGTER VOLLSTÄNDIG?
//
// Für Pack2EU gilt:
// Name + E-Mail = vorhandener Bevollmächtigter.
// Firma ist optional.
// ============================================================

function hasRepresentative(representative) {

  return Boolean(
    representative &&
    representative.name &&
    representative.email
  );

}


// ============================================================
// AKTIVIERUNGSSTATUS BERECHNEN
//
// GRÜN / ACTIVE gibt es NUR wenn:
//
// 1. Regel ist primärquelle-verifiziert
// 2. Registrierung ist erledigt
// 3. erforderlicher Bevollmächtigter ist vorhanden
//
// Eine EPR-Nummer alleine reicht NICHT.
// Ein Bevollmächtigter alleine reicht NICHT.
// Eine unbekannte / unsichere Regel reicht NICHT.
// ============================================================

function deriveState({
  decision,
  existingNumber,
  representative
}) {

  const hasEpr =
    Boolean(
      clean(existingNumber)
    );

  const hasRep =
    hasRepresentative(
      representative
    );

  const verified =
    isVerifiedDecision(
      decision
    );

  const registrationRequired =
    Boolean(
      decision?.registrationRequired
    );

  const representativeRequired =
    Boolean(
      decision?.representativeRequired
    );


  // ----------------------------------------------------------
  // REGISTRIERUNG
  // ----------------------------------------------------------

  let registrationStatus;

  if (!registrationRequired) {

    registrationStatus =
      'not_required';

  } else if (hasEpr) {

    registrationStatus =
      'active';

  } else {

    registrationStatus =
      'required';

  }


  // ----------------------------------------------------------
  // BEVOLLMÄCHTIGTER
  // ----------------------------------------------------------

  let representativeStatus;

  if (!representativeRequired) {

    representativeStatus =
      hasRep
        ? 'active'
        : 'not_required';

  } else if (hasRep) {

    representativeStatus =
      'active';

  } else {

    representativeStatus =
      'required';

  }


  // ----------------------------------------------------------
  // VOLLSTÄNDIG
  // ----------------------------------------------------------

  const registrationComplete =
    !registrationRequired ||
    hasEpr;


  const representativeComplete =
    !representativeRequired ||
    hasRep;


  // ----------------------------------------------------------
  // ENTSCHEIDEND:
  // Ohne verifizierte Rechtsgrundlage NIEMALS GRÜN
  // ----------------------------------------------------------

  const fullyConfigured =
    verified &&
    registrationComplete &&
    representativeComplete;


  const status =
    fullyConfigured
      ? 'active'
      : 'pending';


  // ----------------------------------------------------------
  // MODUS
  // ----------------------------------------------------------

  const mode =
    verified
      ? 'verified'
      : 'grauzone';


  // ----------------------------------------------------------
  // PROVIDER STATUS
  // ----------------------------------------------------------

  let providerStatus =
    'not_required';


  if (
    representativeRequired &&
    !hasRep
  ) {

    providerStatus =
      decision?.providerAvailable
        ? 'required'
        : 'required_manual_check';

  } else if (
    representativeRequired &&
    hasRep
  ) {

    providerStatus =
      'active';

  }


  return {

    status,

    mode,

    fullyConfigured,

    hasEpr,

    hasRepresentative: hasRep,

    registrationRequired,

    representativeRequired,

    registrationComplete,

    representativeComplete,

    registrationStatus,

    representativeStatus,

    providerStatus,

    verified,

    confidence:
      decision?.confidence ||
      'needs_review'

  };

}


// ============================================================
// SNAPSHOT
// ============================================================

function buildSnapshot(
  decision,
  state,
  representative,
  existingNumber
) {

  return JSON.stringify({

    decision,

    existingNumber:
      Boolean(
        clean(existingNumber)
      ),

    existingRepresentative:
      state.hasRepresentative,

    representativeRequired:
      state.representativeRequired,

    registrationRequired:
      state.registrationRequired,

    registrationComplete:
      state.registrationComplete,

    representativeComplete:
      state.representativeComplete,

    fullyConfigured:
      state.fullyConfigured,

    verified:
      state.verified,

    representative: {

      name:
        representative.name || null,

      company:
        representative.company || null,

      email:
        representative.email || null

    },

    calculatedAt:
      new Date().toISOString()

  });

}


// ============================================================
// GET /api/activations
//
// ALLE AKTIVIERUNGEN DES HÄNDLERS
// ============================================================

router.get('/', (req, res) => {

  try {

    // WICHTIG:
    // NICHT req.customer.sub
    // sondern req.auth.userId

    const customerId =
      req.auth.userId;


    const rows =
      db.prepare(`
        SELECT
          a.*,

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
        customerId
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


        const result =
          getDecision(
            customerId,
            row.country_code
          );


        const decision =
          result?.decision || {

            status:
              'needs_review',

            registrationRequired:
              true,

            representativeRequired:
              false,

            confidence:
              'needs_review'

          };


        const state =
          deriveState({

            decision,

            existingNumber:
              row.existing_number,

            representative

          });


        return {

          ...row,


          // --------------------------------------------------
          // KOMPATIBILITÄT
          // --------------------------------------------------

          mode:
            state.mode,


          // --------------------------------------------------
          // EPR
          // --------------------------------------------------

          has_existing_number:
            state.hasEpr,

          existing_number:
            row.existing_number || null,


          // --------------------------------------------------
          // BEVOLLMÄCHTIGTER
          // --------------------------------------------------

          representative_name:
            representative.name,

          representative_company:
            representative.company,

          representative_email:
            representative.email,

          has_representative:
            state.hasRepresentative,

          representative_complete:
            state.representativeComplete,


          // --------------------------------------------------
          // COMPLIANCE
          // --------------------------------------------------

          compliance:
            decision,

          compliance_confidence:
            state.confidence,

          registration_required:
            state.registrationRequired,

          registration_complete:
            state.registrationComplete,

          representative_required:
            state.representativeRequired,

          representative_status_calculated:
            state.representativeStatus,


          // --------------------------------------------------
          // STATUS
          // --------------------------------------------------

          calculated_status:
            state.status,

          fully_configured:
            state.fullyConfigured,

          rule_verified:
            state.verified,

          rule_needs_review:
            !state.verified

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
        'Fehler beim Laden der Aktivierungen: ' +
        error.message

    });

  }

});


// ============================================================
// POST /api/activations/:countryCode
//
// LAND AKTIVIEREN
// ============================================================

router.post('/:countryCode', (req, res) => {

  try {

    const customerId =
      req.auth.userId;


    const countryCode =
      normalizeCode(
        req.params.countryCode
      );


    const existingNumber =
      clean(
        req.body?.existing_number
      );


    const representative =
      readRepresentative(
        req.body
      );


    // --------------------------------------------------------
    // LAND
    // --------------------------------------------------------

    const result =
      getDecision(
        customerId,
        countryCode
      );


    if (!result) {

      return res.status(404).json({

        error:
          `Land ${countryCode} wird von Pack2EU noch nicht unterstützt.`

      });

    }


    const {
      customer,
      country,
      decision
    } =
      result;


    // --------------------------------------------------------
    // BEREITS AKTIVIERT?
    // --------------------------------------------------------

    const existing =
      db.prepare(`
        SELECT
          id
        FROM activations
        WHERE customer_id = ?
          AND country_code = ?
      `).get(
        customerId,
        countryCode
      );


    if (existing) {

      return res.status(409).json({

        error:
          'Dieses Land ist bereits aktiviert.'

      });

    }


    // --------------------------------------------------------
    // PLAN-LIMIT
    // --------------------------------------------------------

    const maxCountries =
      customer.plan === 'S'
        ? 2
        : 27;


    const activeCount =
      db.prepare(`
        SELECT
          COUNT(*) AS n
        FROM activations
        WHERE customer_id = ?
      `).get(
        customerId
      ).n;


    if (
      activeCount >=
      maxCountries
    ) {

      return res.status(403).json({

        error:
          `Dein ${customer.plan} Plan erlaubt maximal ${maxCountries} Länder.`

      });

    }


    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    const state =
      deriveState({

        decision,

        existingNumber,

        representative

      });


    const snapshot =
      buildSnapshot(
        decision,
        state,
        representative,
        existingNumber
      );


    // --------------------------------------------------------
    // AKTIVIERUNG SPEICHERN
    // --------------------------------------------------------

    db.prepare(`
      INSERT INTO activations (

        customer_id,
        country_code,

        status,

        existing_number,

        representative_name,
        representative_company,
        representative_email,

        mode,

        compliance_status,
        registration_status,
        representative_status,

        compliance_snapshot,

        provider_status

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
        ?,

        ?,

        ?

      )
    `).run(

      customerId,
      countryCode,

      state.status,

      existingNumber || null,

      representative.name || null,
      representative.company || null,
      representative.email || null,

      state.mode,

      decision.status,

      state.registrationStatus,

      state.representativeStatus,

      snapshot,

      state.providerStatus

    );


    // --------------------------------------------------------
    // COMPLIANCE CASE
    //
    // Falls die Tabelle vorhanden ist.
    // --------------------------------------------------------

    try {

      db.prepare(`
        INSERT INTO compliance_cases (

          customer_id,
          country_code,

          compliance_status,
          registration_status,
          representative_status,

          provider_id,

          snapshot_json,

          external_number

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

        ON CONFLICT(
          customer_id,
          country_code
        )

        DO UPDATE SET

          compliance_status =
            excluded.compliance_status,

          registration_status =
            excluded.registration_status,

          representative_status =
            excluded.representative_status,

          provider_id =
            excluded.provider_id,

          snapshot_json =
            excluded.snapshot_json,

          external_number =
            excluded.external_number,

          updated_at =
            datetime('now')
      `).run(

        customerId,
        countryCode,

        decision.status,

        state.registrationStatus,

        state.representativeStatus,

        decision.providerId ||
          null,

        snapshot,

        existingNumber ||
          null

      );

    } catch (caseError) {

      console.warn(
        'ℹ️ Compliance Case konnte nicht gespeichert werden:',
        caseError.message
      );

    }


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

        WHERE a.customer_id = ?
          AND a.country_code = ?
      `).get(
        customerId,
        countryCode
      );


    console.log(
      `✅ Land gespeichert: ${countryCode} / Kunde ${customerId}`
    );


    console.log(
      '📊 Compliance:',
      decision
    );


    console.log(
      '📊 Aktivierungsstatus:',
      state
    );


    // --------------------------------------------------------
    // ANTWORT
    // --------------------------------------------------------

    res.status(201).json({

      ok: true,

      countryCode,

      status:
        state.status,

      mode:
        state.mode,

      message:
        state.fullyConfigured

          ? `${country.name} wurde vollständig eingerichtet.`

          : `${country.name} wurde gespeichert. Weitere Einrichtung oder Prüfung ist noch erforderlich.`,

      activation,

      compliance:
        decision,

      fullyConfigured:
        state.fullyConfigured,

      registrationStatus:
        state.registrationStatus,

      representativeStatus:
        state.representativeStatus,

      existing_number:
        existingNumber || null,

      representative:
        state.hasRepresentative

          ? {

              name:
                representative.name,

              company:
                representative.company,

              email:
                representative.email

            }

          : null

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
// PUT /api/activations/:countryCode
//
// AKTIVIERUNG AKTUALISIEREN
// ============================================================

router.put('/:countryCode', (req, res) => {

  try {

    const customerId =
      req.auth.userId;


    const countryCode =
      normalizeCode(
        req.params.countryCode
      );


    const existingNumber =
      clean(
        req.body?.existing_number
      );


    const representative =
      readRepresentative(
        req.body
      );


    // --------------------------------------------------------
    // AKTIVIERUNG
    // --------------------------------------------------------

    const existing =
      db.prepare(`
        SELECT
          id
        FROM activations
        WHERE customer_id = ?
          AND country_code = ?
      `).get(
        customerId,
        countryCode
      );


    if (!existing) {

      return res.status(404).json({

        error:
          'Land nicht aktiviert.'

      });

    }


    // --------------------------------------------------------
    // COMPLIANCE
    // --------------------------------------------------------

    const result =
      getDecision(
        customerId,
        countryCode
      );


    if (!result) {

      return res.status(404).json({

        error:
          'Land nicht gefunden.'

      });

    }


    const {
      decision
    } =
      result;


    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    const state =
      deriveState({

        decision,

        existingNumber,

        representative

      });


    const snapshot =
      buildSnapshot(
        decision,
        state,
        representative,
        existingNumber
      );


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

        mode = ?,

        compliance_status = ?,
        registration_status = ?,
        representative_status = ?,

        compliance_snapshot = ?,

        provider_status = ?

      WHERE customer_id = ?
        AND country_code = ?
    `).run(

      existingNumber || null,

      representative.name || null,
      representative.company || null,
      representative.email || null,

      state.status,

      state.mode,

      decision.status,

      state.registrationStatus,

      state.representativeStatus,

      snapshot,

      state.providerStatus,

      customerId,

      countryCode

    );


    // --------------------------------------------------------
    // COMPLIANCE CASE AKTUALISIEREN
    // --------------------------------------------------------

    try {

      db.prepare(`
        INSERT INTO compliance_cases (

          customer_id,
          country_code,

          compliance_status,
          registration_status,
          representative_status,

          provider_id,

          snapshot_json,

          external_number

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

        ON CONFLICT(
          customer_id,
          country_code
        )

        DO UPDATE SET

          compliance_status =
            excluded.compliance_status,

          registration_status =
            excluded.registration_status,

          representative_status =
            excluded.representative_status,

          provider_id =
            excluded.provider_id,

          snapshot_json =
            excluded.snapshot_json,

          external_number =
            excluded.external_number,

          updated_at =
            datetime('now')
      `).run(

        customerId,
        countryCode,

        decision.status,

        state.registrationStatus,

        state.representativeStatus,

        decision.providerId ||
          null,

        snapshot,

        existingNumber ||
          null

      );

    } catch (caseError) {

      console.warn(
        'ℹ️ Compliance Case konnte nicht aktualisiert werden:',
        caseError.message
      );

    }


    // --------------------------------------------------------
    // NEU LADEN
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
        existing.id
      );


    res.json({

      ok: true,

      activation,

      status:
        state.status,

      mode:
        state.mode,

      fullyConfigured:
        state.fullyConfigured,

      compliance:
        decision,

      registrationStatus:
        state.registrationStatus,

      representativeStatus:
        state.representativeStatus

    });


  } catch (error) {

    console.error(
      '❌ Fehler beim Aktualisieren:',
      error
    );


    res.status(500).json({

      error:
        'Fehler beim Aktualisieren der Aktivierung: ' +
        error.message

    });

  }

});


// ============================================================
// POST /api/activations/:countryCode/sign
//
// VOLLMACHT SIGNIEREN
// ============================================================

router.post('/:countryCode/sign', (req, res) => {

  try {

    const customerId =
      req.auth.userId;


    const countryCode =
      normalizeCode(
        req.params.countryCode
      );


    const activation =
      db.prepare(`
        SELECT
          id,
          status,
          representative_status,
          registration_status
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
          'Keine Aktivierung für dieses Land gefunden.'

      });

    }


    // Signieren bedeutet NICHT automatisch,
    // dass die Compliance vollständig ist.
    //
    // Deshalb:
    // - wenn noch Anforderungen offen sind => signed
    // - active bleibt active
    //
    const newStatus =
      activation.status === 'active'
        ? 'active'
        : 'signed';


    db.prepare(`
      UPDATE activations

      SET

        status = ?,

        signed_at =
          datetime('now')

      WHERE customer_id = ?
        AND country_code = ?
    `).run(

      newStatus,

      customerId,

      countryCode

    );


    res.json({

      ok: true,

      countryCode,

      status:
        newStatus

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
// GET /api/activations/:countryCode/status
// ============================================================

router.get('/:countryCode/status', (req, res) => {

  try {

    const customerId =
      req.auth.userId;


    const countryCode =
      normalizeCode(
        req.params.countryCode
      );


    const activation =
      db.prepare(`
        SELECT
          *
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
          'Land nicht aktiviert.'

      });

    }


    const result =
      getDecision(
        customerId,
        countryCode
      );


    const decision =
      result?.decision || {

        status:
          'needs_review',

        registrationRequired:
          true,

        representativeRequired:
          false,

        confidence:
          'needs_review'

      };


    const representative = {

      name:
        activation.representative_name || '',

      company:
        activation.representative_company || '',

      email:
        activation.representative_email || ''

    };


    const state =
      deriveState({

        decision,

        existingNumber:
          activation.existing_number,

        representative

      });


    res.json({

      ok: true,

      countryCode,

      status:
        state.status,

      mode:
        state.mode,

      existing_number:
        activation.existing_number,

      representative_name:
        activation.representative_name,

      representative_company:
        activation.representative_company,

      representative_email:
        activation.representative_email,

      provider_id:
        activation.provider_id || null,

      epr_number:
        activation.provider_epr_number || null,

      provider_status:
        activation.provider_status || null,

      compliance:
        decision,

      compliance_confidence:
        state.confidence,

      registration_required:
        state.registrationRequired,

      registration_complete:
        state.registrationComplete,

      representative_required:
        state.representativeRequired,

      representative_complete:
        state.representativeComplete,

      registration_status:
        state.registrationStatus,

      representative_status:
        state.representativeStatus,

      fully_configured:
        state.fullyConfigured,

      rule_verified:
        state.verified,

      rule_needs_review:
        !state.verified

    });


  } catch (error) {

    console.error(
      '❌ Fehler beim Status:',
      error
    );


    res.status(500).json({

      error:
        'Fehler beim Abrufen des Status: ' +
        error.message

    });

  }

});


// ============================================================
// EXPORT
// ============================================================

module.exports = router;
