// routes/admin.js
//
// Internes Vertriebs-/Marketing-Tool: Traffic-Übersicht (woher kommen die
// Besucher), Leads (auch Telefon-Interessenten, die nie ein Formular
// ausfüllen) und einfache Aufgabenverwaltung - alles an einem Ort.
//
// Eigenes, einfaches Admin-Login statt eines vollen Rollensystems: ein
// gemeinsames Passwort aus der Env-Var ADMIN_PASSWORD. Reicht für ein
// One-Person/Kleinteam-Tool; kein Ersatz für echtes Nutzer-Management,
// falls mehrere Personen mit unterschiedlichen Rechten dazukommen.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
// zodOutputFormat() liest Schemas über die zod/v4-Introspection - siehe
// die Erklärung in routes/feedback.js.
const { z } = require('zod/v4');
const { db, DB_PATH } = require('../db');
const { signToken, requireAuth, requireAdmin } = require('../middleware/auth');
const { sendRepresentativeInviteEmail } = require('../lib/email');

const router = express.Router();

// Nur auf /login - der Rest des Routers braucht viele Anfragen für
// normale Nutzung (Übersicht, Leads, Aufgaben laden/ändern) und darf
// dadurch nicht ausgebremst werden.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});

// ============================================================
// LOGIN
// ============================================================
router.post('/login', adminLoginLimiter, (req, res) => {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) {
    return res.status(503).json({ error: 'Admin-Zugang ist noch nicht eingerichtet (ADMIN_PASSWORD fehlt).' });
  }

  const provided = String(req.body?.password || '');
  const a = Buffer.from(provided.padEnd(configured.length, '\0'));
  const b = Buffer.from(configured.padEnd(provided.length, '\0'));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b) && provided.length === configured.length;

  if (!matches) {
    return res.status(401).json({ error: 'Falsches Passwort.' });
  }

  const token = signToken({ sub: 1, role: 'admin' });
  res.json({ token });
});

router.use(requireAuth, requireAdmin);

// ============================================================
// ÜBERSICHT
// ============================================================
function classifyChannel(row) {
  if (row.utm_source) return row.utm_source.toLowerCase();
  const ref = (row.referrer || '').toLowerCase();
  if (!ref) return 'direkt';
  if (/facebook|instagram|tiktok|linkedin|twitter|x\.com|pinterest/.test(ref)) return 'social_media';
  if (/google|bing|duckduckgo|yahoo/.test(ref)) return 'suchmaschine';
  return 'sonstige_website';
}

router.get('/overview', (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const views30d = db.prepare('SELECT referrer, utm_source, country, created_at FROM page_views WHERE created_at >= ?').all(since30d);
    const viewsByChannel = {};
    views30d.forEach(v => {
      const ch = classifyChannel(v);
      viewsByChannel[ch] = (viewsByChannel[ch] || 0) + 1;
    });

    const viewsLast7d = views30d.filter(v => v.created_at >= since7d).length;

    // Herkunftsland der Besucher (aus der clientseitigen IP-Erkennung,
    // siehe page_views.country) - zeigt, wo tatsächlich Traffic
    // herkommt, damit gezielt in diesen Ländern geworben werden kann.
    const viewsByCountry = {};
    views30d.forEach(v => {
      const c = v.country || 'unbekannt';
      viewsByCountry[c] = (viewsByCountry[c] || 0) + 1;
    });

    // Dieselbe Aufschlüsselung wie oben, aber ohne 30-Tage-Fenster - läuft
    // NEBEN der 30-Tage-Ansicht mit (nicht anstelle), damit ältere Quellen/
    // Länder nicht nach 30 Tagen aus der Statistik verschwinden, sondern
    // dauerhaft sichtbar bleiben.
    const viewsAllTime = db.prepare('SELECT referrer, utm_source, country FROM page_views').all();
    const viewsByChannelAllTime = {};
    const viewsByCountryAllTime = {};
    viewsAllTime.forEach(v => {
      const ch = classifyChannel(v);
      viewsByChannelAllTime[ch] = (viewsByChannelAllTime[ch] || 0) + 1;
      const c = v.country || 'unbekannt';
      viewsByCountryAllTime[c] = (viewsByCountryAllTime[c] || 0) + 1;
    });

    const leadsBySource = db.prepare(`
      SELECT source, COUNT(*) as count FROM leads GROUP BY source
    `).all();

    const leadsByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status
    `).all();

    const customersByAcquisition = db.prepare(`
      SELECT COALESCE(acquisition_source, 'organisch') as source, COUNT(*) as count
      FROM customers GROUP BY COALESCE(acquisition_source, 'organisch')
    `).all();

    // Plan-/Länderverteilung und Churn - wichtig für eine spätere
    // Due-Diligence bei einem Verkauf von Pack2EU, damit ab Tag 1 alles
    // getrackt ist statt erst im Nachhinein rekonstruiert werden zu müssen.
    const customersByPlan = db.prepare(`
      SELECT plan, COUNT(*) as count
      FROM customers WHERE subscription_status = 'active'
      GROUP BY plan
    `).all();

    const churnTotals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE cancelled_at IS NOT NULL) as churnedTotal,
        (SELECT COUNT(*) FROM customers WHERE cancelled_at >= ?) as churned30d,
        (SELECT COUNT(DISTINCT origin_country) FROM customers WHERE subscription_status = 'active') as activeCountries,
        (SELECT COUNT(*) FROM customers WHERE amazon_addon_active = 1) as amazonAddonActive
    `).get(since30d);

    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers) as totalCustomers,
        (SELECT COUNT(*) FROM customers WHERE subscription_status = 'active') as activeCustomers,
        (SELECT COUNT(*) FROM leads WHERE status NOT IN ('converted', 'lost')) as openLeads,
        -- Gleiche effective_status-Ableitung wie TASK_SELECT_SQL weiter unten:
        -- die status-Spalte bleibt bei täglich wiederkehrenden Aufgaben immer
        -- 'open' (last_completed_date trägt den "heute schon erledigt"-Status),
        -- ohne diese CASE-Ableitung hätte der Zähler oben eine heute bereits
        -- erledigte tägliche Aufgabe fälschlich weiter als offen mitgezählt.
        (SELECT COUNT(*) FROM admin_tasks t WHERE
          CASE WHEN t.recurrence = 'daily'
               THEN (CASE WHEN t.last_completed_date = date('now') THEN 'done' ELSE 'open' END)
               ELSE t.status
          END = 'open'
        ) as openTasks,
        (SELECT COUNT(*) FROM page_views WHERE created_at >= ?) as views30d,
        (SELECT COUNT(*) FROM page_views) as viewsTotal
    `).get(since30d);

    const everPaying = totals.activeCustomers + churnTotals.churnedTotal;
    const churnRate = everPaying > 0 ? churnTotals.churnedTotal / everPaying : null;

    res.json({
      totals: { ...totals, viewsLast7d, ...churnTotals, churnRate },
      viewsByChannel,
      viewsByCountry,
      viewsByChannelAllTime,
      viewsByCountryAllTime,
      leadsBySource,
      leadsByStatus,
      customersByAcquisition,
      customersByPlan
    });
  } catch (error) {
    console.error('❌ Admin-Overview-Fehler:', error);
    res.status(500).json({ error: 'Übersicht konnte nicht geladen werden.' });
  }
});

// Rohe Referrer-URLs je Kanal (letzte 30 Tage) - die Übersicht oben
// bucketet nur in Kategorien wie "sonstige_website"; hier lässt sich
// nachschauen, welche konkrete Seite tatsächlich verlinkt hat.
router.get('/traffic-detail', (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const views30d = db.prepare('SELECT referrer, utm_source, created_at FROM page_views WHERE created_at >= ?').all(since30d);

    const byChannel = {};
    views30d.forEach(v => {
      const ch = classifyChannel(v);
      if (!v.referrer) return; // "direkt" hat keinen Referrer zum Anzeigen
      if (!byChannel[ch]) byChannel[ch] = {};
      byChannel[ch][v.referrer] = (byChannel[ch][v.referrer] || 0) + 1;
    });

    const result = {};
    Object.entries(byChannel).forEach(([ch, referrers]) => {
      result[ch] = Object.entries(referrers)
        .map(([referrer, count]) => ({ referrer, count }))
        .sort((a, b) => b.count - a.count);
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Traffic-Detail-Fehler:', error);
    res.status(500).json({ error: 'Details konnten nicht geladen werden.' });
  }
});

// ============================================================
// FUNNEL-ATTRIBUTION: Demo-/Rechner-Klick -> Registrierung -> Kauf
//
// Verknüpft die anonyme Session-ID aus dem Klick-Tracking (click_events,
// siehe routes/track.js) mit der bei der Registrierung gespeicherten
// customers.acquisition_session_id. Ein Kunde wird dem ersten passenden
// Event VOR seiner Registrierung zugeordnet: zuerst "demo" (falls ein
// demo_start-Event existiert), sonst "rechner" (calculator_click), sonst
// "weder". So lässt sich beantworten "X Leute haben den Rechner geklickt,
// davon sind Y zahlende Bestseller-Kunden geworden".
//
// Zusätzlich calculatorFunnel unten: verfeinert die reine Klick-Stufe
// (calculator_click = Modal geöffnet, schwaches Signal) um eine echte
// Abschluss-Stufe (calculator_usage-Zeile = Berechnung mit Ergebnis+CTA
// gesehen, starkes Signal) - damit sich der konkrete Bruch "geöffnet vs.
// abgeschlossen vs. registriert vs. zahlend" im Rechner-Funnel getrennt
// von der Demo-Zuordnung oben auswerten lässt.
// ============================================================
router.get('/funnel-attribution', (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT id, plan, subscription_status, acquisition_session_id, created_at
      FROM customers
      WHERE acquisition_session_id IS NOT NULL
    `).all();

    const events = db.prepare(`
      SELECT event_name, session_id, created_at FROM click_events
    `).all();

    const eventsBySession = {};
    events.forEach(e => {
      if (!eventsBySession[e.session_id]) eventsBySession[e.session_id] = [];
      eventsBySession[e.session_id].push(e);
    });

    function attribute(customer) {
      const sessionEvents = eventsBySession[customer.acquisition_session_id] || [];
      const before = sessionEvents.filter(e => e.created_at <= customer.created_at);
      if (before.some(e => e.event_name === 'demo_start')) return 'demo';
      if (before.some(e => e.event_name === 'calculator_click')) return 'rechner';
      return 'weder';
    }

    const summary = {
      demo: { registered: 0, paying: 0, byPlan: {} },
      rechner: { registered: 0, paying: 0, byPlan: {} },
      weder: { registered: 0, paying: 0, byPlan: {} }
    };

    customers.forEach(c => {
      const bucket = attribute(c);
      summary[bucket].registered++;
      if (c.subscription_status === 'active') {
        summary[bucket].paying++;
        summary[bucket].byPlan[c.plan] = (summary[bucket].byPlan[c.plan] || 0) + 1;
      }
    });

    // Gesamt-Klicks unabhängig davon, ob daraus je eine Registrierung
    // wurde - eindeutige Sessions, kein Zählen von Mehrfachklicks.
    const totalDemoClicks = new Set(events.filter(e => e.event_name === 'demo_start').map(e => e.session_id)).size;
    const totalCalculatorClicks = new Set(events.filter(e => e.event_name === 'calculator_click').map(e => e.session_id)).size;

    // Präziserer Rechner-Funnel: "Modal geöffnet" (calculator_click) ist
    // nur ein schwaches Signal - erst eine tatsächlich abgeschlossene
    // Berechnung (calculator_usage-Zeile, mit sichtbarem Ergebnis + CTA
    // "Jetzt mit {Plan} starten") zeigt echtes Kaufinteresse. Eigene,
    // zusätzliche Stufe zwischen "geöffnet" und "registriert", um genau
    // die Frage "Warum registrieren sich Leute nicht nach dem Rechnen?"
    // beantworten zu können, statt nur zu wissen "X haben den Rechner
    // angeklickt".
    const usageRows = db.prepare(`SELECT session_id, created_at FROM calculator_usage`).all();
    const firstUsageBySession = {};
    usageRows.forEach(u => {
      if (!firstUsageBySession[u.session_id] || u.created_at < firstUsageBySession[u.session_id]) {
        firstUsageBySession[u.session_id] = u.created_at;
      }
    });
    const totalCalculatorCompletions = Object.keys(firstUsageBySession).length;

    let calculatorCompletionsRegistered = 0;
    let calculatorCompletionsPaying = 0;
    customers.forEach(c => {
      const firstUsage = firstUsageBySession[c.acquisition_session_id];
      if (firstUsage && firstUsage <= c.created_at) {
        calculatorCompletionsRegistered++;
        if (c.subscription_status === 'active') calculatorCompletionsPaying++;
      }
    });

    // Analoger Funnel für die Demo: 'demo_start' (Demo geöffnet) ist nur
    // ein schwaches Signal, der Klick auf "Jetzt kostenpflichtig starten"
    // INNERHALB der Demo ('demo_cta_click', siehe dashboard.html
    // exitDemoToSignup()) ist echte Kaufabsicht - eigene, zusätzliche
    // Stufe zwischen "geöffnet" und "registriert", genau wie beim
    // Rechner-Funnel oben.
    const firstCtaClickBySession = {};
    events.filter(e => e.event_name === 'demo_cta_click').forEach(e => {
      if (!firstCtaClickBySession[e.session_id] || e.created_at < firstCtaClickBySession[e.session_id]) {
        firstCtaClickBySession[e.session_id] = e.created_at;
      }
    });
    const totalDemoCtaClicks = Object.keys(firstCtaClickBySession).length;

    let demoCtaClicksRegistered = 0;
    let demoCtaClicksPaying = 0;
    customers.forEach(c => {
      const firstCtaClick = firstCtaClickBySession[c.acquisition_session_id];
      if (firstCtaClick && firstCtaClick <= c.created_at) {
        demoCtaClicksRegistered++;
        if (c.subscription_status === 'active') demoCtaClicksPaying++;
      }
    });

    // WEEE/Batterie-Sektion auf der Landingpage: zwei eigene CTAs
    // ("Jetzt loslegen" -> Onboarding, "Demo starten" -> dieselbe
    // Sandbox-Demo wie der Hero-CTA) mit eigenen Events
    // (weeebat_cta_click/weeebat_demo_click, siehe routes/track.js) -
    // damit sich dieser Einstiegspunkt getrennt von Hero/Rechner/Demo
    // auswerten lässt, nach demselben Muster wie calculatorFunnel/
    // demoFunnel oben (erstes Vorkommen pro Session vs. Registrierung).
    function firstOccurrenceBySession(eventName) {
      const map = {};
      events.filter(e => e.event_name === eventName).forEach(e => {
        if (!map[e.session_id] || e.created_at < map[e.session_id]) map[e.session_id] = e.created_at;
      });
      return map;
    }
    function clicksRegisteredPaying(firstBySession) {
      const clicks = Object.keys(firstBySession).length;
      let registered = 0;
      let paying = 0;
      customers.forEach(c => {
        const first = firstBySession[c.acquisition_session_id];
        if (first && first <= c.created_at) {
          registered++;
          if (c.subscription_status === 'active') paying++;
        }
      });
      return { clicks, registered, paying };
    }

    const weeebatCtaBySession = firstOccurrenceBySession('weeebat_cta_click');
    const weeebatDemoBySession = firstOccurrenceBySession('weeebat_demo_click');

    res.json({
      summary,
      totalDemoClicks,
      totalCalculatorClicks,
      calculatorFunnel: {
        opened: totalCalculatorClicks,
        completed: totalCalculatorCompletions,
        registered: calculatorCompletionsRegistered,
        paying: calculatorCompletionsPaying
      },
      demoFunnel: {
        opened: totalDemoClicks,
        completed: totalDemoCtaClicks,
        registered: demoCtaClicksRegistered,
        paying: demoCtaClicksPaying
      },
      weeeBatterySectionFunnel: {
        cta: clicksRegisteredPaying(weeebatCtaBySession),
        demo: clicksRegisteredPaying(weeebatDemoBySession)
      }
    });
  } catch (error) {
    console.error('❌ Funnel-Attribution-Fehler:', error);
    res.status(500).json({ error: 'Funnel-Auswertung konnte nicht geladen werden.' });
  }
});

