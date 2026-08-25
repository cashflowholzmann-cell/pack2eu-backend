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


const router =
  express.Router();


router.use(
  requireAuth,
  requireCustomer
);


// ============================================================
// HILFSFUNKTION
// ============================================================

function clean(value) {

  return String(
    value ?? ''
  ).trim();
}


// ============================================================
// KUNDE
// ============================================================

function getCustomer(
  customerId
) {

  return db.prepare(`
    SELECT
      id,
      company_name,
      origin_country,
      is_eu,
      plan
    FROM customers
    WHERE id = ?
  `).get(
    customerId
  );
}


// ============================================================
// LAND
// ============================================================

function getCountry(
  countryCode
) {

  return db.prepare(`
    SELECT *
    FROM countries
    WHERE code = ?
  `).get(
    normalizeCode(
      countryCode
    )
  );
}


// ============================================================
// COMPLIANCE REGEL
// ============================================================

function getRule(
  originCountry,
  destinationCountry
) {

  return db.prepare(`
    SELECT *
    FROM compliance_rules
    WHERE origin_code = ?
      AND destination_code = ?
      AND active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get(

    normalizeCode(
      originCountry
    ),

    normalizeCode(
      destinationCountry
    )

  );
}


// ============================================================
// COMPLIANCE ENTSCHEIDUNG
// ============================================================

function getDecision(
  customerId,
  countryCode
) {

  const customer =
    getCustomer(
      customerId
    );


  const country =
    getCountry(
      countryCode
    );


  if (
    !customer ||
    !country
  ) {

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
// REPRESENTATIVE AUS REQUEST
// ============================================================

function readRepresentative(
  body = {}
) {

  const nested =
    body.representative &&
    typeof body.representative ===
      'object'
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
// STATUS
// ============================================================

function calculateState({

  decision,

  existingNumber,

  representative,

  providerStatus

}) {

  const hasNumber =
    Boolean(
      clean(
        existingNumber
      )
    );


  const hasRepresentative =
    Boolean(
      representative &&
      clean(
        representative.name
      ) &&
      clean(
        representative.email
      )
    );


  const verified =
    isVerifiedDecision(
      decision
    );


  const registrationRequired =
    Boolean(
      decision.registrationRequired
    );


  const representativeRequired =
    Boolean(
      decision.representativeRequired
    );


  const registrationComplete =
    !registrationRequired ||
    hasNumber;


  const representativeComplete =
    !representativeRequired ||
    hasRepresentative;


  const fullyConfigured =
    verified &&
    registrationComplete &&
    representativeComplete;


  const status =
    fullyConfigured
      ? 'active'
      : 'pending';


  const mode =
    verified
      ? 'verified'
      : 'grauzone';


  const registrationStatus =
    !registrationRequired
      ? 'not_required'
      : hasNumber
        ? 'active'
        : 'required';


  let representativeStatus;


  if (
    !representativeRequired
  ) {

    representativeStatus =
      'not_required';

  } else if (
    hasRepresentative
  ) {

    representativeStatus =
      'active';

  } else {

    representativeStatus =
      'required';
  }


  return {

    status,

    mode,

    fullyConfigured,

    hasNumber,

    hasRepresentative,

    registrationRequired,

    representativeRequired,

    registrationComplete,

    representativeComplete,

    registrationStatus,

    representativeStatus,

    providerStatus:
      providerStatus ||
      (
        representativeRequired
          ? 'required'
          : 'not_required'
      )

  };
}


// ============================================================
// SNAPSHOT
// ============================================================

function buildSnapshot({

  decision,

  state,

  existingNumber,

  representative

}) {

  return JSON.stringify({

    generatedAt:
      new Date().toISOString(),

    compliance:
      decision,

    state,

    existingNumber:
      existingNumber ||
      null,

    representative:
      representative ||
      null

  });
}


// ============================================================
// ALLE AKTIVIERUNGEN
// GET /api/activations
// ============================================================

router.get(
  '/',
  (req, res) => {

    try {

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
            c.registration_url,
            c.data_status
          FROM activations a
          JOIN countries c
            ON c.code = a.country_code
          WHERE a.customer_id = ?
          ORDER BY c.name ASC
        `).all(
          req.auth.userId
        );


      return res.json(
        rows.map(
          row => ({

            ...row,

            has_existing_number:
              Boolean(
                row.existing_number
              ),

            has_representative:
              Boolean(
                row.representative_name &&
                row.representative_email
              )

          })
        )
      );

    } catch (error) {

      console.error(
        '❌ Fehler beim Laden der Aktivierungen:',
        error
      );

      return res.status(500).json({
        error:
          'Fehler beim Laden der Aktivierungen: ' +
          error.message
      });
    }
  }
);


