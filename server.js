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
const packageSizesRoutes = require('./routes/package-sizes');
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

// KI-Support-Chat + Verbesserungsvorschläge
const supportRoutes = require('./routes/support');
const feedbackRoutes = require('./routes/feedback');

// Weitere Marktplätze neben Shopify: Etsy und Kaufland direkt nutzbar,
// Amazon und eBay fertig codiert, aktiv sobald die jeweilige externe
// Freigabe da ist und die zugehörigen Env-Vars gesetzt sind.
const etsyRoutes = require('./routes/etsy');
const kauflandRoutes = require('./routes/kaufland');
const amazonRoutes = require('./routes/amazon');
const ebayRoutes = require('./routes/ebay');

// Internes Vertriebs-/Marketing-Tool (Traffic, Leads, Aufgaben).
const adminRoutes = require('./routes/admin');
const trackRoutes = require('./routes/track');

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
app.use('/api/package-sizes', packageSizesRoutes);

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

// KI-Support-Chat + Verbesserungsvorschläge
app.use('/api/support', supportRoutes);
app.use('/api/feedback', feedbackRoutes);

// Weitere Marktplätze
app.use('/api/etsy', etsyRoutes);
app.use('/api/kaufland', kauflandRoutes);
app.use('/api/amazon', amazonRoutes);
app.use('/api/ebay', ebayRoutes);

// Internes Vertriebs-/Marketing-Tool - der Login-Limiter sitzt gezielt
// nur auf /login (siehe routes/admin.js), nicht auf dem ganzen Router,
// sonst würde das normale Nutzen des Tools (viele GETs beim Laden,
// jede Lead-/Aufgaben-Aktion) selbst schnell an ein 20-Anfragen-Limit
// stoßen.
app.use('/api/admin', adminRoutes);
app.use('/api/track', trackRoutes);

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

  scheduleLegalWatch();
});

// ============================================================
// RECHTSÄNDERUNGS-RADAR: LAUF DIENSTAGS UND DONNERSTAGS
//
// Bewusst nicht täglich - Gesetzestexte ändern sich nicht stundenweise,
// und jeder Check kostet zwei echte Claude-Aufrufe pro Land (Recherche +
// strukturierte Auswertung). Zwei feste Wochentage reichen, um zeitnah
// auf Änderungen zu reagieren, ohne unnötig oft zu bezahlen. Pro Lauf
// werden mehr Länder geprüft (10 statt vorher 3), damit trotzdem
// regelmäßig alle Länder durchlaufen werden. Zusätzlich über den
// "Jetzt prüfen"-Button im Admin-Tool jederzeit manuell auslösbar
// (siehe routes/admin.js, POST /legal-watch/run).
//
// Kein externer Cron nötig: beim Start und danach stündlich wird
// geprüft, ob heute (UTC-Wochentag Dienstag/Donnerstag, Datum) schon
// gelaufen ist - so überlebt der Lauf auch einen Server-Neustart, ohne
// doppelt zu laufen.
// ============================================================
const LEGAL_WATCH_WEEKDAYS = [2, 4]; // UTC: 2 = Dienstag, 4 = Donnerstag

async function runDailyLegalWatchIfDue() {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const now = new Date();
  if (!LEGAL_WATCH_WEEKDAYS.includes(now.getUTCDay())) return;

  const today = now.toISOString().slice(0, 10);
  const alreadyRan = db.db
    .prepare('SELECT 1 FROM legal_watch_runs WHERE run_date = ?')
    .get(today);
  if (alreadyRan) return;

  try {
    const { runLegalWatch } = require('./legal-watch');
    const results = await runLegalWatch({ limit: 10 });
    db.db
      .prepare('INSERT OR IGNORE INTO legal_watch_runs (run_date, countries_checked) VALUES (?, ?)')
      .run(today, results.length);
    console.log(`📡 Rechtsänderungs-Radar: ${results.length} Länder geprüft (${today}).`);
  } catch (error) {
    console.error('❌ Rechtsänderungs-Radar (Lauf) fehlgeschlagen:', error.message);
  }
}

function scheduleLegalWatch() {
  runDailyLegalWatchIfDue();
  setInterval(runDailyLegalWatchIfDue, 60 * 60 * 1000);
}