// ============================================================
// CHECKOUT-FUNNEL: Wo brechen registrierte Kunden an der Stripe-Kasse ab?
//
// Direkt nach der Registrierung wird der Kunde sofort zu Stripe Checkout
// weitergeleitet (siehe onbSubmit() in index.html) - "registriert" heißt
// also fast immer auch "hat die Kasse erreicht". Der eigentlich
// interessante Bruch liegt DANACH: Kasse erreicht, aber nicht bezahlt.
// checkout_sessions (siehe routes/billing.js) loggt jede erstellte
// Stripe-Checkout-Session und wird vom Webhook bei erfolgreicher Zahlung
// als 'completed' markiert - alles, was 'created' bleibt, ist an der
// Kasse abgebrochen. Aufgeschlüsselt nach Land/EU-Nicht-EU, um z. B. zu
// prüfen, ob Besucher aus fernen Ländern (z. B. Japan) überproportional
// häufig abspringen (Stripe-Vertrauen/Zahlungsmethoden-These).
// ============================================================
router.get('/checkout-funnel', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT origin_country, is_eu, status, type FROM checkout_sessions
    `).all();

    // Zeigt zusätzlich die Stufe VOR "Kasse erreicht": wie oft wurde
    // überhaupt auf einen Zahlungs-Button geklickt (siehe
    // trackCheckoutButtonClick() in dashboard.html/index.html)? Eine
    // deutliche Lücke zwischen diesem Wert und "created" unten bedeutet,
    // dass der Klick zwar ankam, aber das Anlegen der Stripe-Session
    // fehlgeschlagen ist (z. B. JS-Fehler, 500er) - das wäre sonst
    // komplett unsichtbar gewesen.
    const buttonClicks = db.prepare(`
      SELECT COUNT(*) as n FROM click_events WHERE event_name = 'checkout_button_click'
    `).get().n;

    const totals = { buttonClicks, created: rows.length, completed: 0 };
    rows.forEach(r => { if (r.status === 'completed') totals.completed++; });
    totals.abandoned = totals.created - totals.completed;
    totals.completionRate = totals.created > 0 ? totals.completed / totals.created : null;

    function bucket(filterFn) {
      const filtered = rows.filter(filterFn);
      const completed = filtered.filter(r => r.status === 'completed').length;
      return {
        created: filtered.length,
        completed,
        completionRate: filtered.length > 0 ? completed / filtered.length : null
      };
    }

    const byRegion = {
      eu: bucket(r => r.is_eu === 1),
      nonEu: bucket(r => r.is_eu === 0)
    };

    const byCountryMap = {};
    rows.forEach(r => {
      const c = r.origin_country || 'unbekannt';
      if (!byCountryMap[c]) byCountryMap[c] = { country: c, created: 0, completed: 0 };
      byCountryMap[c].created++;
      if (r.status === 'completed') byCountryMap[c].completed++;
    });
    const byCountry = Object.values(byCountryMap)
      .map(c => ({ ...c, completionRate: c.created > 0 ? c.completed / c.created : null }))
      .sort((a, b) => (a.completionRate ?? 1) - (b.completionRate ?? 1) || b.created - a.created);

    // Aufgeschlüsselt nach Kassen-Typ (Haupt-Abo vs. Premium-Länder-Upgrade
    // vs. Amazon-Zusatzmodul) - sonst verwässert z. B. ein abgebrochenes
    // 149€-Länder-Upgrade dieselbe Quote wie ein abgebrochenes Monats-Abo,
    // obwohl das zwei komplett unterschiedliche Kaufentscheidungen sind.
    const byTypeMap = {};
    rows.forEach(r => {
      const t = r.type || 'plan_upgrade';
      if (!byTypeMap[t]) byTypeMap[t] = { type: t, created: 0, completed: 0 };
      byTypeMap[t].created++;
      if (r.status === 'completed') byTypeMap[t].completed++;
    });
    const byType = Object.values(byTypeMap)
      .map(t => ({ ...t, completionRate: t.created > 0 ? t.completed / t.created : null }))
      .sort((a, b) => b.created - a.created);

    res.json({ totals, byRegion, byCountry, byType });
  } catch (error) {
    console.error('❌ Checkout-Funnel-Fehler:', error);
    res.status(500).json({ error: 'Checkout-Funnel konnte nicht geladen werden.' });
  }
});

// ============================================================
// LANDING-ENGAGEMENT: Verweildauer + welche Sektionen sehen Besucher
// tatsächlich, bevor sie wieder abspringen?
//
// 'landing_duration' (Sekunden bis Tab-Wechsel/Schließen) und 'view_*'
// (IntersectionObserver pro Sektion, je einmal pro Seitenaufruf) kommen
// beide aus index.html (siehe initLandingDurationTracking()/
// initSectionViewTracking() dort). Das Herkunftsland pro Session wird
// aus der ERSTEN page_views-Zeile dieser Session übernommen (dieselbe
// clientseitige IP-Erkennung, die auch Sprache/Preis vorschlägt) - so
// lässt sich z. B. prüfen, ob Besucher aus fernen Ländern (z. B. Japan)
// deutlich kürzer bleiben als aus Deutschland.
// ============================================================
router.get('/landing-engagement', (req, res) => {
  try {
    const pageviews = db.prepare(`SELECT session_id, country, created_at FROM page_views ORDER BY created_at ASC`).all();
    const countryBySession = {};
    pageviews.forEach(v => {
      if (!countryBySession[v.session_id]) countryBySession[v.session_id] = v.country || 'unbekannt';
    });
    const totalSessions = Object.keys(countryBySession).length;

    function stats(values) {
      if (values.length === 0) return { n: 0, avgSeconds: null, medianSeconds: null };
      const sorted = [...values].sort((a, b) => a - b);
      const avgSeconds = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      const mid = Math.floor(sorted.length / 2);
      const medianSeconds = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
      return { n: sorted.length, avgSeconds, medianSeconds };
    }

    const durationRows = db.prepare(`
      SELECT session_id, event_value FROM click_events
      WHERE event_name = 'landing_duration' AND event_value IS NOT NULL
    `).all();

    const totals = stats(durationRows.map(r => r.event_value));

    const byCountryValues = {};
    durationRows.forEach(r => {
      const c = countryBySession[r.session_id] || 'unbekannt';
      if (!byCountryValues[c]) byCountryValues[c] = [];
      byCountryValues[c].push(r.event_value);
    });
    const byCountry = Object.entries(byCountryValues)
      .map(([country, values]) => ({ country, ...stats(values) }))
      .sort((a, b) => b.n - a.n);

    // Wie viele EINDEUTIGE Sessions haben jede Sektion gesehen, im
    // Verhältnis zu allen getrackten Sessions (= alle mit mind. einem
    // Pageview) - ergibt einen groben "wie weit kommen Besucher"-Funnel.
    const sectionOrder = ['view_hero', 'view_pain_point', 'view_how_it_works', 'view_weeebat', 'view_about', 'view_usp', 'view_faq', 'view_pricing', 'view_final_cta'];
    const placeholders = sectionOrder.map(() => '?').join(',');
    const sectionEvents = db.prepare(`
      SELECT event_name, session_id FROM click_events WHERE event_name IN (${placeholders})
    `).all(...sectionOrder);
    const sectionSessionSets = {};
    sectionEvents.forEach(e => {
      if (!sectionSessionSets[e.event_name]) sectionSessionSets[e.event_name] = new Set();
      sectionSessionSets[e.event_name].add(e.session_id);
    });
    const sectionReach = sectionOrder.map(name => {
      const sessions = sectionSessionSets[name] ? sectionSessionSets[name].size : 0;
      return { section: name, sessions, pct: totalSessions > 0 ? sessions / totalSessions : null };
    });

    // Klickbare Hero-Badges + neue Kopfzeilen-Menüpunkte (Über uns/FAQ) -
    // eindeutige Sessions pro Klick-Ziel, gleiches Muster wie sectionReach
    // oben, nur für aktive Klicks statt reinem Sichtbar-Werden.
    const navClickOrder = ['hero_price_badge_click', 'hero_weeebat_badge_click', 'nav_about_click', 'nav_faq_click'];
    const navPlaceholders = navClickOrder.map(() => '?').join(',');
    const navClickEvents = db.prepare(`
      SELECT event_name, session_id FROM click_events WHERE event_name IN (${navPlaceholders})
    `).all(...navClickOrder);
    const navClickSessionSets = {};
    navClickEvents.forEach(e => {
      if (!navClickSessionSets[e.event_name]) navClickSessionSets[e.event_name] = new Set();
      navClickSessionSets[e.event_name].add(e.session_id);
    });
    const navClicks = navClickOrder.map(name => ({
      event: name,
      sessions: navClickSessionSets[name] ? navClickSessionSets[name].size : 0
    }));

    res.json({ totals, byCountry, sectionReach, navClicks, totalSessions });
  } catch (error) {
    console.error('❌ Landing-Engagement-Fehler:', error);
    res.status(500).json({ error: 'Verweildauer-Auswertung konnte nicht geladen werden.' });
  }
});

// ============================================================
// CONVERSION-INSIGHTS: Warum HAT jemand gekauft?
//
// Das Gegenstück zu checkout-funnel/landing-engagement oben (die zeigen,
// wo Interessenten abspringen) - hier geht's um die, die tatsächlich
// zahlende Kunden wurden: über welchen Einstiegspunkt (Demo, Rechner,
// WEEE/Batterie-Sektion oder direkt), über welchen Traffic-Kanal, aus
// welchem Land, mit welchem Plan - und ob sie vor der Registrierung
// überhaupt die WEEE/Batterie-Sektion oder die Preise gesehen haben
// (siehe view_weeebat/view_pricing, GET /admin/landing-engagement).
// Nutzt ausschließlich bereits vorhandene Tracking-Daten, keine neuen
// Events nötig.
// ============================================================
router.get('/conversion-insights', (req, res) => {
  try {
    const payingCustomers = db.prepare(`
      SELECT id, plan, origin_country, acquisition_source, acquisition_session_id, created_at
      FROM customers WHERE subscription_status = 'active'
    `).all();

    const totalPaying = payingCustomers.length;
    if (totalPaying === 0) {
      return res.json({ totalPaying: 0, byEntryPoint: {}, byChannel: {}, byCountry: {}, byPlan: {}, sawWeeebatSection: 0, sawPricingSection: 0 });
    }

    const pageviews = db.prepare(`SELECT session_id, referrer, utm_source, created_at FROM page_views ORDER BY created_at ASC`).all();
    const firstPageviewBySession = {};
    pageviews.forEach(v => {
      if (!firstPageviewBySession[v.session_id]) firstPageviewBySession[v.session_id] = v;
    });

    const events = db.prepare(`SELECT event_name, session_id, created_at FROM click_events`).all();
    const eventsBySession = {};
    events.forEach(e => {
      if (!eventsBySession[e.session_id]) eventsBySession[e.session_id] = [];
      eventsBySession[e.session_id].push(e);
    });

    // Gleiche Zuordnungslogik wie attribute() in /funnel-attribution oben,
    // zusätzlich um die WEEE/Batterie-CTAs erweitert - erstes passendes
    // Event VOR der Registrierung gewinnt.
    function entryPoint(customer) {
      const sessionEvents = eventsBySession[customer.acquisition_session_id] || [];
      const before = sessionEvents.filter(e => e.created_at <= customer.created_at);
      if (before.some(e => e.event_name === 'weeebat_demo_click')) return 'weeebat_demo';
      if (before.some(e => e.event_name === 'weeebat_cta_click')) return 'weeebat_cta';
      if (before.some(e => e.event_name === 'demo_start')) return 'demo';
      if (before.some(e => e.event_name === 'calculator_click')) return 'rechner';
      if (before.some(e => e.event_name === 'usp_cta_click')) return 'usp';
      if (before.some(e => e.event_name === 'hero_price_badge_click')) return 'hero_price_badge';
      if (before.some(e => e.event_name === 'hero_weeebat_badge_click')) return 'hero_weeebat_badge';
      return 'direkt';
    }

    const byEntryPoint = {};
    const byChannel = {};
    const byCountry = {};
    const byPlan = {};
    let sawWeeebatSection = 0;
    let sawPricingSection = 0;

    payingCustomers.forEach(c => {
      const ep = entryPoint(c);
      byEntryPoint[ep] = (byEntryPoint[ep] || 0) + 1;

      const pv = firstPageviewBySession[c.acquisition_session_id];
      const channel = pv ? classifyChannel(pv) : 'unbekannt';
      byChannel[channel] = (byChannel[channel] || 0) + 1;

      const country = c.origin_country || 'unbekannt';
      byCountry[country] = (byCountry[country] || 0) + 1;

      byPlan[c.plan] = (byPlan[c.plan] || 0) + 1;

      const sessionEvents = eventsBySession[c.acquisition_session_id] || [];
      if (sessionEvents.some(e => e.event_name === 'view_weeebat')) sawWeeebatSection++;
      if (sessionEvents.some(e => e.event_name === 'view_pricing')) sawPricingSection++;
    });

    res.json({ totalPaying, byEntryPoint, byChannel, byCountry, byPlan, sawWeeebatSection, sawPricingSection });
  } catch (error) {
    console.error('❌ Conversion-Insights-Fehler:', error);
    res.status(500).json({ error: 'Conversion-Auswertung konnte nicht geladen werden.' });
  }
});

// Wie lange schauen sich Besucher die Sandbox-Demo im Dashboard an
// (siehe DEMO_MODE in dashboard.html, das 'demo_duration'-Event sendet).
router.get('/demo-duration-stats', (req, res) => {
  try {
    const durations = db.prepare(`
      SELECT event_value FROM click_events
      WHERE event_name = 'demo_duration' AND event_value IS NOT NULL
      ORDER BY event_value ASC
    `).all().map(r => r.event_value);

    if (durations.length === 0) {
      return res.json({ count: 0, avgSeconds: null, medianSeconds: null });
    }

    const avgSeconds = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const mid = Math.floor(durations.length / 2);
    const medianSeconds = durations.length % 2 === 0
      ? Math.round((durations[mid - 1] + durations[mid]) / 2)
      : durations[mid];

    res.json({ count: durations.length, avgSeconds, medianSeconds });
  } catch (error) {
    console.error('❌ Demo-Dauer-Stats-Fehler:', error);
    res.status(500).json({ error: 'Demo-Dauer-Auswertung konnte nicht geladen werden.' });
  }
});

// Was wird im Eco-Fee-Rechner auf der Landing Page tatsächlich
// durchgerechnet - häufigste Länder, durchschnittliche Menge,
// welcher Plan kommt am Ende raus (siehe calculator_usage-Tabelle).
router.get('/calculator-usage', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT countries_json, country_count, total_kg, plan, savings
      FROM calculator_usage
      ORDER BY created_at DESC
      LIMIT 500
    `).all();

    const countryCounts = {};
    const planCounts = {};
    let totalKgSum = 0;

    rows.forEach(r => {
      let countries = [];
      try { countries = JSON.parse(r.countries_json); } catch (e) { countries = []; }
      countries.forEach(c => {
        countryCounts[c] = (countryCounts[c] || 0) + 1;
      });
      if (r.plan) planCounts[r.plan] = (planCounts[r.plan] || 0) + 1;
      totalKgSum += r.total_kg || 0;
    });

    const topCountries = Object.entries(countryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({ code, count }));

    res.json({
      totalCalculations: rows.length,
      avgKg: rows.length ? Math.round(totalKgSum / rows.length) : null,
      topCountries,
      planCounts
    });
  } catch (error) {
    console.error('❌ Rechner-Nutzungs-Stats-Fehler:', error);
    res.status(500).json({ error: 'Rechner-Auswertung konnte nicht geladen werden.' });
  }
});

