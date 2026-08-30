const express = require('express');
const Stripe = require('stripe');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================
// CHECKOUT SESSION FÜR ABO (PLAN-UPGRADE)
// ============================================================
// Monatliche und jährliche Preise sind getrennte Stripe-Price-IDs (Stripe
// kennt kein "gleicher Preis, anderes Intervall" pro Objekt). Die
// _ANNUAL-Varianten müssen im Stripe-Dashboard angelegt und hier als
// eigene Umgebungsvariablen hinterlegt werden - ist das nicht der Fall,
// lehnen wir die Jahres-Buchung mit einer klaren Fehlermeldung ab, statt
// versehentlich zum Monatspreis abzurechnen.
const STRIPE_PRICE_IDS = {
  monthly: { S: 'STRIPE_PRICE_S', M: 'STRIPE_PRICE_M', L: 'STRIPE_PRICE_L' },
  annual: { S: 'STRIPE_PRICE_S_ANNUAL', M: 'STRIPE_PRICE_M_ANNUAL', L: 'STRIPE_PRICE_L_ANNUAL' }
};

// Amazon-Zusatzmodul (kostenpflichtig, da uns Amazons SP-API im Gegensatz
// zu Shopify/Etsy/Kaufland/eBay echte Nutzungsgebühren verursacht) - der
// tatsächliche Preis (mit Aufschlag auf unsere Amazon-Kosten) wird als
// Stripe-Preis im Dashboard angelegt, sobald die Kosten bekannt sind, und
// hier nur als Env-Var referenziert - kein Betrag im Code.
const STRIPE_PRICE_AMAZON_ADDON = 'STRIPE_PRICE_AMAZON_ADDON';

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const interval = req.body.interval === 'annual' ? 'annual' : 'monthly';

  const envVarName = (STRIPE_PRICE_IDS[interval] || STRIPE_PRICE_IDS.monthly)[plan] || STRIPE_PRICE_IDS.monthly.M;
  const priceId = process.env[envVarName];

  if (!priceId) {
    return res.status(400).json({
      error: interval === 'annual'
        ? 'Die Jahreszahlung für diesen Plan ist noch nicht konfiguriert.'
        : 'Für diesen Plan ist kein Preis konfiguriert.'
    });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.sub);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  let stripeCustomerId = customer.stripe_customer_id;
  if (!stripeCustomerId) {
    const sc = await stripe.customers.create({
      email: customer.email,
      name: customer.company_name,
      metadata: { customer_number: customer.customer_number }
    });
    stripeCustomerId = sc.id;
    db.prepare('UPDATE customers SET stripe_customer_id = ? WHERE id = ?').run(stripeCustomerId, customer.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/Dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/index.html`,
    metadata: {
      user_id: customer.id,
      plan: plan,
      interval: interval,
      type: 'plan_upgrade'
    }
  });

  res.json({ url: session.url });
});

// ============================================================
// PREMIUM-UPGRADE ZAHLUNG (149 € pro Land)
// ============================================================
router.post('/create-upgrade-session', requireAuth, async (req, res) => {
  const { country, price, type } = req.body;
  const customerId = req.customer.sub;

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  const activation = db.prepare(
    'SELECT id, mode FROM activations WHERE customer_id = ? AND country_code = ?'
  ).get(customerId, country);

  if (!activation) {
    return res.status(404).json({ error: 'Land nicht aktiviert.' });
  }

  if (activation.mode === 'premium') {
    return res.status(400).json({ error: 'Bereits im Premium-Modus.' });
  }

  let stripeCustomerId = customer.stripe_customer_id;
  if (!stripeCustomerId) {
    const sc = await stripe.customers.create({
      email: customer.email,
      name: customer.company_name,
      metadata: { customer_number: customer.customer_number }
    });
    stripeCustomerId = sc.id;
    db.prepare('UPDATE customers SET stripe_customer_id = ? WHERE id = ?').run(stripeCustomerId, customer.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: `Pack2EU Premium Upgrade – ${country}`,
          description: `Bevollmächtigter für ${country} (149 €)`
        },
        unit_amount: price * 100,
      },
      quantity: 1,
    }],
    success_url: `${process.env.APP_URL}/Dashboard.html?upgrade=success&country=${country}`,
    cancel_url: `${process.env.APP_URL}/Dashboard.html?upgrade=cancel`,
    metadata: {
      user_id: customerId,
      country: country,
      type: type || 'premium_upgrade'
    }
  });

  res.json({ url: session.url });
});

// ============================================================
// AMAZON-ZUSATZMODUL BUCHEN (kostenpflichtiges Abo-Add-on)
// ============================================================
router.post('/create-amazon-addon-session', requireAuth, async (req, res) => {
  const priceId = process.env[STRIPE_PRICE_AMAZON_ADDON];

  if (!priceId) {
    return res.status(400).json({
      error: 'Das Amazon-Zusatzmodul ist noch nicht buchbar - der Preis wird gerade hinterlegt.'
    });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.sub);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  if (customer.amazon_addon_active) {
    return res.status(400).json({ error: 'Das Amazon-Zusatzmodul ist bereits gebucht.' });
  }

  let stripeCustomerId = customer.stripe_customer_id;
  if (!stripeCustomerId) {
    const sc = await stripe.customers.create({
      email: customer.email,
      name: customer.company_name,
      metadata: { customer_number: customer.customer_number }
    });
    stripeCustomerId = sc.id;
    db.prepare('UPDATE customers SET stripe_customer_id = ? WHERE id = ?').run(stripeCustomerId, customer.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/Dashboard.html?amazon_addon=success`,
    cancel_url: `${process.env.APP_URL}/Dashboard.html?amazon_addon=cancel`,
    metadata: {
      user_id: customer.id,
      type: 'amazon_addon_purchase'
    }
  });

  res.json({ url: session.url });
});

