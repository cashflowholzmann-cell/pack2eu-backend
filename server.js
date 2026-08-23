require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const db = require('./db');
const { init } = db;
init();

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

// ⭐ Webhook MUSS VOR express.json() kommen!
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

// ============================================================
// ⭐ NOTFALL: MODE MANUELL ZURÜCKSETZEN (NUR FÜR TESTS!)
// ============================================================
app.post('/api/reset-mode', async (req, res) => {
  try {
    const { email, countryCode } = req.body;
    
    console.log(`🔍 Reset-Versuch: E-Mail=${email}, Land=${countryCode}`);
    
    const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
    if (!customer) {
      return res.status(404).json({ error: 'Kunde nicht gefunden.' });
    }
    
    console.log(`✅ Kunde gefunden: ID=${customer.id}`);
    
    const activation = db.prepare(
      'SELECT id, mode FROM activations WHERE customer_id = ? AND country_code = ?'
    ).get(customer.id, countryCode);
    
    if (!activation) {
      return res.status(404).json({ error: 'Land nicht aktiviert.' });
    }
    
    console.log(`ℹ️ Aktueller Mode: ${activation.mode}`);
    
    db.prepare(`
      UPDATE activations 
      SET mode = 'grauzone', mode_updated_at = datetime('now')
      WHERE customer_id = ? AND country_code = ?
    `).run(customer.id, countryCode);
    
    console.log(`✅ Mode für ${countryCode} auf grauzone zurückgesetzt!`);
    
    res.json({ 
      success: true, 
      message: `✅ Mode für ${countryCode} auf grauzone zurückgesetzt!`
    });
  } catch (error) {
    console.error('❌ Fehler beim Reset:', error);
    res.status(500).json({ error: 'Fehler beim Zurücksetzen: ' + error.message });
  }
});

// ============================================================
// ⭐ NOTFALL: MODE ANZEIGEN (NUR FÜR TESTS!)
// ============================================================
app.get('/api/check-mode/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
    if (!customer) {
      return res.status(404).json({ error: 'Kunde nicht gefunden.' });
    }
    
    const activations = db.prepare(`
      SELECT country_code, mode FROM activations WHERE customer_id = ?
    `).all(customer.id);
    
    res.json({ 
      email, 
      customerId: customer.id,
      activations 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
  console.log(`🔧 Reset-Endpoint: POST /api/reset-mode`);
});