// Nutzung des öffentlichen FAQ-Chats auf der Landing Page (siehe
// routes/faq-chat.js): wie oft insgesamt genutzt, welche Fragen am
// häufigsten vorkommen (vorgefertigte Klicks UND Freitext zusammen -
// vorgefertigte/Vorfilter-Treffer werden über canned_id gruppiert,
// Freitext über den normalisierten Fragetext), und eine Liste der
// Fragen, die die KI NICHT sicher aus bekanntem Wissen beantworten
// konnte - das sind Kandidaten für neue FAQ-Einträge, keine Fragen,
// für die recherchiert wurde (der Chat betreibt bewusst keine eigene
// Recherche, siehe faq-chat.js).
router.get('/faq-chat-usage', (req, res) => {
  try {
    const totalQuestions = db.prepare('SELECT COUNT(*) AS n FROM faq_chat_log').get().n;

    const rows = db.prepare(`
      SELECT question, source, canned_id
      FROM faq_chat_log
      ORDER BY created_at DESC
      LIMIT 2000
    `).all();

    const groups = {};
    rows.forEach(r => {
      const key = r.canned_id || r.question.trim().toLowerCase();
      if (!groups[key]) groups[key] = { question: r.question, count: 0 };
      groups[key].count++;
    });
    const topQuestions = Object.values(groups)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const sourceCounts = {};
    rows.forEach(r => { sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1; });

    const unanswered = db.prepare(`
      SELECT question, created_at
      FROM faq_chat_log
      WHERE answered = 0
      ORDER BY created_at DESC
      LIMIT 30
    `).all();

    res.json({ totalQuestions, sourceCounts, topQuestions, unanswered });
  } catch (error) {
    console.error('❌ FAQ-Chat-Stats-Fehler:', error);
    res.status(500).json({ error: 'FAQ-Chat-Auswertung konnte nicht geladen werden.' });
  }
});

