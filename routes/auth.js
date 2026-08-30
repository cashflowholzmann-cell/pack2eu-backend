const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod');

const { db } = require('../db');
const { sendPasswordResetEmail } = require('../lib/email');

const {
  signToken,
  requireAuth
} = require('../middleware/auth');

const {
  getPlanLimits,
  getRepEntitlementCount,
  REP_ENTITLEMENT_COUNTRIES
} = require('../config/plans');

const router =
  express.Router();


// ============================================================
// TEST-ZUGANG (ohne echte Stripe-Zahlung)
//
// Konten mit einer in TEST_ACCESS_EMAILS (Env-Var, kommagetrennt)
// hinterlegten E-Mail-Adresse werden automatisch als bezahlt markiert -
// gedacht für den eigenen Test-Account, um den echten, bezahlten
// Produkt-Flow durchzuklicken, ohne Stripe/echtes Geld. Betrifft
// niemanden sonst: ohne diese Env-Var passiert gar nichts, und die
// E-Mail-Adresse selbst ist nirgends öffentlich sichtbar.
// ============================================================

function isTestAccessEmail(email) {
  const whitelist = (process.env.TEST_ACCESS_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return whitelist.includes(String(email || '').trim().toLowerCase());
}


// ============================================================
// KUNDENNUMMER
// ============================================================

function generateCustomerNumber() {

  return (
    'FC-' +
    Math.floor(
      100000 +
      Math.random() * 900000
    )
  );
}


// ============================================================
// REGISTRIERUNG
// ============================================================

const registerSchema =
  z.object({

    companyName:
      z.string()
        .min(2),

    originCountry:
      z.string()
        .length(2),

    contactName:
      z.string()
        .optional(),

    email:
      z.string()
        .email(),

    password:
      z.string()
        .min(8),

    plan:
      z.enum([
        'S',
        'M',
        'L'
      ])
      .default('M'),

    isEU:
      z.boolean()
        .optional()
        .default(true)

  });


// ============================================================
// REGISTER
// ============================================================

router.post(
  '/register',
  (req, res) => {

    console.log(
      '🔍 Registrierungsversuch:',
      req.body
    );

    const parsed =
      registerSchema.safeParse(
        req.body
      );

    if (!parsed.success) {

      console.log(
        '❌ Validierungsfehler:',
        parsed.error.flatten()
      );

      return res.status(400).json({

        error:
          'Ungültige Eingabe.',

        details:
          parsed.error.flatten()

      });
    }


    const {
      companyName,
      originCountry,
      contactName,
      email,
      password,
      plan,
      isEU
    } =
      parsed.data;


    try {

      const existing =
        db.prepare(`
          SELECT id
          FROM customers
          WHERE email = ?
        `).get(
          email
        );


      if (existing) {

        return res.status(409).json({
          error:
            'E-Mail existiert bereits.'
        });
      }


      const passwordHash =
        bcrypt.hashSync(
          password,
          12
        );


      let customerNumber;

      do {

        customerNumber =
          generateCustomerNumber();

      } while (
        db.prepare(`
          SELECT id
          FROM customers
          WHERE customer_number = ?
        `).get(
          customerNumber
        )
      );


      const insert =
        db.prepare(`
          INSERT INTO customers (
            customer_number,
            company_name,
            origin_country,
            contact_name,
            email,
            password_hash,
            plan,
            is_eu
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);


      const result =
        insert.run(

          customerNumber,

          companyName,

          originCountry
            .trim()
            .toUpperCase(),

          contactName ||
            null,

          email
            .trim()
            .toLowerCase(),

          passwordHash,

          plan,

          isEU
            ? 1
            : 0

        );


      if (isTestAccessEmail(email)) {
        db.prepare(`
          UPDATE customers
          SET subscription_status = 'active'
          WHERE id = ?
        `).run(result.lastInsertRowid);
      }


      const customer =
        db.prepare(`
          SELECT
            id,
            customer_number,
            company_name,
            origin_country,
            is_eu,
            email,
            plan
          FROM customers
          WHERE id = ?
        `).get(
          result.lastInsertRowid
        );


      const token =
        signToken(
          customer
        );


      console.log(
        '✅ Kunde registriert:',
        customer.customer_number
      );


      return res.status(201).json({

        token,

        customer

      });

    } catch (error) {

      console.error(
        '❌ Registrierungsfehler:',
        error
      );

      return res.status(500).json({
        error:
          'Interner Serverfehler bei der Registrierung.'
      });
    }
  }
);


// ============================================================
// LOGIN
// ============================================================

router.post(
  '/login',
  (req, res) => {

    const {
      email,
      password
    } =
      req.body || {};


    try {

      const customer =
        db.prepare(`
          SELECT *
          FROM customers
          WHERE email = ?
        `).get(
          String(
            email || ''
          )
            .trim()
            .toLowerCase()
        );


      if (
        !customer ||
        !bcrypt.compareSync(
          password || '',
          customer.password_hash
        )
      ) {

        return res.status(401).json({
          error:
            'E-Mail oder Passwort falsch.'
        });
      }


      // Selbstheilend: falls die E-Mail erst NACH der Registrierung zu
      // TEST_ACCESS_EMAILS hinzugefügt wurde, wird das Konto beim
      // nächsten Login automatisch freigeschaltet.
      if (customer.subscription_status !== 'active' && isTestAccessEmail(customer.email)) {
        db.prepare(`UPDATE customers SET subscription_status = 'active' WHERE id = ?`).run(customer.id);
        customer.subscription_status = 'active';
      }


      const token =
        signToken(
          customer
        );


      return res.json({

        token,

        customer: {

          id:
            customer.id,

          customer_number:
            customer.customer_number,

          company_name:
            customer.company_name,

          origin_country:
            customer.origin_country,

          is_eu:
            customer.is_eu === 1,

          email:
            customer.email,

          plan:
            customer.plan

        }

      });

    } catch (error) {

      console.error(
        '❌ Login-Fehler:',
        error
      );

      return res.status(500).json({
        error:
          'Interner Serverfehler beim Login.'
      });
    }
  }
);


// ============================================================
// AKTUELLER KUNDE
// GET /api/auth/me
// ============================================================

router.get(
  '/me',
  requireAuth,
  (req, res) => {

    try {

      const customer =
        db.prepare(`
          SELECT
            id,
            customer_number,
            company_name,
            origin_country,
            is_eu,
            email,
            plan,
            subscription_status,
            niche,
            onboarding_completed_at,
            billing_interval,
            rep_entitlement_choices_json,
            (shopify_shop_domain IS NOT NULL) AS shopify_connected,
            (etsy_shop_id IS NOT NULL) AS etsy_connected,
            (kaufland_client_key IS NOT NULL) AS kaufland_connected,
            (amazon_selling_partner_id IS NOT NULL) AS amazon_connected,
            (ebay_access_token IS NOT NULL) AS ebay_connected,
            amazon_addon_active
          FROM customers
          WHERE id = ?
        `).get(
          req.auth.userId
        );


      if (!customer) {

        return res.status(404).json({
          error:
            'Kunde nicht gefunden.'
        });
      }


      const repEntitlementCount =
        getRepEntitlementCount(
          customer.plan,
          customer.billing_interval
        );

      const repEntitlementChoices =
        customer.rep_entitlement_choices_json ?
          JSON.parse(customer.rep_entitlement_choices_json) :
          [];

      const { rep_entitlement_choices_json, ...customerRest } = customer;

      return res.json({

        ...customerRest,

        is_eu:
          customer.is_eu === 1,

        plan_limits:
          getPlanLimits(customer.plan),

        rep_entitlement: {
          count: repEntitlementCount,
          countries: REP_ENTITLEMENT_COUNTRIES,
          choices: repEntitlementChoices
        }

      });

    } catch (error) {

      console.error(
        '❌ Auth-Fehler:',
        error
      );

      return res.status(500).json({
        error:
          'Interner Serverfehler.'
      });
    }
  }
);


// ============================================================
// ONBOARDING ABSCHLIESSEN
//
// Speichert die vom Kunden gewählte Branche (oder "übersprungen", falls
// niche = null) und markiert das Erst-Onboarding als erledigt, damit das
// Dashboard es beim nächsten Login nicht erneut anzeigt.
//
// POST /api/auth/onboarding
// ============================================================

const ONBOARDING_NICHES = [
  'fashion',
  'beauty',
  'home_deco',
  'electronics',
  'baby_toys',
  'sport_outdoor',
  'food_beverage',
  'books_stationery',
  'jewelry_accessories',
  'pet_supplies'
];

const onboardingSchema = z.object({
  niche: z.enum(ONBOARDING_NICHES).nullable().optional()
});

router.post(
  '/onboarding',
  requireAuth,
  (req, res) => {

    try {

      const parsed =
        onboardingSchema.safeParse(
          req.body || {}
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            'Ungültige Branche.'
        });
      }

      const niche =
        parsed.data.niche ||
        null;

      db.prepare(`
        UPDATE customers
        SET
          niche = ?,
          onboarding_completed_at = datetime('now')
        WHERE id = ?
      `).run(
        niche,
        req.auth.userId
      );

      return res.json({
        success: true,
        niche
      });

    } catch (error) {

      console.error(
        '❌ Onboarding-Fehler:',
        error
      );

      return res.status(500).json({
        error:
          'Onboarding konnte nicht gespeichert werden.'
      });
    }
  }
);


// ============================================================
// BEVOLLMÄCHTIGTEN-BONUS: LÄNDERWAHL SPEICHERN
//
// Speichert, für welche(s) der beiden Bonus-Länder (DE/ES) der Kunde
// den im Plan enthaltenen kostenlosen Bevollmächtigten in Anspruch
// nehmen möchte. Löst selbst noch keine Beauftragung/Zahlung aus - das
// ist Stand jetzt ein manueller Vorgang unseres Teams anhand dieser
// gespeicherten Auswahl (siehe Kommentar in schema.sql).
//
// POST /api/auth/rep-entitlement
// Body: { countries: ["DE"] | ["DE","ES"] | [] }
// ============================================================

const repEntitlementSchema = z.object({
  countries: z.array(z.enum(REP_ENTITLEMENT_COUNTRIES)).max(REP_ENTITLEMENT_COUNTRIES.length)
});

router.post(
  '/rep-entitlement',
  requireAuth,
  (req, res) => {

    try {

      const parsed =
        repEntitlementSchema.safeParse(
          req.body || {}
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            'Ungültige Länderauswahl.'
        });
      }

      const customer =
        db.prepare(`
          SELECT plan, billing_interval
          FROM customers
          WHERE id = ?
        `).get(
          req.auth.userId
        );

      if (!customer) {
        return res.status(404).json({
          error:
            'Kunde nicht gefunden.'
        });
      }

      const entitlementCount =
        getRepEntitlementCount(
          customer.plan,
          customer.billing_interval
        );

      // Eindeutige Länder, keine Duplikate.
      const countries =
        Array.from(
          new Set(parsed.data.countries)
        );

      if (countries.length > entitlementCount) {
        return res.status(403).json({
          error:
            `Ihr Plan/Ihre Zahlweise erlaubt aktuell ${entitlementCount} kostenlose(n) Bevollmächtigte(n).`
        });
      }

      db.prepare(`
        UPDATE customers
        SET rep_entitlement_choices_json = ?
        WHERE id = ?
      `).run(
        JSON.stringify(countries),
        req.auth.userId
      );

      return res.json({
        success: true,
        countries
      });

    } catch (error) {

      console.error(
        '❌ Bevollmächtigten-Bonus-Fehler:',
        error
      );

      return res.status(500).json({
        error:
          'Auswahl konnte nicht gespeichert werden.'
      });
    }
  }
);


// ============================================================
// PASSWORT VERGESSEN
//
// Liefert bewusst IMMER dieselbe Erfolgsmeldung, unabhängig davon, ob
// die E-Mail-Adresse existiert - sonst ließe sich darüber ausprobieren,
// welche E-Mail-Adressen bei uns registriert sind. Der Token selbst
// wird nur gehasht gespeichert (wie ein Passwort); der Klartext-Token
// verlässt den Server nur per E-Mail-Link.
//
// POST /api/auth/forgot-password
// Body: { email }
// ============================================================

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const genericResponse = {
    success: true,
    message: 'Falls diese E-Mail-Adresse bei uns registriert ist, haben wir einen Link zum Zurücksetzen des Passworts verschickt.'
  };

  if (!email) return res.json(genericResponse);

  try {
    const customer = db.prepare('SELECT id, email FROM customers WHERE email = ?').get(email);
    if (!customer) return res.json(genericResponse);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE customers
      SET password_reset_token_hash = ?, password_reset_expires_at = ?
      WHERE id = ?
    `).run(tokenHash, expiresAt, customer.id);

    const resetUrl = `${process.env.APP_URL || ''}/index.html?resetToken=${rawToken}`;
    await sendPasswordResetEmail(customer.email, resetUrl);

    return res.json(genericResponse);
  } catch (error) {
    console.error('❌ Forgot-Password-Fehler:', error);
    // Auch im Fehlerfall keine unterschiedliche Antwort - siehe oben.
    return res.json(genericResponse);
  }
});


// ============================================================
// PASSWORT ZURÜCKSETZEN
//
// POST /api/auth/reset-password
// Body: { token, password }
// ============================================================

router.post('/reset-password', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');

  if (!token || password.length < 8) {
    return res.status(400).json({ error: 'Ungültiger Link oder Passwort zu kurz (mind. 8 Zeichen).' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const customer = db.prepare(`
      SELECT id, password_reset_expires_at
      FROM customers
      WHERE password_reset_token_hash = ?
    `).get(tokenHash);

    if (!customer || !customer.password_reset_expires_at || new Date(customer.password_reset_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.' });
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    db.prepare(`
      UPDATE customers
      SET password_hash = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL
      WHERE id = ?
    `).run(passwordHash, customer.id);

    return res.json({ success: true, message: 'Passwort erfolgreich geändert. Du kannst dich jetzt einloggen.' });
  } catch (error) {
    console.error('❌ Reset-Password-Fehler:', error);
    return res.status(500).json({ error: 'Passwort konnte nicht zurückgesetzt werden.' });
  }
});


module.exports = router;
