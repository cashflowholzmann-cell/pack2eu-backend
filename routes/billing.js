const express = require('express');
const Stripe = require('stripe');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hasGpsrAccess } = require('../config/plans');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================
// CHECKOUT SESSION FÜR ABO (PLAN-UPGRADE)
// ============================================================
// Monatliche und jährliche Preise sind getrennte Stripe-Price-IDs (Stripe
// kennt kein "gleicher Preis, anderes Intervall" pro Objekt). Die
// _ANNUAL-Varianten müssen im Stripe-Dashboard angelegt und hier als
// eigene Umgebungsvariablen hinterlegt werden - ist das nicht der Fall,
// lehnen wir die Jahres-Buchung mit einer klaren Fehlermeldung ab, statt
// versehentlich zum Monatspreis abzurechnen.
const STRIPE_PRICE_IDS = {
  monthly: { S: 'STRIPE_PRICE_S', M: 'STRIPE_PRICE_M', L: 'STRIPE_PRICE_L' },
  annual: { S: 'STRIPE_PRICE_S_ANNUAL', M: 'STRIPE_PRICE_M_ANNUAL', L: 'STRIPE_PRICE_L_ANNUAL' }
};

// Amazon-Zusatzmodul (kostenpflichtig, da uns Amazons SP-API im Gegensatz
// zu Shopify/Etsy/Kaufland/eBay echte Nutzungsgebühren verursacht) - der
// tatsächliche Preis (mit Aufschlag auf unsere Amazon-Kosten) wird als
// Stripe-Preis im Dashboard angelegt, sobald die Kosten bekannt sind, und
// hier nur als Env-Var referenziert - kein Betrag im Code.
const STRIPE_PRICE_AMAZON_ADDON = 'STRIPE_PRICE_AMAZON_ADDON';

// GPSR-Verantwortliche Person (Villa Elegance SRL) - 99 €/Jahr, separat
// zugekauft für Kunden, die sie nicht schon über ihren Plan inklusive
// haben (Bestseller jährlich, Enterprise - siehe hasGpsrAccess() in
// config/plans.js).
const STRIPE_PRICE_GPSR_ADDON = 'STRIPE_PRICE_GPSR_ADDON';

// ============================================================
// ÖFFENTLICHE PREISE (für die Preisanzeige auf der Landingpage)
// ============================================================
// Zeigt dieselbe Währung, die Stripe Checkout dem Kunden anhand seiner
// IP-Adresse ohnehin automatisch anzeigen würde (siehe currency_options
// pro Preis im Stripe-Dashboard) - so stimmt der auf der Landingpage
// angezeigte Preis mit dem später an der Kasse berechneten überein.
// Kein Login nötig, da diese Daten ohnehin öffentlich auf der Preisseite
// stehen. Kurzes In-Memory-Caching pro Währung, um nicht bei jedem
// Seitenaufruf mehrere Stripe-API-Aufrufe auszulösen.
const publicPriceCache = {};
const PUBLIC_PRICE_CACHE_MS = 10 * 60 * 1000;

async function getPublicPrices(currency) {
  const cached = publicPriceCache[currency];
  if (cached && Date.now() - cached.at < PUBLIC_PRICE_CACHE_MS) return cached.data;

  const result = { currency, plans: {} };
  for (const [interval, plans] of Object.entries(STRIPE_PRICE_IDS)) {
    for (const [plan, envName] of Object.entries(plans)) {
      const priceId = process.env[envName];
      if (!priceId) continue;
      try {
        const price = await stripe.prices.retrieve(priceId, { expand: ['currency_options'] });
        const lower = currency.toLowerCase();
        const opt = price.currency_options && price.currency_options[lower];
        const amount = opt ? opt.unit_amount : price.unit_amount;
        const actualCurrency = opt ? currency : price.currency.toUpperCase();
        if (!result.plans[plan]) result.plans[plan] = {};
        result.plans[plan][interval] = { amount: (amount || 0) / 100, currency: actualCurrency };
      } catch (err) {
        console.error(`❌ Öffentlicher Preis ${envName} konnte nicht geladen werden:`, err.message);
      }
    }
  }

  publicPriceCache[currency] = { data: result, at: Date.now() };
  return result;
}