// ============================================================
// LEADS
// ============================================================
router.get('/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(leads);
});

router.post('/leads', (req, res) => {
  const { name, contact, source, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name ist erforderlich.' });

  const result = db.prepare(`
    INSERT INTO leads (name, contact, source, notes)
    VALUES (?, ?, ?, ?)
  `).run(name, contact || null, source || 'other', notes || null);

  res.status(201).json(db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid));
});

// Sammel-Eintrag für bereits verschickte Kontaktaufnahmen (z. B. eine
// Charge Steuerberater-/Fulfillment-Mails) - erspart, jeden Kontakt
// einzeln über das Formular anzulegen. status default "contacted" statt
// "new", weil diese Leads per Definition schon kontaktiert wurden.
router.post('/leads/bulk', (req, res) => {
  const { leads, source, status } = req.body || {};
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'Keine Leads übergeben.' });
  }

  const insert = db.prepare(`
    INSERT INTO leads (name, contact, source, status, notes)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      if (!name) continue;
      insert.run(
        name,
        typeof row.contact === 'string' && row.contact.trim() ? row.contact.trim() : null,
        source || 'other',
        status || 'contacted',
        typeof row.notes === 'string' && row.notes.trim() ? row.notes.trim() : null
      );
      count++;
    }
    return count;
  });

  const inserted = insertMany(leads);
  res.status(201).json({ inserted });
});

router.put('/leads/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Lead nicht gefunden.' });

  const { name, contact, source, status, notes } = req.body || {};
  db.prepare(`
    UPDATE leads
    SET name = COALESCE(?, name),
        contact = ?,
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(name || null, contact ?? null, source || null, status || null, notes ?? null, req.params.id);

  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id));
});

router.delete('/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// AUFGABEN
// ============================================================
// Offene Aufgaben zuerst, darunter nach Dringlichkeit (hoch -> mittel ->
// niedrig), dann Fälligkeitsdatum. Erledigte Aufgaben rutschen ans Ende,
// unabhängig von ihrer Priorität.
//
// Täglich wiederkehrende Aufgaben (recurrence='daily', z. B. "Insta
// Stories posten") haben KEINEN dauerhaften "erledigt"-Zustand - die
// status-Spalte bleibt für sie technisch immer 'open', stattdessen
// zeigt last_completed_date, ob HEUTE schon erledigt wurde. Der
// "effective_status" unten ist das, was Sortierung und Frontend
// tatsächlich als status sehen: für normale Aufgaben 1:1 die
// gespeicherte status-Spalte, für tägliche Aufgaben "done" nur wenn
// last_completed_date == heute - sonst automatisch wieder "open",
// ganz ohne Cronjob zum Zurücksetzen.
const TASK_SELECT_SQL = `
  SELECT t.id, t.title, t.due_date, t.priority, t.recurrence, t.last_completed_date,
    t.related_lead_id, t.created_at, t.updated_at, l.name as lead_name,
    CASE WHEN t.recurrence = 'daily'
         THEN (CASE WHEN t.last_completed_date = date('now') THEN 'done' ELSE 'open' END)
         ELSE t.status
    END as status
  FROM admin_tasks t
  LEFT JOIN leads l ON l.id = t.related_lead_id
`;
const TASK_ORDER_SQL = `
  ORDER BY (status = 'done'),
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END,
    COALESCE(due_date, '9999-12-31'), created_at
`;

function getTaskById(id) {
  return db.prepare(`SELECT * FROM (${TASK_SELECT_SQL}) WHERE id = ?`).get(id);
}

router.get('/tasks', (req, res) => {
  const tasks = db.prepare(`SELECT * FROM (${TASK_SELECT_SQL}) ${TASK_ORDER_SQL}`).all();
  res.json(tasks);
});

const VALID_TASK_PRIORITIES = ['high', 'medium', 'low'];
const VALID_TASK_RECURRENCE = ['none', 'daily'];

router.post('/tasks', (req, res) => {
  const { title, due_date, related_lead_id, priority, status, recurrence } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Titel ist erforderlich.' });

  const result = db.prepare(`
    INSERT INTO admin_tasks (title, due_date, related_lead_id, priority, status, recurrence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    title,
    due_date || null,
    related_lead_id || null,
    VALID_TASK_PRIORITIES.includes(priority) ? priority : 'medium',
    status === 'done' ? 'done' : 'open',
    VALID_TASK_RECURRENCE.includes(recurrence) ? recurrence : 'none'
  );

  res.status(201).json(getTaskById(result.lastInsertRowid));
});

// Sammel-Eintrag, z. B. um einen bestehenden Launch-Ablaufplan (inkl.
// bereits erledigter Punkte) in einem Rutsch nachzutragen, statt jede
// Zeile einzeln anzulegen und dann einzeln abzuhaken.
router.post('/tasks/bulk', (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'Keine Aufgaben übergeben.' });
  }

  const insert = db.prepare(`
    INSERT INTO admin_tasks (title, due_date, priority, status, recurrence)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const title = typeof row?.title === 'string' ? row.title.trim() : '';
      if (!title) continue;
      insert.run(
        title,
        typeof row.due_date === 'string' && row.due_date.trim() ? row.due_date.trim() : null,
        VALID_TASK_PRIORITIES.includes(row.priority) ? row.priority : 'medium',
        row.status === 'done' ? 'done' : 'open',
        VALID_TASK_RECURRENCE.includes(row.recurrence) ? row.recurrence : 'none'
      );
      count++;
    }
    return count;
  });

  const inserted = insertMany(tasks);
  res.status(201).json({ inserted });
});

router.put('/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT id, recurrence FROM admin_tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });

  const { title, due_date, status, priority, recurrence } = req.body || {};
  const nextRecurrence = VALID_TASK_RECURRENCE.includes(recurrence) ? recurrence : existing.recurrence;
  const isDaily = nextRecurrence === 'daily';

  if (isDaily && status !== undefined) {
    // Bei täglich wiederkehrenden Aufgaben steuert "status" nur, ob HEUTE
    // erledigt wurde - dafür last_completed_date setzen/löschen statt der
    // status-Spalte, damit der Haken am nächsten Tag von selbst verschwindet.
    db.prepare(`
      UPDATE admin_tasks SET last_completed_date = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status === 'done' ? new Date().toISOString().slice(0, 10) : null, req.params.id);
  }

  // due_date wird nur angefasst, wenn der Aufruf den Key überhaupt mitschickt
  // - toggleTask() im Dashboard schickt z. B. nur {status}, und darf dabei
  // ein bereits gesetztes Fälligkeitsdatum nicht versehentlich löschen.
  db.prepare(`
    UPDATE admin_tasks
    SET title = COALESCE(?, title),
        due_date = CASE WHEN ? THEN ? ELSE due_date END,
        status = CASE WHEN ? THEN status ELSE COALESCE(?, status) END,
        priority = COALESCE(?, priority),
        recurrence = COALESCE(?, recurrence),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title || null,
    due_date !== undefined ? 1 : 0,
    due_date || null,
    isDaily ? 1 : 0, status || null,
    VALID_TASK_PRIORITIES.includes(priority) ? priority : null,
    VALID_TASK_RECURRENCE.includes(recurrence) ? recurrence : null,
    req.params.id
  );

  res.json(getTaskById(req.params.id));
});

