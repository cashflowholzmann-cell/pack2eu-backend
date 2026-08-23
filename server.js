require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ⭐ GANZ WICHTIG: SO HAT ES FUNKTIONIERT!
const db = require('./DB');
const { init } = db;
init();

// Routes
const authRoutes = require('./Strecken/auth');
const countryRoutes = require('./Strecken/countries');
const activationRoutes = require('./Strecken/activations');
const submissionRoutes = require('./Strecken/submissions');
const exportRoutes = require('./Strecken/exports');
const skusRoutes = require('./Strecken/skus');
const shopifyRoutes = require('./Strecken/shopify');
const representativeRoutes = require('./Strecken/representatives');
const billingRoutes = require('./Strecken/billing');
const lappaRoutes = require('./Strecken/lappa');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api/billing/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '500kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'Pack2EU' });
});

app.use(express.static(path.join(__dirname, '/')));

app.use('/api/auth', authRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/activations', activationRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/skus', skusRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/representatives', representativeRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/lappa', lappaRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Endpunkt nicht gefunden.' });
});

app.use((err, req, res, next) => {
  console.error('❌ Serverfehler:', err);
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Pack2EU Backend läuft auf Port ${PORT}`);
  console.log(`📡 Webhook-URL: http://localhost:${PORT}/api/billing/webhooks/stripe`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}/Dashboard.html`);
});
