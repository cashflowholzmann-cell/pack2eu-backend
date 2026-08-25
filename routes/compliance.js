const express = require('express');
const db = require('../db');

const {
  requireAuth,
  requireCustomer
} = require('../middleware/auth');

const {
  decide,
  normalizeCode
} = require('../compliance-engine');


const router =
  express.Router();


// ============================================================
// AUTH
// ============================================================

router.use(
  requireAuth,
  requireCustomer
);


// ============================================================
// HÄNDLER
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
// LAND
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
// REGEL
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
    normalizeCode(originCountry),
    normalizeCode(destinationCountry)
  );
}


// ============================================================
// ENTSCHEIDUNG
// ============================================================

function buildDecision(
  customer,
  destinationCode
) {

  const destination =
    normalizeCode(
      destinationCode
    );

  const country =
    getCountry(destination);

  if (!country) {
    return null;
  }

  const rule =
    getRule(
      customer.origin_country,
      destination
    );

  return decide({

    originCountry:
      customer.origin_country,

    destinationCountry:
      destination,

    rule,

    destinationMeta:
      country

  });
}


// ============================================================
// EINZELNES LAND
// GET /api/compliance/DE
// ============================================================

router.get(
  '/:destination',
  (req, res) => {

    try {

      const customer =
        getCustomer(
          req.auth.userId
        );

      if (!customer) {

        return res.status(404).json({
          error:
            'Kunde nicht gefunden.'
        });
      }


      const code =
        normalizeCode(
          req.params.destination
        );


      const country =
        getCountry(code);


      if (!country) {

        return res.status(404).json({
          error:
            `Zielland ${code} wird nicht unterstützt.`
        });
      }


      const compliance =
        buildDecision(
          customer,
          code
        );


      const activation =
        db.prepare(`
          SELECT *
          FROM activations
          WHERE customer_id = ?
            AND country_code = ?
        `).get(
          customer.id,
          code
        );


      return res.json({

        country_code:
          code,

        name:
          country.name,

        flag:
          country.flag,

        register_body:
          country.register_body,

        registration_url:
          country.registration_url ||
          '',

        data_status:
          country.data_status ||
          'needs_verification',

        plan:
          customer.plan,

        compliance,

        activation:
          activation ||
          null
      });

    } catch (error) {

      console.error(
        '❌ Compliance error:',
        error
      );

      return res.status(500).json({
        error:
          'Compliance-Prüfung fehlgeschlagen: ' +
          error.message
      });
    }
  }
);


// ============================================================
// ALLE LÄNDER
// GET /api/compliance
// ============================================================

router.get(
  '/',
  (req, res) => {

    try {

      const customer =
        getCustomer(
          req.auth.userId
        );


      if (!customer) {

        return res.status(404).json({
          error:
            'Kunde nicht gefunden.'
        });
      }


      const countries =
        db.prepare(`
          SELECT
            code,
            name,
            flag,
            register_body,
            data_status,
            registration_url,
            representative_required,
            notary_required,
            notary_cost
          FROM countries
          ORDER BY name
        `).all();


      const activations =
        db.prepare(`
          SELECT
            *
          FROM activations
          WHERE customer_id = ?
        `).all(
          customer.id
        );


      const activationMap =
        new Map(
          activations.map(
            activation => [
              activation.country_code,
              activation
            ]
          )
        );


      const result =
        countries.map(
          country => {

            const activation =
              activationMap.get(
                country.code
              ) || null;


            const compliance =
              buildDecision(
                customer,
                country.code
              );


            return {

              country_code:
                country.code,

              name:
                country.name,

              flag:
                country.flag,

              register_body:
                country.register_body,

              data_status:
                country.data_status ||
                'needs_verification',

              registration_url:
                country.registration_url ||
                '',

              status:
                activation?.status ||
                'inactive',

              mode:
                activation?.mode ||
                null,

              provider_status:
                activation?.provider_status ||
                null,

              provider_epr_number:
                activation?.provider_epr_number ||
                null,

              representative_required:
                country.representative_required === 1,

              notary_required:
                country.notary_required === 1,

              notary_cost:
                country.notary_cost ||
                '',

              compliance

            };
          }
        );


      return res.json(result);

    } catch (error) {

      console.error(
        '❌ Compliance overview error:',
        error
      );

      return res.status(500).json({
        error:
          'Compliance-Daten konnten nicht geladen werden: ' +
          error.message
      });
    }
  }
);


module.exports = router;