router.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM admin_tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// KUNDEN (Lese-Übersicht fürs Vertriebs-Tool)
// ============================================================
router.get('/customers', (req, res) => {
  const customers = db.prepare(`
    SELECT id, customer_number, company_name, email, plan, subscription_status,
           acquisition_source, created_at
    FROM customers
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  res.json(customers);
});

// ============================================================
// 14-TAGE-GELD-ZURÜCK-GARANTIE
//
// Deckt nur die Pack2EU-Plattformgebühr ab - NICHT bereits an einen
// Bevollmächtigten weitergereichte Kosten (siehe AGB). Ein Bevollmächtigter
// handelt nach eigener Vollmacht in eigenem Namen (siehe AGB/Impressum-
// Popup in index.html) - sobald einer für den Kunden hinterlegt ist, hat
// Pack2EU diese Vermittlung bereits geleistet bzw. der Kunde hat eine
// eigene Beauftragung ausgelöst, die sich nicht rückgängig machen lässt.
// Deshalb blockiert dieser Endpoint die automatische Erstattung in dem
// Fall bewusst, statt eine Aufteilung zu erraten - stattdessen manuell
// in Stripe prüfen (Plattformgebühr abzüglich Bevollmächtigten-Kosten).
router.post('/customers/:id/refund-guarantee', async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

    const daysSinceSignup = (Date.now() - new Date(customer.created_at).getTime()) / 86400000;
    if (daysSinceSignup > 14) {
      return res.status(400).json({
        error: `Außerhalb der 14-Tage-Frist (Kunde seit ${Math.floor(daysSinceSignup)} Tagen registriert).`
      });
    }

    const repEngaged = db.prepare(`
      SELECT COUNT(*) as count FROM activations
      WHERE customer_id = ? AND (representative_name IS NOT NULL OR representative_email IS NOT NULL)
    `).get(customerId).count > 0;
    if (repEngaged) {
      return res.status(409).json({
        error: 'Für diesen Kunden ist bereits ein Bevollmächtigter hinterlegt/beauftragt. Die Garantie deckt bereits an Dritte weitergereichte Kosten nicht ab - Rückerstattung bitte manuell in Stripe prüfen (nur Plattformgebühr abzüglich Bevollmächtigten-Kosten erstatten).'
      });
    }

    const paymentRow = db.prepare(`
      SELECT stripe_session_id FROM checkout_sessions
      WHERE customer_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(customerId);
    if (!paymentRow) {
      return res.status(400).json({ error: 'Keine abgeschlossene Zahlung für diesen Kunden gefunden.' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(paymentRow.stripe_session_id);
    if (!session.payment_intent) {
      return res.status(400).json({ error: 'Zu dieser Zahlung liegt kein erstattbarer Payment Intent vor.' });
    }

    const refund = await stripe.refunds.create({ payment_intent: session.payment_intent });

    if (customer.stripe_subscription_id) {
      await stripe.subscriptions.cancel(customer.stripe_subscription_id).catch(err => {
        console.error('⚠️ Abo konnte nach Rückerstattung nicht automatisch gekündigt werden:', err.message);
      });
    }
    db.prepare(`UPDATE customers SET subscription_status = 'inactive', cancelled_at = datetime('now') WHERE id = ?`).run(customerId);

    res.json({ ok: true, refundId: refund.id, amount: refund.amount, currency: refund.currency });
  } catch (error) {
    console.error('❌ Rückerstattungs-Fehler:', error.message);
    res.status(500).json({ error: 'Rückerstattung fehlgeschlagen: ' + error.message });
  }
});

// ============================================================
// UMSATZ (MRR/ARR nach Plan, Land, Zahlweise) + einfache Prognose
//
// Preise kommen live aus Stripe (nicht hier hartcodiert) - so bleibt
// die Auswertung automatisch korrekt, auch wenn sich Preise im
// Stripe-Dashboard ändern. Kurzes In-Memory-Caching, damit nicht bei
// jedem Laden des Tools mehrere Stripe-API-Aufrufe anfallen.
// ============================================================
const STRIPE_REVENUE_PRICE_ENV = {
  S: { monthly: 'STRIPE_PRICE_S', annual: 'STRIPE_PRICE_S_ANNUAL' },
  M: { monthly: 'STRIPE_PRICE_M', annual: 'STRIPE_PRICE_M_ANNUAL' },
  L: { monthly: 'STRIPE_PRICE_L', annual: 'STRIPE_PRICE_L_ANNUAL' }
};

let priceCache = null;
let priceCacheAt = 0;
const PRICE_CACHE_MS = 10 * 60 * 1000;

async function getStripePrices() {
  if (priceCache && Date.now() - priceCacheAt < PRICE_CACHE_MS) return priceCache;
  if (!process.env.STRIPE_SECRET_KEY) return null;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const result = { plans: {}, amazonAddon: null };

  for (const [plan, intervals] of Object.entries(STRIPE_REVENUE_PRICE_ENV)) {
    result.plans[plan] = {};
    for (const [interval, envName] of Object.entries(intervals)) {
      const priceId = process.env[envName];
      if (!priceId) continue;
      try {
        const price = await stripe.prices.retrieve(priceId);
        result.plans[plan][interval] = (price.unit_amount || 0) / 100;
      } catch (err) {
        console.error(`❌ Stripe-Preis ${envName} konnte nicht geladen werden:`, err.message);
      }
    }
  }

  const addonPriceId = process.env.STRIPE_PRICE_AMAZON_ADDON;
  if (addonPriceId) {
    try {
      const price = await stripe.prices.retrieve(addonPriceId);
      result.amazonAddon = (price.unit_amount || 0) / 100;
    } catch (err) {
      console.error('❌ Stripe-Preis STRIPE_PRICE_AMAZON_ADDON konnte nicht geladen werden:', err.message);
    }
  }

  priceCache = result;
  priceCacheAt = Date.now();
  return result;
}

// Grobe Wochen-Bucket-Zuordnung für die Signup-Kurve - muss nicht
// perfekt ISO-8601-konform sein, nur konsistent sortierbar.
function weekKeyFromSqliteDate(sqliteDate) {
  const d = new Date(sqliteDate.replace(' ', 'T') + 'Z');
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Einfache lineare Fortschreibung des bisherigen Signup-Tempos - bewusst
// kein ausgefeiltes Modell (keine Kohorten-/Churn-Analyse), weil dafür
// die Datenbasis am Anfang schlicht fehlt. Kennzeichnet sich selbst als
// "wenig belastbar", solange nur wenige echte Kunden vorliegen.
function buildRevenueForecast(customers, activeCount, mrr) {
  if (customers.length === 0) {
    return { weeklySignups: [], projected: [], lowConfidence: true, note: 'Noch keine Kundendaten für eine Prognose vorhanden.' };
  }

  const weekCounts = {};
  customers.forEach(c => {
    const key = weekKeyFromSqliteDate(c.created_at);
    weekCounts[key] = (weekCounts[key] || 0) + 1;
  });
  const weeks = Object.keys(weekCounts).sort();
  const weeklySignups = weeks.map(w => ({ week: w, signups: weekCounts[w] }));

  const totalWeeks = weeks.length;
  const avgPerWeek = customers.length / Math.max(1, totalWeeks);
  const activeShare = customers.length > 0 ? activeCount / customers.length : 0;
  const avgRevenuePerActiveCustomer = activeCount > 0 ? mrr / activeCount : 0;

  const projected = [4, 12, 26, 52].map(weeksAhead => {
    const projectedCustomers = Math.round(customers.length + avgPerWeek * weeksAhead);
    const projectedActive = Math.round(projectedCustomers * activeShare);
    return {
      weeksAhead,
      projectedCustomers,
      projectedActiveCustomers: projectedActive,
      projectedMrr: Math.round(projectedActive * avgRevenuePerActiveCustomer)
    };
  });

  const lowConfidence = customers.length < 10 || totalWeeks < 3;

  return {
    weeklySignups,
    avgSignupsPerWeek: Math.round(avgPerWeek * 10) / 10,
    projected,
    lowConfidence,
    note: lowConfidence
      ? `Basis: nur ${customers.length} Kunde(n) über ${totalWeeks} Woche(n) - diese Prognose ist eine grobe lineare Fortschreibung und wird erst mit mehr echten Daten belastbar.`
      : `Lineare Fortschreibung auf Basis von ${customers.length} Kunden über ${totalWeeks} Wochen (Ø ${Math.round(avgPerWeek * 10) / 10} Neukunden/Woche).`
  };
}

router.get('/revenue', async (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT plan, billing_interval, subscription_status, origin_country,
             amazon_addon_active, created_at
      FROM customers
    `).all();

    const prices = await getStripePrices();
    if (!prices) {
      return res.status(503).json({ error: 'Umsatzauswertung ist noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt).' });
    }

    const active = customers.filter(c => c.subscription_status === 'active');

    const byPlanMap = {};
    const byCountryMap = {};
    let mrr = 0;
    let unpriced = 0;

    active.forEach(c => {
      const interval = c.billing_interval === 'annual' ? 'annual' : 'monthly';
      const amount = prices.plans[c.plan]?.[interval];
      const monthlyEquivalent = amount != null ? (interval === 'annual' ? amount / 12 : amount) : 0;
      if (amount == null) unpriced++;

      const planKey = `${c.plan}_${interval}`;
      if (!byPlanMap[planKey]) byPlanMap[planKey] = { plan: c.plan, interval, count: 0, mrr: 0 };
      byPlanMap[planKey].count++;
      byPlanMap[planKey].mrr += monthlyEquivalent;

      const country = c.origin_country || 'unbekannt';
      byCountryMap[country] = (byCountryMap[country] || 0) + monthlyEquivalent;

      mrr += monthlyEquivalent;
    });

    const amazonCount = active.filter(c => c.amazon_addon_active).length;
    const amazonMrr = amazonCount * (prices.amazonAddon || 0);
    mrr += amazonMrr;

    const forecast = buildRevenueForecast(customers, active.length, mrr);

    res.json({
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      activeCustomers: active.length,
      totalCustomers: customers.length,
      byPlan: Object.values(byPlanMap).map(p => ({ ...p, mrr: Math.round(p.mrr * 100) / 100 })).sort((a, b) => b.mrr - a.mrr),
      byCountry: Object.entries(byCountryMap)
        .map(([country, val]) => ({ country, mrr: Math.round(val * 100) / 100 }))
        .sort((a, b) => b.mrr - a.mrr),
      amazonAddon: { count: amazonCount, mrr: Math.round(amazonMrr * 100) / 100 },
      unpricedActiveCustomers: unpriced,
      forecast
    });
  } catch (error) {
    console.error('❌ Umsatz-Fehler:', error);
    res.status(503).json({ error: 'Umsatzauswertung gerade nicht verfügbar.' });
  }
});

// ============================================================
// DATENBANK-BACKUP HERUNTERLADEN
//
// Nutzt SQLites Online-Backup-API (nicht einfach die Datei kopieren -
// bei aktivem WAL-Modus könnte eine rohe Dateikopie unvollständig/
// inkonsistent sein). Der Download landet auf dem Rechner der Person,
// die ihn auslöst - das ist aktuell der einzige echte Off-Server-
// Backup-Weg, solange kein Cloud-Speicher (S3 o. ä.) angebunden ist.
// ============================================================
router.get('/backup/download', async (req, res) => {
  const tempPath = path.join(os.tmpdir(), `pack2eu-backup-${Date.now()}.db`);

  try {
    await db.backup(tempPath);

    const stamp = new Date().toISOString().slice(0, 10);
    res.download(tempPath, `pack2eu-backup-${stamp}.db`, (err) => {
      fs.unlink(tempPath, () => {});
      if (err) console.error('❌ Backup-Download-Fehler:', err.message);
    });
  } catch (error) {
    console.error('❌ Backup-Fehler:', error);
    fs.unlink(tempPath, () => {});
    res.status(500).json({ error: 'Backup konnte nicht erstellt werden.' });
  }
});

// ============================================================
// DATENBANK-BACKUP WIEDERHERSTELLEN
//
// Einmaliger Notfall-Weg, um eine per /backup/download geladene Datei
// zurückzuspielen (z.B. nach Umzug auf ein Render Persistent Disk).
// Ersetzt die komplette DB_PATH-Datei - JEDE Anfrage danach verliert
// alles, was seit dem Backup dazugekommen ist. Braucht express.raw()
// auf genau dieser Route (siehe server.js), weil das globale
// express.json() weder Binärdaten noch >500kb verträgt.
//
// Die laufende better-sqlite3-Verbindung (db, hier und in jeder
// anderen Route) ist an die alte Datei gebunden und kann nicht "live"
// auf die neue umgehängt werden - deshalb beendet sich der Prozess
// nach erfolgreichem Restore bewusst selbst. Render startet den
// Dienst automatisch neu, und beim Neustart öffnet db/index.js die
// gerade wiederhergestellte Datei.
// ============================================================
router.post('/backup/restore', async (req, res) => {
  const upload = req.body;

  if (!Buffer.isBuffer(upload) || upload.length === 0) {
    return res.status(400).json({ error: 'Keine Datei empfangen.' });
  }

  // SQLite-Dateien beginnen immer mit diesem 16-Byte-Header.
  const SQLITE_MAGIC = 'SQLite format 3\0';
  if (upload.length < 16 || upload.toString('utf8', 0, 16) !== SQLITE_MAGIC) {
    return res.status(400).json({ error: 'Datei sieht nicht wie eine gültige SQLite-Datenbank aus.' });
  }

  const tempPath = path.join(os.tmpdir(), `pack2eu-restore-${Date.now()}.db`);

  try {
    fs.writeFileSync(tempPath, upload);

    // Vor dem Ersetzen prüfen, ob sich die Datei überhaupt öffnen lässt
    // und mindestens die erwarteten Kern-Tabellen enthält - lieber hier
    // hart abbrechen als eine kaputte Datei live zu schalten.
    const Database = require('better-sqlite3');
    const check = new Database(tempPath, { readonly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    check.close();
    if (!tables.includes('customers')) {
      fs.unlink(tempPath, () => {});
      return res.status(400).json({ error: 'Datei enthält keine erkennbare Pack2EU-Datenbank (Tabelle "customers" fehlt).' });
    }

    // Aktuellen Stand sicherheitshalber wegsichern, bevor er überschrieben wird.
    const safetyStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyPath = `${DB_PATH}.before-restore-${safetyStamp}`;
    try {
      await db.backup(safetyPath);
    } catch (safetyError) {
      console.error('⚠️ Konnte Sicherheitskopie vor Restore nicht anlegen:', safetyError.message);
    }

    db.close();
    fs.copyFileSync(tempPath, DB_PATH);
    fs.unlink(tempPath, () => {});
    // WAL-/SHM-Reste der alten Datei entfernen, damit sie beim Neustart
    // nicht mit dem gerade eingespielten Stand kollidieren.
    for (const suffix of ['-wal', '-shm']) {
      fs.unlink(`${DB_PATH}${suffix}`, () => {});
    }

    res.json({ ok: true, message: 'Restore erfolgreich. Dienst startet jetzt neu.' });
    setTimeout(() => process.exit(0), 500);
  } catch (error) {
    fs.unlink(tempPath, () => {});
    console.error('❌ Restore-Fehler:', error);
    res.status(500).json({ error: 'Restore fehlgeschlagen.' });
  }
});

// ============================================================
// THEMENANALYSE (häufigste Anliegen aus Feedback + Support-Chat)
//
// Läuft NICHT automatisch bei jedem Laden des Tools, sondern nur auf
// Knopfdruck ("Jetzt analysieren") - jeder Lauf kostet einen echten
// KI-Aufruf. Das letzte Ergebnis wird in topic_analysis
// zwischengespeichert, damit man beim Öffnen des Tools sofort etwas
// sieht, ohne erneut zu bezahlen.
// ============================================================
const TopicsSchema = z.object({
  topics: z.array(z.object({
    topic: z.string(),
    count: z.number().int(),
    example_quotes: z.array(z.string()).max(3)
  })).max(10)
});

const TOPICS_SYSTEM_PROMPT = `
Du bekommst eine Liste von Kunden-Feedback- und Support-Chat-Nachrichten
für die SaaS Pack2EU (EU-Verpackungscompliance für Online-Händler).

Fasse sie in maximal 10 wiederkehrende Themen/Anliegen zusammen, sortiert
nach Häufigkeit (häufigstes zuerst). Fasse inhaltlich ähnliche Nachrichten
zu einem Thema zusammen (z. B. mehrere Fragen zu Frankreich-EPR als ein
Thema). Ignoriere reinen Spam oder Einzelfälle ohne Muster - die müssen
nicht als eigenes Thema auftauchen.

Für jedes Thema:
- "topic": kurzer, konkreter Titel auf Deutsch (max. 8 Wörter)
- "count": wie viele der gegebenen Nachrichten zu diesem Thema passen
- "example_quotes": 1-3 kurze, wörtliche Ausschnitte als Beleg (max. 25 Wörter je Zitat)

Wenn die Liste zu wenige/zu unterschiedliche Nachrichten für erkennbare
Muster enthält, gib weniger oder gar keine Themen zurück statt Themen zu
erfinden.
`.trim();

router.get('/topics', (req, res) => {
  const latest = db.prepare('SELECT * FROM topic_analysis ORDER BY created_at DESC LIMIT 1').get();
  if (!latest) return res.json({ topics: [], sourceCount: 0, analyzedAt: null });
  res.json({ topics: JSON.parse(latest.results_json), sourceCount: latest.source_count, analyzedAt: latest.created_at });
});

router.post('/topics/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Themenanalyse ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
  }

  try {
    const feedbackRows = db.prepare(`
      SELECT message FROM feedback
      WHERE category IS NULL OR category != 'spam'
      ORDER BY created_at DESC LIMIT 150
    `).all();
    const supportRows = db.prepare(`
      SELECT content FROM support_messages
      WHERE role = 'user'
      ORDER BY created_at DESC LIMIT 150
    `).all();

    const items = [
      ...feedbackRows.map(r => `[Feedback] ${r.message}`),
      ...supportRows.map(r => `[Support-Chat] ${r.content}`)
    ];

    if (items.length === 0) {
      return res.json({ topics: [], sourceCount: 0, analyzedAt: null });
    }

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 2048,
      output_config: {
        format: zodOutputFormat(TopicsSchema),
        effort: 'medium'
      },
      system: TOPICS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: items.map((t, i) => `${i + 1}. ${t}`).join('\n') }]
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      return res.status(502).json({ error: 'Analyse konnte nicht verarbeitet werden.' });
    }

    db.prepare('INSERT INTO topic_analysis (results_json, source_count) VALUES (?, ?)')
      .run(JSON.stringify(parsed.topics), items.length);

    res.json({ topics: parsed.topics, sourceCount: items.length, analyzedAt: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Themenanalyse-Fehler:', error);
    res.status(503).json({ error: 'Themenanalyse gerade nicht verfügbar. Bitte später erneut versuchen.' });
  }
});

// ============================================================
// RECHTSÄNDERUNGS-RADAR
//
// Automatisierte Web-Recherche (siehe legal-watch.js) zum aktuellen
// Stand der Verpackungs-/EPR-Pflichten pro Land. Schreibt NIE
// automatisch in die "countries"-Tabelle - jeder Fund landet erst
// hier zur Prüfung. Erst ein Klick auf "Übernehmen" durch einen
// Menschen überträgt die vorgeschlagenen Werte, und auch dann bleibt
// data_status bewusst auf 'needs_verification' stehen (nie 'verified'):
// eine KI-Recherche ersetzt keine echte Rechtsprüfung, sie beschleunigt
// nur die Vorarbeit dafür.
// ============================================================
router.get('/legal-watch', (req, res) => {
  try {
    const status = req.query.status;
    const rows = status
      ? db.prepare(`
          SELECT lw.*, c.name AS country_name, c.flag
          FROM legal_watch_findings lw
          LEFT JOIN countries c ON c.code = lw.country_code
          WHERE lw.status = ?
          ORDER BY lw.checked_at DESC
        `).all(status)
      : db.prepare(`
          SELECT lw.*, c.name AS country_name, c.flag
          FROM legal_watch_findings lw
          LEFT JOIN countries c ON c.code = lw.country_code
          ORDER BY lw.checked_at DESC
          LIMIT 200
        `).all();

    const findings = rows.map(r => ({
      id: r.id,
      countryCode: r.country_code,
      countryName: r.country_name,
      flag: r.flag,
      stream: r.stream || 'packaging',
      checkedAt: r.checked_at,
      hasUpdate: !!r.has_update,
      summary: r.summary,
      aiConfidence: r.ai_confidence,
      suggestedFields: r.suggested_fields_json ? JSON.parse(r.suggested_fields_json) : null,
      sources: r.sources_json ? JSON.parse(r.sources_json) : [],
      status: r.status,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by
    }));

    res.json({ findings });
  } catch (error) {
    console.error('❌ Rechtsänderungs-Radar Übersicht-Fehler:', error);
    res.status(500).json({ error: 'Funde konnten nicht geladen werden.' });
  }
});

router.post('/legal-watch/run', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Rechtsänderungs-Radar ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
  }

  try {
    const { runLegalWatch } = require('../legal-watch');
    const limit = Math.min(Number(req.body?.limit) || 3, 10);
    const stream = ['packaging', 'weee', 'battery'].includes(req.body?.stream) ? req.body.stream : 'packaging';
    const results = await runLegalWatch({ limit, stream });
    res.json({ results });
  } catch (error) {
    console.error('❌ Rechtsänderungs-Radar Lauf-Fehler:', error);
    res.status(503).json({ error: 'Rechtsänderungs-Check gerade nicht verfügbar. Bitte später erneut versuchen.' });
  }
});

router.post('/legal-watch/:id/apply', (req, res) => {
  try {
    const finding = db.prepare('SELECT * FROM legal_watch_findings WHERE id = ?').get(req.params.id);
    if (!finding) return res.status(404).json({ error: 'Fund nicht gefunden.' });
    if (finding.status !== 'new') return res.status(409).json({ error: 'Fund wurde bereits bearbeitet.' });

    const suggested = JSON.parse(finding.suggested_fields_json || '{}');
    const stream = finding.stream || 'packaging';

    if (stream === 'packaging') {
      const country = db.prepare('SELECT * FROM countries WHERE code = ?').get(finding.country_code);
      if (!country) return res.status(404).json({ error: `Land ${finding.country_code} nicht gefunden.` });

      // Nur Felder übernehmen, die die Recherche tatsächlich befüllt hat
      // (nicht null) - alles andere bleibt unverändert stehen.
      db.prepare(`
        UPDATE countries SET
          register_body = COALESCE(?, register_body),
          representative_required = COALESCE(?, representative_required),
          notary_required = COALESCE(?, notary_required),
          notary_cost = COALESCE(?, notary_cost),
          registration_url = COALESCE(?, registration_url),
          eco_fee = COALESCE(?, eco_fee),
          registration_generally_required = COALESCE(?, registration_generally_required),
          reporting_frequency = COALESCE(?, reporting_frequency),
          requirements_json = COALESCE(?, requirements_json),
          labeling_json = COALESCE(?, labeling_json),
          data_status = 'needs_verification'
        WHERE code = ?
      `).run(
        suggested.register_body ?? null,
        suggested.representative_required === null || suggested.representative_required === undefined ? null : (suggested.representative_required ? 1 : 0),
        suggested.notary_required === null || suggested.notary_required === undefined ? null : (suggested.notary_required ? 1 : 0),
        suggested.notary_cost ?? null,
        suggested.registration_url ?? null,
        suggested.eco_fee ?? null,
        suggested.registration_generally_required === null || suggested.registration_generally_required === undefined ? null : (suggested.registration_generally_required ? 1 : 0),
        suggested.reporting_frequency ?? null,
        suggested.requirements ? JSON.stringify(suggested.requirements) : null,
        suggested.labeling ? JSON.stringify(suggested.labeling) : null,
        finding.country_code
      );
    } else {
      // WEEE/Batterie: country_stream_rules statt countries - Zeile
      // existiert evtl. noch nicht (siehe Kommentar in db/schema.sql),
      // deshalb INSERT...ON CONFLICT statt UPDATE.
      const country = db.prepare('SELECT code FROM countries WHERE code = ?').get(finding.country_code);
      if (!country) return res.status(404).json({ error: `Land ${finding.country_code} nicht gefunden.` });

      db.prepare(`
        INSERT INTO country_stream_rules (
          country_code, stream, register_body, representative_required, notary_required,
          notary_cost, registration_url, registration_generally_required, reporting_frequency,
          requirements_json, labeling_json, data_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_verification', datetime('now'))
        ON CONFLICT(country_code, stream) DO UPDATE SET
          register_body = COALESCE(excluded.register_body, register_body),
          representative_required = COALESCE(excluded.representative_required, representative_required),
          notary_required = COALESCE(excluded.notary_required, notary_required),
          notary_cost = COALESCE(excluded.notary_cost, notary_cost),
          registration_url = COALESCE(excluded.registration_url, registration_url),
          registration_generally_required = COALESCE(excluded.registration_generally_required, registration_generally_required),
          reporting_frequency = COALESCE(excluded.reporting_frequency, reporting_frequency),
          requirements_json = COALESCE(excluded.requirements_json, requirements_json),
          labeling_json = COALESCE(excluded.labeling_json, labeling_json),
          data_status = 'needs_verification',
          updated_at = datetime('now')
      `).run(
        finding.country_code,
        stream,
        suggested.register_body ?? null,
        suggested.representative_required === null || suggested.representative_required === undefined ? null : (suggested.representative_required ? 1 : 0),
        suggested.notary_required === null || suggested.notary_required === undefined ? null : (suggested.notary_required ? 1 : 0),
        suggested.notary_cost ?? null,
        suggested.registration_url ?? null,
        suggested.registration_generally_required === null || suggested.registration_generally_required === undefined ? null : (suggested.registration_generally_required ? 1 : 0),
        suggested.reporting_frequency ?? null,
        suggested.requirements ? JSON.stringify(suggested.requirements) : null,
        suggested.labeling ? JSON.stringify(suggested.labeling) : null
      );
    }

    db.prepare(`
      UPDATE legal_watch_findings
      SET status = 'applied', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?
    `).run('admin', req.params.id);

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Rechtsänderungs-Radar Übernahme-Fehler:', error);
    res.status(500).json({ error: 'Fund konnte nicht übernommen werden.' });
  }
});

router.post('/legal-watch/:id/dismiss', (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE legal_watch_findings
      SET status = 'dismissed', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ? AND status = 'new'
    `).run('admin', req.params.id);

    if (result.changes === 0) return res.status(404).json({ error: 'Fund nicht gefunden oder bereits bearbeitet.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Rechtsänderungs-Radar Verwerfen-Fehler:', error);
    res.status(500).json({ error: 'Fund konnte nicht verworfen werden.' });
  }
});


// ============================================================
// BEVOLLMÄCHTIGTE-VERWALTUNG
//
// Kein Self-Service für Bevollmächtigte: Accounts werden ausschließlich
// hier angelegt (Einladung per E-Mail), Kunden-Zuweisungen ausschließlich
// hier gepflegt. Siehe routes/representatives.js für die Bevollmächtigten-
// seitigen Endpoints (Login, eigene Kundenliste).
// ============================================================

function issueRepInvite(repId, email, name) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE representatives
    SET invite_token_hash = ?, invite_expires_at = ?
    WHERE id = ?
  `).run(tokenHash, expiresAt, repId);

  const acceptUrl = `${process.env.APP_URL || ''}/representative.html?inviteToken=${rawToken}`;
  return sendRepresentativeInviteEmail(email, name, acceptUrl);
}

router.get('/representatives', (req, res) => {
  try {
    const reps = db.prepare(`
      SELECT r.id, r.country_code, r.stream, r.name, r.email, r.company, r.active,
             r.email_verified_at, r.last_login_at, r.created_at,
             (SELECT COUNT(*) FROM representative_customer_assignments WHERE representative_id = r.id) as assignedCustomers
      FROM representatives r
      ORDER BY r.created_at DESC
    `).all();
    res.json(reps);
  } catch (error) {
    console.error('❌ Admin Representatives-Liste-Fehler:', error);
    res.status(500).json({ error: 'Bevollmächtigte konnten nicht geladen werden.' });
  }
});

// Von /representatives (manuelle Anlage) UND /representative-requests/:id/approve
// (Freigabe einer Kunden-Anfrage) genutzt - siehe dort.
async function createAndInviteRepresentative({ countryCode, name, email, company, stream = 'packaging' }) {
  // Platzhalter-Hash: kein bekanntes Passwort, wird durch das echte
  // Passwort bei der Einladungs-Annahme ersetzt (siehe /accept-invite in
  // routes/representatives.js) - so bleibt die NOT-NULL-Spalte erfüllt,
  // ohne dass der Account vor Annahme der Einladung nutzbar wäre.
  const placeholderHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

  const insert = db.prepare(`
    INSERT INTO representatives (country_code, name, email, password_hash, company, stream)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(countryCode, name, email, placeholderHash, company || null, stream);

  await issueRepInvite(result.lastInsertRowid, email, name);
  return result.lastInsertRowid;
}

router.post('/representatives', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const company = req.body?.company ? String(req.body.company).trim() : null;
  const countryCode = String(req.body?.country_code || '').trim().toUpperCase();
  // Rückwärtskompatibel: fehlt stream im Request (alte admin.html-Version
  // vor der Mehrfach-Pflichtenstrom-Erweiterung), gilt weiterhin 'packaging'.
  const stream = ['packaging', 'weee', 'battery'].includes(req.body?.stream) ? req.body.stream : 'packaging';

  if (!email || !name || !countryCode) {
    return res.status(400).json({ error: 'E-Mail, Name und Land sind Pflichtfelder.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM representatives WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'E-Mail bereits registriert.' });

    const id = await createAndInviteRepresentative({ countryCode, name, email, company, stream });
    res.status(201).json({ success: true, id });
  } catch (error) {
    console.error('❌ Admin Representative-Anlegen-Fehler:', error);
    res.status(500).json({ error: 'Bevollmächtigter konnte nicht angelegt werden.' });
  }
});

router.post('/representatives/:id/resend-invite', async (req, res) => {
  try {
    const rep = db.prepare('SELECT id, email, name FROM representatives WHERE id = ?').get(req.params.id);
    if (!rep) return res.status(404).json({ error: 'Bevollmächtigter nicht gefunden.' });

    await issueRepInvite(rep.id, rep.email, rep.name);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Admin Representative-Invite-Erneut-Fehler:', error);
    res.status(500).json({ error: 'Einladung konnte nicht erneut verschickt werden.' });
  }
});

router.patch('/representatives/:id', (req, res) => {
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ error: '"active" (true/false) ist erforderlich.' });
  }
  try {
    const result = db.prepare('UPDATE representatives SET active = ? WHERE id = ?')
      .run(req.body.active ? 1 : 0, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Bevollmächtigter nicht gefunden.' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Admin Representative-Update-Fehler:', error);
    res.status(500).json({ error: 'Bevollmächtigter konnte nicht aktualisiert werden.' });
  }
});

router.get('/representatives/:id/assignments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.customer_number, c.company_name, c.email, rca.created_at as assigned_at
      FROM representative_customer_assignments rca
      JOIN customers c ON c.id = rca.customer_id
      WHERE rca.representative_id = ?
      ORDER BY c.company_name
    `).all(req.params.id);
    res.json(rows);
  } catch (error) {
    console.error('❌ Admin Representative-Assignments-Fehler:', error);
    res.status(500).json({ error: 'Zuweisungen konnten nicht geladen werden.' });
  }
});

router.post('/representatives/:id/assignments', (req, res) => {
  const customerId = Number(req.body?.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: '"customer_id" ist erforderlich.' });
  }
  try {
    const rep = db.prepare('SELECT id FROM representatives WHERE id = ?').get(req.params.id);
    if (!rep) return res.status(404).json({ error: 'Bevollmächtigter nicht gefunden.' });
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden.' });

    db.prepare(`
      INSERT OR IGNORE INTO representative_customer_assignments (representative_id, customer_id, assigned_by)
      VALUES (?, ?, ?)
    `).run(req.params.id, customerId, 'admin');

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('❌ Admin Representative-Assignment-Anlegen-Fehler:', error);
    res.status(500).json({ error: 'Zuweisung konnte nicht angelegt werden.' });
  }
});

router.delete('/representatives/:id/assignments/:customerId', (req, res) => {
  try {
    const result = db.prepare(`
      DELETE FROM representative_customer_assignments
      WHERE representative_id = ? AND customer_id = ?
    `).run(req.params.id, req.params.customerId);
    if (result.changes === 0) return res.status(404).json({ error: 'Zuweisung nicht gefunden.' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Admin Representative-Assignment-Löschen-Fehler:', error);
    res.status(500).json({ error: 'Zuweisung konnte nicht entfernt werden.' });
  }
});

router.get('/representatives/:id/access-log', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ral.id, ral.action, ral.ip_address, ral.created_at,
             c.company_name, c.customer_number
      FROM representative_access_log ral
      LEFT JOIN customers c ON c.id = ral.customer_id
      WHERE ral.representative_id = ?
      ORDER BY ral.created_at DESC
      LIMIT 200
    `).all(req.params.id);
    res.json(rows);
  } catch (error) {
    console.error('❌ Admin Representative-Access-Log-Fehler:', error);
    res.status(500).json({ error: 'Zugriffs-Protokoll konnte nicht geladen werden.' });
  }
});

