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
const faqChatRoutes = require('./routes/faq-chat');

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

// DB-Restore braucht ebenfalls den rohen Body statt geparstem JSON -
// hier ist es eine binäre .db-Datei, nicht JSON, und deutlich größer
// als das 500kb-Limit von express.json() weiter unten.
app.use(
  '/api/admin/backup/restore',
  express.raw({ type: 'application/octet-stream', limit: '100mb' })
);

// Shopify-Webhooks brauchen ebenfalls den rohen Body, um die
// X-Shopify-Hmac-Sha256-Signatur zu verifizieren (siehe
// routes/shopify.js) - exakt dasselbe Muster wie beim Stripe-Webhook.
app.use(
  '/api/shopify/webhook',
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
// ÖFFENTLICHE KONFIG: Erstgespräch-Buchung
// ============================================================
// Liefert den Google-Calendar-Terminplanungsseiten-Link für den
// "Termin vereinbaren"-Button auf der Landingpage (senkt die
// Zahlungsschwelle für Unentschlossene - siehe DISCOVERY_CALL_CALENDAR_URL
// in .env.example). Kein Secret, daher ohne Auth - der Link kommt aus
// process.env statt fest im Frontend, damit er ohne Deploy geändert
// werden kann und der Button ausgeblendet bleibt, solange nichts
// konfiguriert ist.
app.get('/api/config/discovery-call', (req, res) => {
  res.json({ url: process.env.DISCOVERY_CALL_CALENDAR_URL || null });
});

// ============================================================
// SHOPIFY EMBEDDED APP - STARTSEITE
// ============================================================
// Die Seite, die Shopify im Admin-Iframe unter "Apps -> Pack2EU" anzeigt
// (in der Shopify-Partner-Dashboard-App-Einstellung als "App URL"
// hinterlegt). Bewusst minimal und direkt im Backend statt in einem
// eigenen Projekt, damit sie dieselbe stabile Render-URL nutzt wie die
// API selbst - kein Cloudflare-Tunnel/separates Hosting mehr nötig.
// Braucht Shopify App Bridge (Pflicht für eingebettete Apps), das den
// öffentlichen Client-ID/API-Key aus SHOPIFY_CLIENT_ID injiziert
// bekommt - kein Secret, daher unbedenklich serverseitig einzusetzen.
app.get('/shopify-app', (req, res) => {
  const apiKey = process.env.SHOPIFY_CLIENT_ID || '';
  const appUrl = process.env.APP_URL || 'https://www.pack2eu.global';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pack2EU</title>
  <meta name="shopify-api-key" content="${apiKey}">
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#F8FAFC; color:#0F172A; margin:0; padding:40px 24px; }
    .card { max-width: 560px; margin: 0 auto; background:#fff; border-radius:12px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
    h1 { font-size: 22px; margin: 0 0 12px; color:#0A2540; }
    p { line-height: 1.6; color:#334155; }
    .btn { display:inline-block; margin-top:16px; background:#0066FF; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Willkommen bei Pack2EU für Shopify</h1>
    <p>Diese App verbindet deinen Shopify-Store mit der Pack2EU-Plattform, damit du EU-Verpackungs-, WEEE- und Batterie-Pflichten automatisiert aus deinen Bestelldaten erfüllen kannst.</p>
    <a class="btn" href="${appUrl}/dashboard.html" target="_top">Pack2EU Dashboard öffnen</a>
  </div>
  <script>
    // App Bridge initialisiert sich über das obige Meta-Tag automatisch.
    // Der Dashboard-Link nutzt target="_top", um aus dem Shopify-Iframe
    // auszubrechen - eine normale Navigation innerhalb des Iframes würde
    // sonst von Shopifys eigener Content-Security-Policy blockiert.
  </script>
</body>
</html>`);
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
app.use('/api/faq-chat', faqChatRoutes);

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

// ============================================================
// RECHTSÄNDERUNGS-RADAR: KEIN AUTOMATISCHER LAUF MEHR
//
// Bis 03.09.2026 lief hier automatisch dienstags/donnerstags ein Check
// (siehe Git-Historie). Nach einem Kosten-Vorfall an diesem Tag (ein
// einzelner manueller 3-Länder-Testlauf hat mehrere Dollar
// Anthropic-Guthaben verbraucht und das Konto ins Minus gebracht) hat
// der Nutzer die automatische Ausführung ausdrücklich abgestellt. Das
// Feature läuft jetzt NUR NOCH manuell über den "Jetzt prüfen"-Button
// im Admin-Tool (siehe routes/admin.js, POST /legal-watch/run) - dort
// entscheidet bewusst ein Mensch pro Klick, ob wieder Kosten anfallen.
// ============================================================
