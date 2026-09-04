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
const ALLOWED_EVENTS = ['demo_start', 'calculator_click', 'demo_duration'];

// Obergrenze für event_value bei 'demo_duration' - 4 Stunden. Verhindert
// offensichtlich manipulierte/kaputte Werte, ohne echte lange Demo-
// Sessions abzuschneiden.
const MAX_DEMO_DURATION_SECONDS = 4 * 60 * 60;

router.post('/event', trackLimiter, (req, res) => {
  try {
    const { event_name, session_id, event_value } = req.body || {};
    if (!ALLOWED_EVENTS.includes(event_name) || !session_id) {
      return res.status(400).json({ error: 'Ungültiges Event.' });
    }

    let value = null;
    if (event_name === 'demo_duration') {
      const parsed = Number(event_value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_DEMO_DURATION_SECONDS) {
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
    const { path, referrer, utm_source, utm_medium, utm_campaign, session_id } = req.body || {};

    db.prepare(`
      INSERT INTO page_views (path, referrer, utm_source, utm_medium, utm_campaign, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(path || '/').slice(0, 500),
      referrer ? String(referrer).slice(0, 500) : null,
      utm_source ? String(utm_source).slice(0, 100) : null,
      utm_medium ? String(utm_medium).slice(0, 100) : null,
      utm_campaign ? String(utm_campaign).slice(0, 100) : null,
      session_id ? String(session_id).slice(0, 100) : null
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
