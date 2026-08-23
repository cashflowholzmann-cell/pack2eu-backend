const express = require('express');
const Stripe = require('stripe');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================
// CHECKOUT SESSION FÜR ABO (PLAN-UPGRADE)
// ============================================================
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const priceId = plan === 'S' ? process.env.STRIPE_PRICE_S : 
                  plan === 'L' ? process.env.STRIPE_PRICE_L : process.env.STRIPE_PRICE_M;

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
    success_url: `${process.env.APP_URL}/dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/index.html`,
    metadata: {
      user_id: customer.id,
      plan: plan,
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

  // Prüfen ob Land aktiviert ist
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

  // Stripe-Session für einmalige Zahlung (149 €)
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
        unit_amount: price * 100, // 149 € in Cent
      },
      quantity: 1,
    }],
    success_url: `${process.env.APP_URL}/dashboard.html?upgrade=success&country=${country}`,
    cancel_url: `${process.env.APP_URL}/dashboard.html?upgrade=cancel`,
    metadata: {
      user_id: customerId,
      country: country,
      type: type || 'premium_upgrade'
    }
  });

  res.json({ url: session.url });
});

// ============================================================
// ⭐ STRIPE WEBHOOK (OHNE express.raw() – das kommt aus server.js)
// ============================================================
router.post('/webhooks/stripe', async (req, res) => {
  // ⭐ ACHTUNG: req.body ist bereits der RAW-Buffer von express.raw()
  // Der Buffer muss in einen String konvertiert werden, bevor stripe.webhooks.constructEvent ihn verarbeitet
  
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // ⭐ WICHTIG: req.body ist ein Buffer, aber stripe.webhooks.constructEvent erwartet einen String
    // Lösung: req.body.toString() oder einfach req.body (wenn es schon ein Buffer ist)
    const rawBody = req.body.toString(); // Buffer → String
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook-Signaturfehler: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Erfolgreiche Zahlung verarbeiten
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, country, type, plan } = session.metadata || {};

    console.log(`✅ Zahlung erfolgreich: User ${user_id}, Land ${country}, Typ ${type}, Plan ${plan}`);

    try {
      // ⭐ Fall 1: Premium-Upgrade für ein Land
      if (type === 'premium_upgrade' || type === 'representative_booking') {
        if (country && user_id) {
          db.prepare(`
            UPDATE activations 
            SET mode = 'premium', mode_updated_at = datetime('now')
            WHERE customer_id = ? AND country_code = ?
          `).run(parseInt(user_id), country);

          console.log(`✅ Premium-Modus für ${country} aktiviert (User ${user_id})`);
        } else {
          console.warn(`⚠️ Kein Land oder user_id in Metadata:`, session.metadata);
        }
      }

      // ⭐ Fall 2: Plan-Upgrade
      if (type === 'plan_upgrade' && plan && user_id) {
        db.prepare('UPDATE customers SET plan = ? WHERE id = ?').run(plan, parseInt(user_id));
        console.log(`✅ Plan auf ${plan} geupgradet (User ${user_id})`);
      }

      // ⭐ Fall 3: Subscription (Plan-Upgrade mit Abo)
      if (type === 'subscription' && plan && user_id) {
        db.prepare('UPDATE customers SET plan = ?, subscription_status = "active" WHERE id = ?')
          .run(plan, parseInt(user_id));
        console.log(`✅ Abo auf ${plan} aktiviert (User ${user_id})`);
      }

    } catch (err) {
      console.error('❌ Fehler beim DB-Update:', err);
      // ⭐ NICHT throwen – Stripe soll keinen Retry bekommen
      // Wir loggen den Fehler nur
    }
  }

  res.json({ received: true });
});

// ============================================================
// ABO-STATUS
// ============================================================
router.get('/status', requireAuth, (req, res) => {
  const customer = db.prepare('SELECT plan, subscription_status FROM customers WHERE id = ?').get(req.customer.sub);
  res.json(customer || { plan: 'M', subscription_status: 'inactive' });
});

module.exports = router;
