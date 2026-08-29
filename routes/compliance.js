const express = require('express');

const { db } = require('../db');

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
  code
) {

  return db.prepare(`
    SELECT *
    FROM countries
    WHERE code = ?
  `).get(
    normalizeCode(code)
  );
}


// ============================================================
// REGEL
// ============================================================

function getRule(
  origin,
  destination
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

    normalizeCode(origin),

    normalizeCode(destination)

  );
}


// ============================================================
// ENTSCHEIDUNG
// ============================================================

function buildDecision(
  customer,
  destination
) {

  const code =
    normalizeCode(
      destination
    );

  const country =
    getCountry(
      code
    );


  if (!country) {
    return null;
  }


  const rule =
    getRule(
      customer.origin_country,
      code
    );


  return decide({

    originCountry:
      customer.origin_country,

    destinationCountry:
      code,

    rule,

    destinationMeta:
      country

  });
}


// ============================================================
// COUNTRY PAYLOAD
// ============================================================

function countryPayload(
  country
) {

  return {

    country_code:
      country.code,

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

    representative_required:
      Number(
        country.representative_required
      ) === 1,

    notary_required:
      Number(
        country.notary_required
      ) === 1,

    notary_cost:
      country.notary_cost ||
      '',

    representative_provider_name:
      country.representative_provider_name ||
      '',

    representative_provider_url:
      country.representative_provider_url ||
      '',

    representative_data_status:
      country.representative_data_status ||
      'needs_verification',

    registration_generally_required:
      Number(
        country.registration_generally_required
      ) !== 0,

    reporting_frequency:
      country.reporting_frequency ||
      'needs_verification',

    eco_fee_rates:
      country.eco_fee_rates_json ?
        JSON.parse(country.eco_fee_rates_json) :
        null

  };
}


// ============================================================
// CHECK
//
// DAS IST DER ENTSCHEIDENDE ENDPOINT FÜR DAS ECHTE FRONTEND:
//
// GET /api/compliance/check?destination=PL
// ============================================================

router.get(
  '/check',
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
          req.query.destination
        );


      if (!code) {

        return res.status(400).json({
          error:
            'Zielland fehlt.'
        });
      }


      const country =
        getCountry(
          code
        );


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

        ) || null;


      return res.json({

        country:
          countryPayload(
            country
          ),

        compliance,

        activation,

        customer: {

          id:
            customer.id,

          company_name:
            customer.company_name,

          origin_country:
            customer.origin_country,

          is_eu:
            customer.is_eu === 1,

          plan:
            customer.plan

        }

      });

    } catch (error) {

      console.error(
        '❌ Compliance check error:',
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
// EINZELNES LAND
//
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
        getCountry(
          code
        );


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

        registration_generally_required:
          Number(
            country.registration_generally_required
          ) !== 0,

        reporting_frequency:
          country.reporting_frequency ||
          'needs_verification',

        eco_fee_rates:
          country.eco_fee_rates_json ?
            JSON.parse(country.eco_fee_rates_json) :
            null,

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
//
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
            notary_cost,
            representative_provider_name,
            representative_provider_url,
            representative_data_status,
            registration_generally_required,
            reporting_frequency,
            eco_fee_rates_json
          FROM countries
          ORDER BY name
        `).all();


      const activations =
        db.prepare(`
          SELECT *
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

              ...countryPayload(
                country
              ),

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

              existing_number:
                activation?.existing_number ||
                null,

              representative_name:
                activation?.representative_name ||
                null,

              representative_company:
                activation?.representative_company ||
                null,

              representative_email:
                activation?.representative_email ||
                null,

              representative_status:
                activation?.representative_status ||
                null,

              compliance

            };

          }
        );


      return res.json(
        result
      );

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