// ============================================================
// ⭐ STRIPE WEBHOOK (MIT LAPPA-PLATZHALTER)
// ============================================================
router.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = req.body.toString();
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook-Signaturfehler: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, country, type, plan, interval } = session.metadata || {};

    console.log(`✅ Zahlung erfolgreich: User ${user_id}, Land ${country}, Typ ${type}, Plan ${plan}, Intervall ${interval}`);

    try {
      // ⭐ Fall 1: Premium-Upgrade für ein Land
      if (type === 'premium_upgrade' || type === 'representative_booking') {
        if (country && user_id) {
          // 1. Datenbank updaten
          db.prepare(`
            UPDATE activations 
            SET mode = 'premium', mode_updated_at = datetime('now')
            WHERE customer_id = ? AND country_code = ?
          `).run(parseInt(user_id), country);
          console.log(`✅ Premium-Modus für ${country} aktiviert (User ${user_id})`);

          // ⭐ 2. LAPPA-API AUFRUFEN (Platzhalter)
          await registerRepresentativeWithLappa(parseInt(user_id), country);
        }
      }

      // ⭐ Fall 2: Plan-Upgrade (oder Erstbuchung direkt bei der Registrierung)
      // - schaltet die eigentliche Produktnutzung erst nach echter Zahlung
      // frei (siehe requireActiveSubscription in middleware/auth.js).
      if (type === 'plan_upgrade' && plan && user_id) {
        db.prepare(`
          UPDATE customers
          SET plan = ?, billing_interval = ?, subscription_status = 'active', stripe_subscription_id = ?
          WHERE id = ?
        `).run(plan, interval === 'annual' ? 'annual' : 'monthly', session.subscription || null, parseInt(user_id));
        console.log(`✅ Plan auf ${plan} geupgradet und aktiviert (User ${user_id})`);
      }

      // ⭐ Fall 3: Amazon-Zusatzmodul gebucht
      if (type === 'amazon_addon_purchase' && user_id) {
        db.prepare(`
          UPDATE customers
          SET amazon_addon_active = 1, amazon_addon_subscription_id = ?
          WHERE id = ?
        `).run(session.subscription || null, parseInt(user_id));
        console.log(`✅ Amazon-Zusatzmodul aktiviert (User ${user_id})`);
      }

    } catch (err) {
      console.error('❌ Fehler beim DB-Update:', err);
    }
  }

  // Abo gekündigt oder Zahlung endgültig fehlgeschlagen -> Zugang wieder
  // sperren. Trifft entweder das Haupt-Abo (Plan, siehe
  // requireActiveSubscription) oder das Amazon-Zusatzmodul - je nachdem,
  // welche subscription_id in der Kunden-Zeile hinterlegt ist.
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    try {
      db.prepare(`
        UPDATE customers
        SET subscription_status = 'inactive'
        WHERE stripe_subscription_id = ?
      `).run(subscription.id);

      db.prepare(`
        UPDATE customers
        SET amazon_addon_active = 0
        WHERE amazon_addon_subscription_id = ?
      `).run(subscription.id);
    } catch (err) {
      console.error('❌ Fehler beim Deaktivieren des Abos:', err);
    }
  }

  res.json({ received: true });
});

// ============================================================
// ⭐ LAPPA-API PLATZHALTER (MORGEN IMPLEMENTIEREN)
// ============================================================
async function registerRepresentativeWithLappa(userId, countryCode) {
  console.log(`📞 LAPPA-API AUFRUF: User ${userId}, Land ${countryCode}`);
  
  try {
    // ⭐ MORGEN HIER DIE ECHTE LAPPA-API IMPLEMENTIEREN
    // const response = await fetch('https://api.lappa.io/v1/representatives', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${process.env.LAPPA_API_KEY}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     customerId: userId,
    //     countryCode: countryCode,
    //     // Weitere Felder laut Lappa-Dokumentation
    //   })
    // });
    // const data = await response.json();
    // 
    // // Lappa-Response in der DB speichern
    // db.prepare(`
    //   UPDATE activations 
    //   SET provider_id = ?, provider_status = 'registered', provider_data = ?
    //   WHERE customer_id = ? AND country_code = ?
    // `).run(data.representativeId, JSON.stringify(data), userId, countryCode);
    
    // console.log(`✅ Lappa-Registrierung für ${countryCode} erfolgreich`);

    // ⭐ PLATZHALTER: Nur Log-Ausgabe
    console.log(`ℹ️ LAPPA-API (Platzhalter): Registrierung für ${countryCode} würde jetzt erfolgen.`);
    
    // Simuliere erfolgreiche Registrierung
    return { success: true, representativeId: 'lappa_placeholder_' + Date.now() };
    
  } catch (error) {
    console.error(`❌ Fehler bei Lappa-API:`, error.message);
    // ⭐ WICHTIG: Fehler nur loggen – mode bleibt auf premium!
    // Der Händler hat bezahlt, die Registrierung wird später nachgeholt
    return { success: false, error: error.message };
  }
}

// ============================================================
// ABO-STATUS
// ============================================================
router.get('/status', requireAuth, (req, res) => {
  const customer = db.prepare('SELECT plan, subscription_status FROM customers WHERE id = ?').get(req.customer.sub);
  res.json(customer || { plan: 'M', subscription_status: 'inactive' });
});

module.exports = router