// ============================================================
// BEVOLLMÄCHTIGTEN-ANFRAGEN (vom Kunden beim Land-Aktivieren angegeben)
//
// "matched"/auto-verbundene Anfragen entstehen automatisch (siehe
// syncCustomerRepresentativeRequest in routes/representatives.js) und
// brauchen hier keine Aktion mehr - dieser Bereich ist vor allem für
// "pending": eine dem System unbekannte E-Mail, die erst ein Admin
// bestätigen muss, bevor überhaupt eine Einladung rausgeht.
// ============================================================

router.get('/representative-requests', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT rr.id, rr.country_code, rr.stream, rr.requested_email, rr.status, rr.created_at, rr.updated_at,
             c.id as customer_id, c.company_name, c.customer_number,
             a.representative_name, a.representative_company,
             r.id as matched_representative_id, r.name as matched_representative_name
      FROM customer_representative_requests rr
      JOIN customers c ON c.id = rr.customer_id
      LEFT JOIN activations a ON a.customer_id = rr.customer_id AND a.country_code = rr.country_code AND a.stream = rr.stream
      LEFT JOIN representatives r ON r.id = rr.representative_id
      ORDER BY rr.status = 'pending' DESC, rr.created_at DESC
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('❌ Admin Representative-Requests-Fehler:', error);
    res.status(500).json({ error: 'Anfragen konnten nicht geladen werden.' });
  }
});

