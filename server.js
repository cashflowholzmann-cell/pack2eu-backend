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
const { router: billingRoutes, handleWebhook } = require('./routes/billing');

init();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Stripe Webhook
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// Shopify Webhook
app.post('/api/shopify/webhook/orders/create', express.raw({ type: 'application/json' }), (req, res) => {
  require('./routes/shopify').handleWebhook(req, res);
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