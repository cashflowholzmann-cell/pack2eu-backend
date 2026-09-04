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
// Endpunkt oben schon kommentiert. Nur die zwei Events, die für die
// Funnel-Auswertung im internen Tool tatsächlich gebraucht werden.
const ALLOWED_EVENTS = ['demo_start', 'calculator_click'];

router.post('/event', trackLimiter, (req, res) => {
  try {
    const { event_name, session_id } = req.body || {};
    if (!ALLOWED_EVENTS.includes(event_name) || !session_id) {
      return res.status(400).json({ error: 'Ungültiges Event.' });
    }

    db.prepare(`
      INSERT INTO click_events (event_name, session_id)
      VALUES (?, ?)
    `).run(event_name, String(session_id).slice(0, 100));

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Event-Tracking-Fehler:', error.message);
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
