// routes/track.js
//
// Anonymes Traffic-Tracking für das interne Vertriebs-/Marketing-Tool
// (siehe routes/admin.js). Bewusst OHNE Auth (wird von der öffentlichen
// Landing Page aufgerufen) und OHNE personenbezogene Daten (keine IP-
// Speicherung, nur Pfad/Referrer/UTM-Parameter + eine anonyme, clientseitig
// generierte Session-ID) - daher technisch notwendig im Sinne des
// Cookie-Hinweises, keine Einwilligung nötig.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');

const router = express.Router();

// Großzügig, aber verhindert Missbrauch als Free-Text-Spam-Endpunkt.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen.' }
});

// Bewusst eine feste Whitelist statt beliebiger Event-Namen - sonst
// wird der Endpoint zu einem Free-Text-Spam-Ziel wie der Pageview-
// Endpunkt oben schon kommentiert. 'demo_duration' trägt zusätzlich
// einen numerischen Sekundenwert (siehe event_value unten).
// 'demo_cta_click' = Klick auf "Jetzt kostenpflichtig starten" INNERHALB
// der Demo (siehe dashboard.html, exitDemoToSignup()) - deutlich
// stärkeres Kaufsignal als nur 'demo_start' (Demo geöffnet), analog zu
// 'calculator_click' vs. der calculator_usage-Tabelle beim Rechner.
// 'weeebat_cta_click'/'weeebat_demo_click' = Klicks auf die beiden CTAs
// in der WEEE/Batterie-Sektion der Landingpage (index.html) - eigene
// Events statt Wiederverwendung von 'demo_start', damit sich dieser
// Einstiegspunkt getrennt von Hero-Demo/Rechner auswerten lässt (siehe
// GET /admin/funnel-attribution -> weeeBatterySectionFunnel).
// 'landing_duration' = Verweildauer auf der Landingpage selbst (siehe
// index.html, sendLandingDuration()) - trägt wie 'demo_duration' einen
// numerischen Sekundenwert. 'view_*' = IntersectionObserver-Events pro
// Sektion der Landingpage (siehe initSectionViewTracking() in index.html) -
// zusammen beantworten beide "was passiert in den paar Sekunden, bevor
// jemand wieder geht" (siehe GET /admin/landing-engagement).
// 'usp_cta_click' = Klick auf "Jetzt loslegen" INNERHALB der USP-Sektion
// (siehe index.html) - eigenes Event statt Wiederverwendung, damit sich
// dieser Einstiegspunkt getrennt auswerten lässt (siehe GET
// /admin/conversion-insights).
// 'hero_price_badge_click'/'hero_weeebat_badge_click' = Klicks auf die
// beiden klickbaren Hero-Badges (springen zu #pricing bzw.
// #section-weeebat, wie ein Menüpunkt) - eigene Events aus demselben
// Grund wie oben. 'nav_about_click'/'nav_faq_click' = Klicks auf die
// neuen Kopfzeilen-Menüpunkte "Über uns"/"FAQ" (reine Sprungmarken-
// Links, aber trotzdem getrackt, damit sichtbar ist, ob die Navigation
// tatsächlich genutzt wird statt nur natürlich gescrollt - siehe
// GET /admin/landing-engagement -> navClicks).
// 'gpsr_cta_click' = Klick auf den GPSR-Info-Button bei Pricing (öffnet
// das Info-Popup zur Verantwortlichen Person) - gleiches Muster wie die
// Nav-Klicks oben, landet ebenfalls in navClicks.
const ALLOWED_EVENTS = [
  'demo_start', 'calculator_click', 'demo_duration', 'demo_cta_click',
  'weeebat_cta_click', 'weeebat_demo_click', 'landing_duration', 'usp_cta_click',
  'hero_price_badge_click', 'hero_weeebat_badge_click', 'nav_about_click', 'nav_faq_click',
  'gpsr_cta_click',
  'view_hero', 'view_pain_point', 'view_how_it_works', 'view_weeebat', 'view_about',
  'view_usp', 'view_faq', 'view_pricing', 'view_final_cta',
  // Feuert direkt beim Klick auf einen Zahlungs-Button, BEVOR der
  // API-Aufruf zu Stripe überhaupt startet - schließt die Lücke zwischen
  // "Button geklickt" und "checkout_sessions-Zeile existiert" (siehe
  // routes/billing.js). Ohne das wäre ein JS-Fehler oder ein 500er beim
  // Erstellen der Stripe-Session komplett unsichtbar: keine Zeile in
  // checkout_sessions, aber auch kein Hinweis, dass überhaupt geklickt wurde.
  'checkout_button_click'
];