router.get('/public-prices', async (req, res) => {
  const currency = (req.query.currency || 'EUR').toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: 'Ungültige Währung.' });
  }
  try {
    const prices = await getPublicPrices(currency);
    res.json(prices);
  } catch (err) {
    console.error('❌ /public-prices Fehler:', err.message);
    res.status(503).json({ error: 'Preise gerade nicht verfügbar.' });
  }
});

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const interval = req.body.interval === 'annual' ? 'annual' : 'monthly';

  const envVarName = (STRIPE_PRICE_IDS[interval] || STRIPE_PRICE_IDS.monthly)[plan] || STRIPE_PRICE_IDS.monthly.M;
  const priceId = process.env[envVarName];

  if (!priceId) {
    return res.status(400).json({
      error: interval === 'annual'
        ? 'Die Jahreszahlung für diesen Plan ist noch nicht konfiguriert.'
        : 'Für diesen Plan ist kein Preis konfiguriert.'
    });
  }

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
    // Zeigt an der Kasse ein Gutschein-/Rabattcode-Feld an - ohne das gibt
    // es aktuell KEINEN Weg, einen Code (z.B. für eine Reel-Aktion)
    // einzulösen. Der Code selbst wird als Promotion Code im Stripe-
    // Dashboard angelegt, nicht im Code hinterlegt.
    allow_promotion_codes: true,
    success_url: `${process.env.APP_URL}/Dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/index.html`,
    metadata: {
      user_id: customer.id,
      plan: plan,
      interval: interval,
      type: 'plan_upgrade'
    }
  });

  // Für den Checkout-Funnel im Admin-Dashboard (siehe GET
  // /admin/checkout-funnel): beantwortet "wie viele registrierte Kunden
  // erreichen die Stripe-Kasse und brechen DORT ab" statt das nur zu
  // vermuten. Der Webhook unten markiert die Zeile bei erfolgreicher
  // Zahlung als 'completed'.
  try {
    db.prepare(`
      INSERT INTO checkout_sessions (stripe_session_id, customer_id, plan, interval, origin_country, is_eu, status)
      VALUES (?, ?, ?, ?, ?, ?, 'created')
    `).run(session.id, customer.id, plan, interval, customer.origin_country, customer.is_eu ? 1 : 0);
  } catch (err) {
    console.error('❌ Checkout-Session-Tracking-Fehler:', err.message);
  }

  res.json({ url: session.url });
});

// ============================================================
// STRIPE CUSTOMER PORTAL (Abo verwalten / kündigen / Plan wechseln)
// ============================================================
// Bisher gab es dafür KEINE Selbstbedienung im Dashboard, obwohl sowohl
// die Landingpage ("🔄 Monatlich kündbar") als auch der FAQ-Chat
// (routes/support.js, FAQ-Eintrag 'cancellation'/'plan_comparison')
// bereits behaupten, das ginge "direkt in den Kontoeinstellungen" -
// dieser Endpoint macht diese Behauptung erst wahr, statt dass Kunden
// dafür den Support kontaktieren müssen. Nutzt Stripes gehostetes
// Customer Portal (muss einmalig im Stripe-Dashboard aktiviert werden,
// siehe https://dashboard.stripe.com/settings/billing/portal) statt
// eine eigene Kündigungs-/Plan-Wechsel-UI nachzubauen.
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.sub);
    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });
    if (!customer.stripe_customer_id) {
      return res.status(400).json({ error: 'Für dieses Konto liegt noch keine Zahlungshistorie bei Stripe vor.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: `${process.env.APP_URL}/dashboard.html`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe-Portal-Fehler:', error.message);
    res.status(500).json({ error: 'Kontoverwaltung konnte nicht geöffnet werden.' });
  }
});

// ============================================================
// PREMIUM-UPGRADE ZAHLUNG (149 € pro Land)
// ============================================================
router.post('/create-upgrade-session', requireAuth, async (req, res) => {
  const { country, price, type } = req.body;
  const customerId = req.customer.sub;

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

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
        unit_amount: price * 100,
      },
      quantity: 1,
    }],
    success_url: `${process.env.APP_URL}/Dashboard.html?upgrade=success&country=${country}`,
    cancel_url: `${process.env.APP_URL}/Dashboard.html?upgrade=cancel`,
    metadata: {
      user_id: customerId,
      country: country,
      type: type || 'premium_upgrade'
    }
  });

  // Siehe Kommentar bei /create-checkout-session: dieselbe Sichtbarkeit
  // im Checkout-Funnel, die bisher nur der Haupt-Abo-Kasse vorbehalten war.
  try {
    db.prepare(`
      INSERT INTO checkout_sessions (stripe_session_id, customer_id, origin_country, is_eu, type, status)
      VALUES (?, ?, ?, ?, ?, 'created')
    `).run(session.id, customer.id, customer.origin_country, customer.is_eu ? 1 : 0, type || 'premium_upgrade');
  } catch (err) {
    console.error('❌ Checkout-Session-Tracking-Fehler:', err.message);
  }

  res.json({ url: session.url });
});

