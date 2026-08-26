require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const db = require('./db');
const { init } = db;

// ============================================================
// DATENBANK
// ============================================================

init();

// ============================================================
// ROUTES
// ============================================================

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

// ⭐⭐⭐ NEU: Orders-Route hinzufügen ⭐⭐⭐
const orderRoutes = require('./routes/orders');

// ⭐⭐ NEU: Bulk-Import-Route (CSV)
const bulkImportRoutes = require('./routes/bulk-import');

// ⭐ NEU: zentrale Compliance-Logik
const complianceRoutes = require('./routes/compliance');

// ⭐⭐ NEU: Report-Route
const reportRoutes = require('./routes/reports');

// ============================================================
// APP
// ============================================================

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// STRIPE WEBHOOK
// ============================================================
//
// WICHTIG:
// Stripe benötigt den ORIGINALEN Request Body.
// Deshalb muss express.raw() VOR express.json()
// für genau diese Route registriert werden.
//

app.use(
  '/api/billing/webhooks/stripe',
  express.raw({ type: 'application/json' })
);

// ============================================================
// CORS
// ============================================================

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  : ['*'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests ohne Origin (z.B. Postman, Server-to-Server)
      if (!origin) {
        return callback(null, true);
      }

      // Entwicklung / Wildcard
      if (allowedOrigins.includes('*')) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error('CORS: Origin nicht erlaubt.')
      );
    },
    credentials: true
  })
);

// ============================================================
// JSON BODY
// ============================================================

app.use(
  express.json({
    limit: '500kb'
  })
);

// ============================================================
// RATE LIMITING
// ============================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Zu viele Anfragen. Bitte später erneut versuchen.'
  }
});

const complianceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Zu viele Compliance-Anfragen. Bitte später erneut versuchen.'
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Pack2EU',
    version: '2.0.0',
    time: new Date().toISOString()
  });
});

// ============================================================
// STATISCHE DATEIEN
// ============================================================

app.use(express.static(path.join(__dirname, '/')));

// ============================================================
// API ROUTES
// ============================================================

app.use('/api/auth', authLimiter, authRoutes);

app.use('/api/countries', countryRoutes);

app.use('/api/activations', activationRoutes);

app.use('/api/submissions', submissionRoutes);

app.use('/api/exports', exportRoutes);

app.use('/api/skus', skusRoutes);

app.use('/api/shopify', shopifyRoutes);

app.use('/api/representatives', representativeRoutes);

app.use('/api/billing', billingRoutes);

app.use('/api/lappa', lappaRoutes);

// ⭐⭐⭐ NEU: Orders-Route registrieren ⭐⭐⭐
app.use('/api/orders', orderRoutes);

// ⭐⭐ NEU: Bulk-Import-Route registrieren
app.use('/api/bulk', bulkImportRoutes);

// ⭐ NEU: Zentrale Compliance-Entscheidung
app.use(
  '/api/compliance',
  complianceLimiter,
  complianceRoutes
);

// ⭐⭐ NEU: Report-Route
app.use('/api/reports', reportRoutes);

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpunkt nicht gefunden.'
  });
});

// ============================================================
// GLOBALER ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error('❌ Serverfehler:', err);

  // CORS-Fehler
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({
      error: 'Zugriff von dieser Herkunft nicht erlaubt.'
    });
  }

  res.status(500).json({
    error: 'Interner Serverfehler.'
  });
});

// ============================================================
// SERVER START
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('==============================================');
  console.log('🚀 PACK2EU BACKEND');
  console.log('==============================================');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}/Dashboard.html`);
  console.log(`❤️ Health: http://localhost:${PORT}/api/health`);
  console.log(`⚖️ Compliance: http://localhost:${PORT}/api/compliance`);
  console.log(`📊 Reports: http://localhost:${PORT}/api/reports/annual/2026`);
  console.log(
    `💳 Stripe Webhook: http://localhost:${PORT}/api/billing/webhooks/stripe`
  );
  console.log('==============================================');
  console.log('');
});