// Obergrenze für event_value bei 'demo_duration' - 4 Stunden. Verhindert
// offensichtlich manipulierte/kaputte Werte, ohne echte lange Demo-
// Sessions abzuschneiden.
const MAX_DEMO_DURATION_SECONDS = 4 * 60 * 60;

// Obergrenze für 'landing_duration' - 30 Minuten. Ein im Hintergrund
// offen gelassener Tab würde sonst die Verweildauer-Auswertung völlig
// verzerren; echtes Lesen/Stöbern auf der Landingpage passt locker
// darunter.
const MAX_LANDING_DURATION_SECONDS = 30 * 60;

router.post('/event', trackLimiter, (req, res) => {
  try {
    const { event_name, session_id, event_value } = req.body || {};
    if (!ALLOWED_EVENTS.includes(event_name) || !session_id) {
      return res.status(400).json({ error: 'Ungültiges Event.' });
    }

    let value = null;
    if (event_name === 'demo_duration' || event_name === 'landing_duration') {
      const max = event_name === 'demo_duration' ? MAX_DEMO_DURATION_SECONDS : MAX_LANDING_DURATION_SECONDS;
      const parsed = Number(event_value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
        return res.status(400).json({ error: 'Ungültiger event_value.' });
      }
      value = Math.round(parsed);
    }

    db.prepare(`
      INSERT INTO click_events (event_name, session_id, event_value)
      VALUES (?, ?, ?)
    `).run(event_name, String(session_id).slice(0, 100), value);

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Event-Tracking-Fehler:', error.message);
    res.json({ ok: false });
  }
});

// Anonyme Rechner-Nutzung: wird beim Klick auf "Berechnen" im Eco-Fee-
// Rechner der Landing Page gesendet (siehe index.html, calcCompute()/
// heroCalcCompute()). Bewusst eigener Endpoint statt /event, weil hier
// strukturierte Daten statt nur ein Event-Name reinkommen.
router.post('/calculator-usage', trackLimiter, (req, res) => {
  try {
    const { session_id, countries, total_kg, plan, savings } = req.body || {};

    if (!session_id || !Array.isArray(countries) || countries.length === 0) {
      return res.status(400).json({ error: 'Ungültige Rechner-Daten.' });
    }

    const cleanCountries = countries
      .filter(c => typeof c === 'string')
      .map(c => c.slice(0, 10).toUpperCase())
      .slice(0, 10);
    if (cleanCountries.length === 0) {
      return res.status(400).json({ error: 'Ungültige Rechner-Daten.' });
    }

    const kg = Number(total_kg);
    if (!Number.isFinite(kg) || kg < 0 || kg > 100_000_000) {
      return res.status(400).json({ error: 'Ungültige kg-Menge.' });
    }

    const savingsNum = Number(savings);

    db.prepare(`
      INSERT INTO calculator_usage (session_id, countries_json, country_count, total_kg, plan, savings)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(session_id).slice(0, 100),
      JSON.stringify(cleanCountries),
      cleanCountries.length,
      kg,
      typeof plan === 'string' ? plan.slice(0, 10) : null,
      Number.isFinite(savingsNum) ? savingsNum : null
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Rechner-Tracking-Fehler:', error.message);
    res.json({ ok: false });
  }
});

router.post('/pageview', trackLimiter, (req, res) => {
  try {
    const { path, referrer, utm_source, utm_medium, utm_campaign, session_id, country } = req.body || {};

    // Strenges Format statt Freitext (Whitelist-Prinzip wie bei den
    // Events oben) - nur ein zweistelliger ISO-Ländercode wird
    // übernommen, alles andere landet als NULL statt als Rohtext.
    const cleanCountry = typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)
      ? country.toUpperCase()
      : null;

    db.prepare(`
      INSERT INTO page_views (path, referrer, utm_source, utm_medium, utm_campaign, session_id, country)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(path || '/').slice(0, 500),
      referrer ? String(referrer).slice(0, 500) : null,
      utm_source ? String(utm_source).slice(0, 100) : null,
      utm_medium ? String(utm_medium).slice(0, 100) : null,
      utm_campaign ? String(utm_campaign).slice(0, 100) : null,
      session_id ? String(session_id).slice(0, 100) : null,
      cleanCountry
    );

    res.json({ ok: true });
  } catch (error) {
    // Tracking darf niemals einen sichtbaren Fehler für echte Besucher
    // verursachen - im Zweifel einfach stumm bleiben.
    console.error('❌ Tracking-Fehler:', error.message);
    res.json({ ok: false });
  }
});

module.exports = router;