// ============================================================
// AMAZON-ZUSATZMODUL BUCHEN (kostenpflichtiges Abo-Add-on)
// ============================================================
router.post('/create-amazon-addon-session', requireAuth, async (req, res) => {
  const priceId = process.env[STRIPE_PRICE_AMAZON_ADDON];

  if (!priceId) {
    return res.status(400).json({
      error: 'Das Amazon-Zusatzmodul ist noch nicht buchbar - der Preis wird gerade hinterlegt.'
    });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.sub);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  if (customer.amazon_addon_active) {
    return res.status(400).json({ error: 'Das Amazon-Zusatzmodul ist bereits gebucht.' });
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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/Dashboard.html?amazon_addon=success`,
    cancel_url: `${process.env.APP_URL}/Dashboard.html?amazon_addon=cancel`,
    metadata: {
      user_id: customer.id,
      type: 'amazon_addon_purchase'
    }
  });

  // Siehe Kommentar bei /create-checkout-session: dieselbe Sichtbarkeit
  // im Checkout-Funnel, die bisher nur der Haupt-Abo-Kasse vorbehalten war.
  try {
    db.prepare(`
      INSERT INTO checkout_sessions (stripe_session_id, customer_id, origin_country, is_eu, type, status)
      VALUES (?, ?, ?, ?, 'amazon_addon_purchase', 'created')
    `).run(session.id, customer.id, customer.origin_country, customer.is_eu ? 1 : 0);
  } catch (err) {
    console.error('❌ Checkout-Session-Tracking-Fehler:', err.message);
  }

  res.json({ url: session.url });
});

// ============================================================
// GPSR-VERANTWORTLICHE PERSON BUCHEN (kostenpflichtiges Abo-Add-on)
// ============================================================
router.post('/create-gpsr-addon-session', requireAuth, async (req, res) => {
  const priceId = process.env[STRIPE_PRICE_GPSR_ADDON];

  if (!priceId) {
    return res.status(400).json({
      error: 'Die GPSR-Verantwortliche Person ist noch nicht buchbar - der Preis wird gerade hinterlegt.'
    });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.sub);
  if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

  if (hasGpsrAccess(customer)) {
    return res.status(400).json({ error: 'Die GPSR-Verantwortliche Person ist bereits gebucht bzw. in deinem Plan inklusive.' });
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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/Dashboard.html?gpsr_addon=success`,
    cancel_url: `${process.env.APP_URL}/Dashboard.html?gpsr_addon=cancel`,
    metadata: {
      user_id: customer.id,
      type: 'gpsr_addon_purchase'
    }
  });

  // Siehe Kommentar bei /create-checkout-session: dieselbe Sichtbarkeit
  // im Checkout-Funnel, die bisher nur der Haupt-Abo-Kasse vorbehalten war.
  try {
    db.prepare(`
      INSERT INTO checkout_sessions (stripe_session_id, customer_id, origin_country, is_eu, type, status)
      VALUES (?, ?, ?, ?, 'gpsr_addon_purchase', 'created')
    `).run(session.id, customer.id, customer.origin_country, customer.is_eu ? 1 : 0);
  } catch (err) {
    console.error('❌ Checkout-Session-Tracking-Fehler:', err.message);
  }

  res.json({ url: session.url });
});