// ============================================================
// PREVIEW
// GET /api/activations/DE/preview
// ============================================================

router.get(
  '/:countryCode/preview',
  (req, res) => {

    try {

      const countryCode =
        normalizeCode(
          req.params.countryCode
        );


      const result =
        getDecision(
          req.auth.userId,
          countryCode
        );


      if (!result) {

        return res.status(404).json({
          error:
            `Land ${countryCode} wird nicht unterstützt.`
        });
      }


      return res.json({

        country_code:
          result.country.code,

        name:
          result.country.name,

        flag:
          result.country.flag,

        register_body:
          result.country.register_body,

        registration_url:
          result.country.registration_url ||
          '',

        compliance:
          result.decision

      });

    } catch (error) {

      console.error(
        '❌ Activation preview error:',
        error
      );

      return res.status(500).json({
        error:
          'Fehler bei der Länderprüfung: ' +
          error.message
      });
    }
  }
);


// ============================================================
// LAND AKTIVIEREN
//
// POST /api/activations/PL
// ============================================================

router.post(
  '/:countryCode',
  (req, res) => {

    try {

      const countryCode =
        normalizeCode(
          req.params.countryCode
        );


      const result =
        getDecision(
          req.auth.userId,
          countryCode
        );


      if (!result) {

        return res.status(404).json({
          error:
            `Land ${countryCode} wird nicht unterstützt.`
        });
      }


      // --------------------------------------------------------
      // PLAN LIMIT
      // --------------------------------------------------------

      const customer =
        result.customer;


      const activationCount =
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM activations
          WHERE customer_id = ?
        `).get(
          customer.id
        ).count;


      const maxCountries =
        customer.plan === 'S'
          ? 2
          : 27;


      if (
        activationCount >=
        maxCountries
      ) {

        return res.status(403).json({
          error:
            `Ihr Plan erlaubt maximal ${maxCountries} Länder.`
        });
      }


      // --------------------------------------------------------
      // BEREITS AKTIVIERT?
      // --------------------------------------------------------

      const existingActivation =
        db.prepare(`
          SELECT *
          FROM activations
          WHERE customer_id = ?
            AND country_code = ?
        `).get(

          req.auth.userId,

          countryCode

        );


      if (existingActivation) {

        return res.status(409).json({

          error:
            'Dieses Land ist bereits aktiviert.',

          activation:
            existingActivation

        });
      }


      // --------------------------------------------------------
      // FORMULARDATEN
      // --------------------------------------------------------

      const existingNumber =
        clean(
          req.body?.existing_number
        );


      const representative =
        readRepresentative(
          req.body
        );


      // --------------------------------------------------------
      // STATUS
      // --------------------------------------------------------

      const providerStatus =
        result.decision.representativeRequired

          ? (
              result.decision.providerAvailable
                ? 'required'
                : 'required_manual_check'
            )

          : 'not_required';


      const state =
        calculateState({

          decision:
            result.decision,

          existingNumber,

          representative,

          providerStatus

        });


      const snapshot =
        buildSnapshot({

          decision:
            result.decision,

          state,

          existingNumber,

          representative:
            representative.name
              ? representative
              : null

        });


      const providerId =
        result.decision.providerAvailable
          ? (
              result.decision.providerId ||
              'lappa'
            )
          : null;


      // --------------------------------------------------------
      // AKTIVIERUNG SPEICHERN
      // --------------------------------------------------------

      const insertActivation =
        db.prepare(`
          INSERT INTO activations (

            customer_id,

            country_code,

            status,

            existing_number,

            representative_name,

            representative_company,

            representative_email,

            provider_id,

            provider_status,

            mode,

            mode_updated_at,

            compliance_status,

            registration_status,

            representative_status,

            compliance_snapshot

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
            datetime('now'),
            ?,
            ?,
            ?,
            ?

          )
        `);


      const inserted =
        insertActivation.run(

          req.auth.userId,

          countryCode,

          state.status,

          existingNumber ||
            null,

          representative.name ||
            null,

          representative.company ||
            null,

          representative.email ||
            null,

          providerId,

          state.providerStatus,

          state.mode,

          result.decision.status,

          state.registrationStatus,

          state.representativeStatus,

          snapshot

        );


      // --------------------------------------------------------
      // COMPLIANCE CASE
      //
      // DAS WAR DER KONKRETE FEHLER:
      // compliance_status MUSS GESETZT WERDEN.
      // --------------------------------------------------------

      db.prepare(`
        INSERT INTO compliance_cases (

          customer_id,

          country_code,

          compliance_status,

          registration_status,

          representative_status,

          provider_id,

          external_status,

          snapshot_json,

          updated_at

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
          datetime('now')

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

          external_status =
            excluded.external_status,

          snapshot_json =
            excluded.snapshot_json,

          updated_at =
            datetime('now')

      `).run(

        req.auth.userId,

        countryCode,

        result.decision.status,

        state.registrationStatus,

        state.representativeStatus,

        providerId,

        result.decision.status,

        snapshot

      );


      // --------------------------------------------------------
      // AKTIVIERUNG AUS DB LADEN
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
            c.registration_url,
            c.data_status
          FROM activations a
          JOIN countries c
            ON c.code =
               a.country_code
          WHERE a.id = ?
        `).get(
          inserted.lastInsertRowid
        );


      return res.status(201).json({

        ok:
          true,

        activation,

        compliance:
          result.decision,

        fullyConfigured:
          state.fullyConfigured

      });

    } catch (error) {

      console.error(
        '❌ Fehler bei der Länderaktivierung:',
        error
      );

      return res.status(500).json({
        error:
          'Fehler bei der Länderaktivierung: ' +
          error.message
      });
    }
  }
);