router.post('/representative-requests/:id/approve', async (req, res) => {
  try {
    const request = db.prepare(`
      SELECT rr.*, a.representative_name, a.representative_company
      FROM customer_representative_requests rr
      LEFT JOIN activations a ON a.customer_id = rr.customer_id AND a.country_code = rr.country_code AND a.stream = rr.stream
      WHERE rr.id = ?
    `).get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'Anfrage wurde bereits bearbeitet.' });

    let repId;
    const existingRep = db.prepare('SELECT id FROM representatives WHERE email = ? AND stream = ?').get(request.requested_email, request.stream);

    if (existingRep) {
      repId = existingRep.id;
    } else {
      const name = String(req.body?.name || request.representative_name || '').trim() || request.requested_email;
      const company = req.body?.company ? String(req.body.company).trim() : (request.representative_company || null);
      repId = await createAndInviteRepresentative({
        countryCode: request.country_code,
        name,
        email: request.requested_email,
        company,
        stream: request.stream
      });
    }

    db.prepare(`
      INSERT OR IGNORE INTO representative_customer_assignments (representative_id, customer_id, assigned_by)
      VALUES (?, ?, 'admin')
    `).run(repId, request.customer_id);

    db.prepare(`
      UPDATE customer_representative_requests
      SET status = 'matched', representative_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(repId, request.id);

    res.json({ success: true, representative_id: repId });
  } catch (error) {
    console.error('❌ Admin Representative-Request-Approve-Fehler:', error);
    res.status(500).json({ error: 'Anfrage konnte nicht genehmigt werden.' });
  }
});

router.post('/representative-requests/:id/reject', (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE customer_representative_requests
      SET status = 'rejected', updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Anfrage nicht gefunden oder bereits bearbeitet.' });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Admin Representative-Request-Reject-Fehler:', error);
    res.status(500).json({ error: 'Anfrage konnte nicht abgelehnt werden.' });
  }
});

// ============================================================
// WEEE-/BATTERIE-INTERESSE
//
// Wie viele Kunden nutzen bereits WEEE oder Batterie (mind. ein
// aktiviertes Land in diesem Strom) und - besonders wichtig - wie viele
// davon haben GAR KEINE Verpackungs-Aktivierung, sind also potenziell
// nur wegen WEEE/Batterie bei Pack2EU. Beantwortet "lohnt sich WEEE/
// Batterie als eigenständiges Verkaufsargument, unabhängig von
// Verpackung?", nicht nur "wird die neue Sparte überhaupt genutzt?".
// Aktivierungen sind das stärkste verfügbare Interesse-Signal (echte
// Nutzung statt nur eines Seitenaufrufs). Zusätzlich zählt
// declaredInterest die Selbstauskunft aus dem Onboarding-Checkbox
// (customers.weee_battery_interest_declared) - ein FRÜHERES Signal, das
// auch Kunden erfasst, die die neue Sparte im Dashboard noch nicht
// tatsächlich genutzt haben.
// ============================================================
router.get('/weee-battery-interest', (req, res) => {
  try {
    const declaredInterest = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE weee_battery_interest_declared = 1
    `).get().count;

    const rows = db.prepare(`
      SELECT customer_id, stream, COUNT(*) as country_count
      FROM activations
      GROUP BY customer_id, stream
    `).all();

    const byCustomer = {};
    rows.forEach(r => {
      if (!byCustomer[r.customer_id]) byCustomer[r.customer_id] = {};
      byCustomer[r.customer_id][r.stream] = r.country_count;
    });

    let weeeCustomers = 0, batteryCustomers = 0, weeeCountries = 0, batteryCountries = 0;
    let onlyWeee = 0, onlyBattery = 0, bothNoPackaging = 0, totalWithWeeeOrBattery = 0;

    Object.values(byCustomer).forEach(streams => {
      const hasWeee = !!streams.weee;
      const hasBattery = !!streams.battery;
      const hasPackaging = !!streams.packaging;

      if (hasWeee) { weeeCustomers++; weeeCountries += streams.weee; }
      if (hasBattery) { batteryCustomers++; batteryCountries += streams.battery; }
      if (!hasWeee && !hasBattery) return;

      totalWithWeeeOrBattery++;
      if (hasPackaging) return;

      if (hasWeee && hasBattery) bothNoPackaging++;
      else if (hasWeee) onlyWeee++;
      else onlyBattery++;
    });

    res.json({
      declaredInterest,
      totalWithWeeeOrBattery,
      weee: { customers: weeeCustomers, countries: weeeCountries },
      battery: { customers: batteryCustomers, countries: batteryCountries },
      onlyWeeeBatteryNoPackaging: {
        total: onlyWeee + onlyBattery + bothNoPackaging,
        onlyWeee,
        onlyBattery,
        both: bothNoPackaging
      }
    });
  } catch (error) {
    console.error('❌ WEEE-/Batterie-Interesse-Fehler:', error);
    res.status(500).json({ error: 'WEEE-/Batterie-Auswertung konnte nicht geladen werden.' });
  }
});