// ============================================================
// ⭐ STRIPE WEBHOOK (MIT LAPPA-PLATZHALTER)
// ============================================================
router.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = req.body.toString();
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook-Signaturfehler: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, country, type, plan, interval } = session.metadata || {};

    console.log(`✅ Zahlung erfolgreich: User ${user_id}, Land ${country}, Typ ${type}, Plan ${plan}, Intervall ${interval}`);

    // Gilt für JEDE erfolgreich abgeschlossene Checkout-Session, unabhängig
    // vom Typ (plan_upgrade/premium_upgrade/amazon_addon_purchase) - vorher
    // stand das nur im plan_upgrade-Zweig, wodurch Premium-Länder- und
    // Amazon-Add-on-Käufe im Checkout-Funnel für immer als "created"
    // (=abgebrochen) stehen blieben, obwohl bezahlt wurde.
    try {
      db.prepare(`
        UPDATE checkout_sessions SET status = 'completed', completed_at = datetime('now')
        WHERE stripe_session_id = ?
      `).run(session.id);
    } catch (err) {
      console.error('❌ Checkout-Session-Tracking-Fehler (completed):', err.message);
    }

    try {
      // ⭐ Fall 1: Premium-Upgrade für ein Land
      if (type === 'premium_upgrade' || type === 'representative_booking') {
        if (country && user_id) {
          // 1. Datenbank updaten
          db.prepare(`
            UPDATE activations 
            SET mode = 'premium', mode_updated_at = datetime('now')
            WHERE customer_id = ? AND country_code = ?
          `).run(parseInt(user_id), country);
          console.log(`✅ Premium-Modus für ${country} aktiviert (User ${user_id})`);

          // ⭐ 2. LAPPA-API AUFRUFEN (Platzhalter)
          await registerRepresentativeWithLappa(parseInt(user_id), country);
        }
      }

      // ⭐ Fall 2: Plan-Upgrade (oder Erstbuchung direkt bei der Registrierung)
      // - schaltet die eigentliche Produktnutzung erst nach echter Zahlung
      // frei (siehe requireActiveSubscription in middleware/auth.js).
      if (type === 'plan_upgrade' && plan && user_id) {
        db.prepare(`
          UPDATE customers
          SET plan = ?, billing_interval = ?, subscription_status = 'active', stripe_subscription_id = ?, cancelled_at = NULL
          WHERE id = ?
        `).run(plan, interval === 'annual' ? 'annual' : 'monthly', session.subscription || null, parseInt(user_id));
        console.log(`✅ Plan auf ${plan} geupgradet und aktiviert (User ${user_id})`);
      }

      // ⭐ Fall 3: Amazon-Zusatzmodul gebucht
      if (type === 'amazon_addon_purchase' && user_id) {
        db.prepare(`
          UPDATE customers
          SET amazon_addon_active = 1, amazon_addon_subscription_id = ?
          WHERE id = ?
        `).run(session.subscription || null, parseInt(user_id));
        console.log(`✅ Amazon-Zusatzmodul aktiviert (User ${user_id})`);
      }

      // ⭐ Fall 4: GPSR-Verantwortliche Person zugebucht
      if (type === 'gpsr_addon_purchase' && user_id) {
        db.prepare(`
          UPDATE customers
          SET gpsr_addon_active = 1, gpsr_addon_subscription_id = ?
          WHERE id = ?
        `).run(session.subscription || null, parseInt(user_id));
        console.log(`✅ GPSR-Verantwortliche Person aktiviert (User ${user_id})`);
        syncGpsrAssignment(parseInt(user_id));
      }

      // Plan-Upgrade kann GPSR-Zugriff auch planbasiert auslösen (Bestseller
      // jährlich/Enterprise, siehe hasGpsrAccess()) - unabhängig vom
      // zugekauften Add-on oben, deshalb hier nach JEDEM Plan-Upgrade prüfen.
      if (type === 'plan_upgrade' && user_id) {
        syncGpsrAssignment(parseInt(user_id));
      }

    } catch (err) {
      console.error('❌ Fehler beim DB-Update:', err);
    }
  }

  // Abo gekündigt oder Zahlung endgültig fehlgeschlagen -> Zugang wieder
  // sperren. Trifft entweder das Haupt-Abo (Plan, siehe
  // requireActiveSubscription) oder das Amazon-Zusatzmodul - je nachdem,
  // welche subscription_id in der Kunden-Zeile hinterlegt ist.
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    try {
      db.prepare(`
        UPDATE customers
        SET subscription_status = 'inactive', cancelled_at = datetime('now')
        WHERE stripe_subscription_id = ?
      `).run(subscription.id);

      db.prepare(`
        UPDATE customers
        SET amazon_addon_active = 0
        WHERE amazon_addon_subscription_id = ?
      `).run(subscription.id);

      const gpsrCustomer = db.prepare(`
        SELECT id FROM customers WHERE gpsr_addon_subscription_id = ?
      `).get(subscription.id);
      if (gpsrCustomer) {
        db.prepare(`
          UPDATE customers SET gpsr_addon_active = 0 WHERE id = ?
        `).run(gpsrCustomer.id);
        syncGpsrAssignment(gpsrCustomer.id);
      }
    } catch (err) {
      console.error('❌ Fehler beim Deaktivieren des Abos:', err);
    }
  }

  res.json({ received: true });
});