// ============================================================
// AKTIVIERUNG AKTUALISIEREN
//
// PUT /api/activations/PL
// ============================================================

router.put(
  '/:countryCode',
  (req, res) => {

    try {

      const countryCode =
        normalizeCode(
          req.params.countryCode
        );


      const result =
        getDecision(
          req.auth.userId,
          countryCode
        );


      if (!result) {

        return res.status(404).json({
          error:
            'Land nicht gefunden.'
        });
      }


      const activation =
        db.prepare(`
          SELECT *
          FROM activations
          WHERE customer_id = ?
            AND country_code = ?
        `).get(

          req.auth.userId,

          countryCode

        );


      if (!activation) {

        return res.status(404).json({
          error:
            'Land ist noch nicht aktiviert.'
        });
      }


      const existingNumber =
        clean(
          req.body?.existing_number
        );


      const representative =
        readRepresentative(
          req.body
        );


      const providerStatus =
        activation.provider_status ||
        (
          result.decision.representativeRequired
            ? 'required'
            : 'not_required'
        );


      const state =
        calculateState({

          decision:
            result.decision,

          existingNumber,

          representative,

          providerStatus

        });


      const snapshot =
        buildSnapshot({

          decision:
            result.decision,

          state,

          existingNumber,

          representative

        });


      db.prepare(`
        UPDATE activations

        SET

          existing_number = ?,

          representative_name = ?,

          representative_company = ?,

          representative_email = ?,

          status = ?,

          mode = ?,

          mode_updated_at =
            datetime('now'),

          compliance_status = ?,

          registration_status = ?,

          representative_status = ?,

          compliance_snapshot = ?

        WHERE customer_id = ?

          AND country_code = ?

      `).run(

        existingNumber ||
          null,

        representative.name ||
          null,

        representative.company ||
          null,

        representative.email ||
          null,

        state.status,

        state.mode,

        result.decision.status,

        state.registrationStatus,

        state.representativeStatus,

        snapshot,

        req.auth.userId,

        countryCode

      );


      // Compliance Case synchronisieren

      db.prepare(`
        INSERT INTO compliance_cases (

          customer_id,

          country_code,

          compliance_status,

          registration_status,

          representative_status,

          provider_id,

          external_status,

          snapshot_json,

          updated_at

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
          datetime('now')

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

          external_status =
            excluded.external_status,

          snapshot_json =
            excluded.snapshot_json,

          updated_at =
            datetime('now')

      `).run(

        req.auth.userId,

        countryCode,

        result.decision.status,

        state.registrationStatus,

        state.representativeStatus,

        activation.provider_id ||
          null,

        result.decision.status,

        snapshot

      );


      const updated =
        db.prepare(`
          SELECT
            a.*,
            c.name,
            c.flag,
            c.register_body,
            c.representative_required,
            c.notary_required,
            c.notary_cost,
            c.registration_url,
            c.data_status
          FROM activations a
          JOIN countries c
            ON c.code =
               a.country_code
          WHERE a.customer_id = ?
            AND a.country_code = ?
        `).get(

          req.auth.userId,

          countryCode

        );


      return res.json({

        ok:
          true,

        activation:
          updated,

        compliance:
          result.decision,

        fullyConfigured:
          state.fullyConfigured

      });

    } catch (error) {

      console.error(
        '❌ Fehler beim Aktualisieren:',
        error
      );

      return res.status(500).json({
        error:
          'Fehler beim Aktualisieren der Aktivierung: ' +
          error.message
      });
    }
  }
);