// ============================================================
// MATERIAL-LIZENZSÄTZE (Richtwerte für den Material-Spar-Rechner,
// siehe lib/material-savings.js und Kommentar in db/schema.sql -
// KEINE recherchierten/verifizierten Sätze, editierbar, damit Kunden
// ihre echten Vertragskonditionen eintragen können)
// ============================================================
router.get('/material-rates', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, material, subtype, price_per_kg_eur, source, updated_at
      FROM material_license_rates
      ORDER BY material, subtype IS NOT NULL, subtype
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Material-Lizenzsätze:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Lizenzsätze.' });
  }
});

router.put('/material-rates/:id', (req, res) => {
  try {
    const price = Number(req.body.price_per_kg_eur);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Ungültiger Preis pro kg.' });
    }

    const existing = db.prepare('SELECT id FROM material_license_rates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Lizenzsatz nicht gefunden.' });

    db.prepare(`
      UPDATE material_license_rates
      SET price_per_kg_eur = ?, source = 'admin', updated_at = datetime('now')
      WHERE id = ?
    `).run(price, req.params.id);

    const updated = db.prepare('SELECT id, material, subtype, price_per_kg_eur, source, updated_at FROM material_license_rates WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Aktualisieren des Material-Lizenzsatzes:', error);
    res.status(500).json({ error: 'Lizenzsatz konnte nicht aktualisiert werden.' });
  }
});

// ============================================================
// LÄNDER-BEVOLLMÄCHTIGTE (Kandidaten aus der Recherche in echte
// representatives-Accounts überführen)
//
// countries.representative_provider_name/url/data_status sind reine
// Referenzdaten (recherchierte Kandidaten, siehe db/index.js-Kommentar
// zu material_license_rates-Konvention: 'needs_verification', kein
// Rechtstext). Erst wenn hier zusätzlich eine echte E-Mail hinterlegt
// und "Einladen" geklickt wird, entsteht daraus ein echter
// representatives-Account mit Login/2FA (createAndInviteRepresentative(),
// siehe oben) - die Kunden-Zuordnung läuft danach ganz normal über die
// bestehende Bevollmächtigte-Verwaltung/Anfragen-Queue.
// ============================================================
router.get('/countries', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT code, name, flag, register_body, registration_url,
             representative_provider_name, representative_provider_url,
             representative_provider_email, representative_data_status
      FROM countries
      ORDER BY name
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('❌ Fehler beim Laden der Länder:', error);
    res.status(500).json({ error: 'Länder konnten nicht geladen werden.' });
  }
});

router.put('/countries/:code/representative', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const existing = db.prepare('SELECT code FROM countries WHERE code = ?').get(code);
    if (!existing) return res.status(404).json({ error: 'Land nicht gefunden.' });

    const name = req.body.representative_provider_name != null ? String(req.body.representative_provider_name).trim() || null : undefined;
    const url = req.body.representative_provider_url != null ? String(req.body.representative_provider_url).trim() || null : undefined;
    const email = req.body.representative_provider_email != null ? String(req.body.representative_provider_email).trim().toLowerCase() || null : undefined;

    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('representative_provider_name = ?'); values.push(name); }
    if (url !== undefined) { fields.push('representative_provider_url = ?'); values.push(url); }
    if (email !== undefined) { fields.push('representative_provider_email = ?'); values.push(email); }
    if (fields.length === 0) return res.status(400).json({ error: 'Keine Änderung übergeben.' });

    db.prepare(`UPDATE countries SET ${fields.join(', ')} WHERE code = ?`).run(...values, code);

    const updated = db.prepare(`
      SELECT code, name, representative_provider_name, representative_provider_url,
             representative_provider_email, representative_data_status
      FROM countries WHERE code = ?
    `).get(code);
    res.json(updated);
  } catch (error) {
    console.error('❌ Fehler beim Aktualisieren des Länder-Bevollmächtigten:', error);
    res.status(500).json({ error: 'Konnte nicht gespeichert werden.' });
  }
});

router.post('/countries/:code/invite-representative', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const country = db.prepare('SELECT code, name, representative_provider_name, representative_provider_email FROM countries WHERE code = ?').get(code);
    if (!country) return res.status(404).json({ error: 'Land nicht gefunden.' });

    if (!country.representative_provider_email) {
      return res.status(400).json({ error: 'Für dieses Land ist noch keine E-Mail-Adresse hinterlegt.' });
    }
    if (!country.representative_provider_name) {
      return res.status(400).json({ error: 'Für dieses Land ist noch kein Anbieter-Name hinterlegt.' });
    }

    const existingRep = db.prepare('SELECT id FROM representatives WHERE email = ?').get(country.representative_provider_email);
    if (existingRep) {
      return res.status(409).json({ error: 'Diese E-Mail ist bereits als Bevollmächtigter registriert.', representativeId: existingRep.id });
    }

    const id = await createAndInviteRepresentative({
      countryCode: code,
      name: country.representative_provider_name,
      email: country.representative_provider_email,
      company: country.representative_provider_name,
      stream: 'packaging'
    });
    res.status(201).json({ success: true, id });
  } catch (error) {
    console.error('❌ Fehler beim Einladen des Länder-Bevollmächtigten:', error);
    res.status(500).json({ error: 'Einladung konnte nicht verschickt werden.' });
  }
});

// ============================================================
// HERKUNFT → ZIELLAND-MUSTER (fürs gezielte Ansprechen im Vertrieb:
// "Spanische Shops aktivieren meistens DE+IT" statt nur "Kunde kommt
// aus Spanien"). Zählt reale Aktivierungen je (Herkunftsland,
// Zielland)-Paar, Herkunft==Ziel ausgeschlossen (kein "Inland"-Rauschen).
// ============================================================
router.get('/origin-destination-patterns', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.origin_country as origin, a.country_code as destination, COUNT(DISTINCT a.customer_id) as customerCount
      FROM activations a
      JOIN customers c ON c.id = a.customer_id
      WHERE c.origin_country IS NOT NULL AND c.origin_country != a.country_code
      GROUP BY c.origin_country, a.country_code
    `).all();

    const originTotals = db.prepare(`
      SELECT origin_country as origin, COUNT(*) as customerCount
      FROM customers
      WHERE origin_country IS NOT NULL
      GROUP BY origin_country
    `).all();

    const byOrigin = {};
    rows.forEach(r => {
      if (!byOrigin[r.origin]) byOrigin[r.origin] = [];
      byOrigin[r.origin].push({ destination: r.destination, customerCount: r.customerCount });
    });

    const totalsByOrigin = Object.fromEntries(originTotals.map(o => [o.origin, o.customerCount]));

    const patterns = Object.entries(byOrigin).map(([origin, destinations]) => ({
      origin,
      totalCustomersFromOrigin: totalsByOrigin[origin] || 0,
      topDestinations: destinations.sort((a, b) => b.customerCount - a.customerCount).slice(0, 5)
    })).sort((a, b) => b.totalCustomersFromOrigin - a.totalCustomersFromOrigin);

    res.json(patterns);
  } catch (error) {
    console.error('❌ Fehler bei Herkunft-Ziel-Auswertung:', error);
    res.status(500).json({ error: 'Auswertung konnte nicht geladen werden.' });
  }
});

module.exports = router;