// ============================================================
// VILLA ELEGANCE (GPSR-Verantwortliche Person) IM PORTAL SICHTBAR HALTEN
//
// Reuse der bestehenden representative_customer_assignments-Tabelle statt
// einer eigenen Struktur - Villa Elegance ist einfach ein weiterer
// Bevollmächtigter mit stream='gpsr' (siehe routes/representatives.js
// GET /customers, das funktioniert unverändert). Läuft nach jedem
// Add-on-Kauf UND nach jedem Plan-Upgrade, weil Zugriff sich sowohl aus
// dem zugekauften Add-on als auch aus dem Plan ergeben kann (siehe
// hasGpsrAccess()). assigned_by='gpsr_auto' markiert diese Zeilen als
// automatisch gesetzt, damit sie sich von admin-gesetzten Zuweisungen
// unterscheiden lassen und beim Entzug gezielt wieder entfernt werden
// können, ohne eine manuelle Admin-Zuweisung zu löschen.
function syncGpsrAssignment(customerId) {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return;

    const villaElegance = db.prepare(`
      SELECT id FROM representatives WHERE stream = 'gpsr' AND active = 1
      ORDER BY id LIMIT 1
    `).get();
    if (!villaElegance) {
      // Kunde hat GPSR-Zugriff (bezahlt oder planbasiert inklusive), aber es
      // ist noch kein Bevollmächtigter mit stream='gpsr' angelegt - ohne
      // diesen Log-Hinweis bliebe das bisher komplett unbemerkt, bis ein
      // Kunde sich meldet, weil er nie Kontaktdaten bekommt.
      if (hasGpsrAccess(customer)) {
        console.error(`❌ GPSR: Kunde ${customerId} hat Zugriff, aber es ist noch keine "Villa Elegance SRL" (Bevollmächtigter mit stream='gpsr') im Admin-Bereich angelegt - Kunde bekommt keine Kontaktdaten!`);
      }
      return;
    }

    if (hasGpsrAccess(customer)) {
      db.prepare(`
        INSERT OR IGNORE INTO representative_customer_assignments (representative_id, customer_id, assigned_by)
        VALUES (?, ?, 'gpsr_auto')
      `).run(villaElegance.id, customerId);
    } else {
      db.prepare(`
        DELETE FROM representative_customer_assignments
        WHERE representative_id = ? AND customer_id = ? AND assigned_by = 'gpsr_auto'
      `).run(villaElegance.id, customerId);
    }
  } catch (err) {
    console.error('❌ GPSR-Zuweisungs-Sync-Fehler:', err.message);
  }
}

// ============================================================
// ⭐ LAPPA-API PLATZHALTER (MORGEN IMPLEMENTIEREN)
// ============================================================
async function registerRepresentativeWithLappa(userId, countryCode) {
  console.log(`📞 LAPPA-API AUFRUF: User ${userId}, Land ${countryCode}`);
  
  try {
    // ⭐ MORGEN HIER DIE ECHTE LAPPA-API IMPLEMENTIEREN
    // const response = await fetch('https://api.lappa.io/v1/representatives', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${process.env.LAPPA_API_KEY}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     customerId: userId,
    //     countryCode: countryCode,
    //     // Weitere Felder laut Lappa-Dokumentation
    //   })
    // });
    // const data = await response.json();
    // 
    // // Lappa-Response in der DB speichern
    // db.prepare(`
    //   UPDATE activations 
    //   SET provider_id = ?, provider_status = 'registered', provider_data = ?
    //   WHERE customer_id = ? AND country_code = ?
    // `).run(data.representativeId, JSON.stringify(data), userId, countryCode);
    
    // console.log(`✅ Lappa-Registrierung für ${countryCode} erfolgreich`);

    // ⭐ PLATZHALTER: Nur Log-Ausgabe
    console.log(`ℹ️ LAPPA-API (Platzhalter): Registrierung für ${countryCode} würde jetzt erfolgen.`);
    
    // Simuliere erfolgreiche Registrierung
    return { success: true, representativeId: 'lappa_placeholder_' + Date.now() };
    
  } catch (error) {
    console.error(`❌ Fehler bei Lappa-API:`, error.message);
    // ⭐ WICHTIG: Fehler nur loggen – mode bleibt auf premium!
    // Der Händler hat bezahlt, die Registrierung wird später nachgeholt
    return { success: false, error: error.message };
  }
}

// ============================================================
// ABO-STATUS
// ============================================================
router.get('/status', requireAuth, (req, res) => {
  const customer = db.prepare('SELECT plan, subscription_status FROM customers WHERE id = ?').get(req.customer.sub);
  res.json(customer || { plan: 'M', subscription_status: 'inactive' });
});

module.exports = router
