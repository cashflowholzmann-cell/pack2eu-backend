require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { init } = require('./db');

const authRoutes = require('./routes/auth');
const countryRoutes = require('./routes/countries');
const activationRoutes = require('./routes/activations');
const submissionRoutes = require('./routes/submissions');
const exportRoutes = require('./routes/exports');
const skusRoutes = require('./routes/skus');
const shopifyRoutes = require('./routes/shopify');
const representativeRoutes = require('./routes/representatives');
const billingRoutes = require('./routes/billing');

// Stripe Webhook Handler (direkt hier definiert, nicht aus billing importiert)
const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const { db } = require('./db');
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const customerId = session.metadata?.customer_id;
      if (customerId) {
        db.prepare(`
          UPDATE customers SET stripe_subscription_id = ?, subscription_status = 'active', updated_at = datetime('now')
          WHERE id = ?
        `).run(session.subscription, customerId);
      }
      break;
    }
    case 'invoice.payment_failed': {
      db.prepare(`
        UPDATE customers SET subscription_status = 'past_due', updated_at = datetime('now')
        WHERE stripe_customer_id = ?
      `).run(event.data.object.customer);
      break;
    }
    case 'customer.subscription.deleted': {
      db.prepare(`
        UPDATE customers SET subscription_status = 'canceled', updated_at = datetime('now')
        WHERE stripe_subscription_id = ?
      `).run(event.data.object.id);
      break;
    }
  }
  res.json({ received: true });
};

init();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Stripe Webhook (roher Body)
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// Shopify Webhook (roher Body) – direkt hier definiert
app.post('/api/shopify/webhook/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const order = req.body;
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const { db } = require('./db');
    
    const customer = db.prepare('SELECT * FROM customers WHERE shopify_shop_domain = ?').get(shopDomain);
    if (!customer) {
      console.error(`Kein Kunde für Shop ${shopDomain} gefunden.`);
      return res.status(404).send('Kunde nicht gefunden.');
    }
    
    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ?
    `).all(customer.id);
    
    const skuMap = {};
    skus.forEach(s => {
      if (s.shopify_product_id) skuMap[s.shopify_product_id] = s;
    });
    
    let totalWeight = 0;
    const packagingMaterials = [];
    
    order.line_items.forEach(item => {
      const sku = skuMap[item.product_id];
      if (sku) {
        const weight = sku.total_weight_grams * item.quantity;
        totalWeight += weight;
        const materials = JSON.parse(sku.materials_json);
        materials.forEach(m => {
          packagingMaterials.push({
            material: m.material,
            weight_grams: m.weight_grams * item.quantity,
            is_recyclable: m.is_recyclable
          });
        });
      }
    });
    
    const insert = db.prepare(`
      INSERT INTO shopify_orders 
      (customer_id, shopify_order_id, order_data_json, destination_country, total_weight_grams, packaging_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    insert.run(
      customer.id,
      order.id,
      JSON.stringify(order),
      order.shipping_address?.country_code || 'DE',
      totalWeight,
      JSON.stringify(packagingMaterials)
    );
    
    console.log(`✅ Bestellung ${order.id} verarbeitet: ${totalWeight}g`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

app.use(express.json({ limit: '500kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'Pack2EU' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/activations', activationRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/skus', skusRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/representatives', representativeRoutes);
app.use('/api/billing', billingRoutes);

app.use((req, res) => res.status(404).json({ error: 'Endpunkt nicht gefunden.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

app.listen(PORT, () => {
  console.log(`🚀 Pack2EU Backend läuft auf http://localhost:${PORT}`);
});