// ============================================================
// SIGNATUR
//
// POST /api/activations/PL/sign
// ============================================================

router.post(
  '/:countryCode/sign',
  (req, res) => {

    try {

      const countryCode =
        normalizeCode(
          req.params.countryCode
        );


      const result =
        getDecision(
          req.auth.userId,
          countryCode
        );


      if (!result) {

        return res.status(404).json({
          error:
            'Land nicht gefunden.'
        });
      }


      const activation =
        db.prepare(`
          SELECT *
          FROM activations
          WHERE customer_id = ?
            AND country_code = ?
        `).get(

          req.auth.userId,

          countryCode

        );


      if (!activation) {

        return res.status(404).json({
          error:
            'Keine Aktivierung für dieses Land gefunden.'
        });
      }


      const representative = {

        name:
          activation.representative_name ||
          '',

        company:
          activation.representative_company ||
          '',

        email:
          activation.representative_email ||
          ''

      };


      const state =
        calculateState({

          decision:
            result.decision,

          existingNumber:
            activation.existing_number,

          representative,

          providerStatus:
            activation.provider_status

        });


      if (
        !state.fullyConfigured
      ) {

        return res.status(400).json({

          error:
            'Die Aktivierung kann noch nicht signiert werden.',

          compliance:
            result.decision,

          state

        });
      }


      db.prepare(`
        UPDATE activations

        SET

          signed_at =
            datetime('now'),

          status =
            'active',

          mode =
            'verified',

          mode_updated_at =
            datetime('now')

        WHERE customer_id = ?

          AND country_code = ?

      `).run(

        req.auth.userId,

        countryCode

      );


      const updated =
        db.prepare(`
          SELECT *
          FROM activations
          WHERE customer_id = ?
            AND country_code = ?
        `).get(

          req.auth.userId,

          countryCode

        );


      return res.json({

        ok:
          true,

        activation:
          updated,

        compliance:
          result.decision

      });

    } catch (error) {

      console.error(
        '❌ Signaturfehler:',
        error
      );

      return res.status(500).json({
        error:
          'Signatur konnte nicht gespeichert werden: ' +
          error.message
      });
    }
  }
);


// ============================================================
// STATUS
// GET /api/activations/status
// ============================================================

router.get(
  '/status',
  (req, res) => {

    try {

      const rows =
        db.prepare(`
          SELECT
            a.*,
            c.name,
            c.flag
          FROM activations a
          JOIN countries c
            ON c.code =
               a.country_code
          WHERE a.customer_id = ?
          ORDER BY c.name
        `).all(
          req.auth.userId
        );


      return res.json(
        rows
      );

    } catch (error) {

      console.error(
        '❌ Aktivierungsstatus:',
        error
      );

      return res.status(500).json({
        error:
          'Aktivierungsstatus konnte nicht geladen werden.'
      });
    }
  }
);


module.exports = router;
