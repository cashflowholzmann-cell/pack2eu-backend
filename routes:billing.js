const express = require('express');
const Stripe = require('stripe');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
  });

  res.json({ url: session.url });
});

router.get('/status', requireAuth, (req, res) => {
  const customer = db.prepare('SELECT plan, subscription_status FROM customers WHERE id = ?').get(req.customer.sub);
  res.json(customer || { plan: 'M', subscription_status: 'inactive' });
});

module.exports = { router };