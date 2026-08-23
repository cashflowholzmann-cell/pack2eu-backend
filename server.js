require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const { init } = db;
init();

// Routes
const authRoutes = require('./routes/auth');
const countryRoutes = require('./routes/countries');
const activationRoutes = require('./routes/activations');
const submissionRoutes = require('./routes/submissions');
const exportRoutes = require('./routes/exports');
const skusRoutes = require('./routes/skus');
const shopifyRoutes = require('./routes/shopify');
const representativeRoutes = require('./routes/representatives');
const billingRoutes = require('./routes/billing');
const lappaRoutes = require('./routes/lappa');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ⭐ WICHTIG: Webhook MUSS VOR express.json() kommen!
// ============================================================

// 1. Webhook-Route mit raw-Body-Parser (NUR für diesen Endpunkt)
app.use('/api/billing/webhooks/stripe', express.raw({ type: 'application/json' }));

// 2. CORS (kann vor oder nach express.json() kommen)
app.use(cors({ origin: '*' }));

// 3. JSON-Parser für ALLE ANDEREN Routes
app.use(express.json({ limit: '500kb' }));

// 4. Rate-Limiting für Auth
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth', authLimiter);

// 5. Health-Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'Pack2EU' });
});

// 6. Routes (REIHENFOLGE EQUAL)
app.use('/api/auth', authRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/activations', activationRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/skus', skusRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/representatives', representativeRoutes);
app.use('/api/billing', billingRoutes); // ← HIER IST DER WEBHOOK DRIN
app.use('/api/lappa', lappaRoutes);

// 7. 404-Fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Endpunkt nicht gefunden.' });
});

// 8. Error-Handler
app.use((err, req, res, next) => {
  console.error('❌ Serverfehler:', err);
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Pack2EU Backend läuft auf Port ${PORT}`);
  console.log(`📡 Webhook-URL: http://localhost:${PORT}/api/billing/webhooks/stripe`);
});
