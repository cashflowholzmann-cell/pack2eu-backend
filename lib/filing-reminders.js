// lib/filing-reminders.js
//
// Fristen-Erinnerung per E-Mail (Kundenwunsch 10/2026, Brainstorming
// "nutzerfreundlicher"): einmal pro Frist eine Mail, sobald eine
// Verpackungsmeldung für ein aktiviertes Land in höchstens
// REMINDER_DAYS_AHEAD Tagen fällig ist. Gleiche Fristlogik wie
// computeNextFilingDate() im Dashboard (next_filing_rule_json der Länder),
// gleiche Regel wie die "Als Nächstes zu tun"-Karte: keine Erinnerung,
// wenn für das Land in den letzten 30 Tagen schon eine Meldung abgegeben
// wurde. Bewusst konservativ:
//   - nur Kunden mit aktivem oder laufendem Probe-Abo
//   - Opt-out über customers.filing_reminders_enabled
//   - filing_reminders_sent (UNIQUE je Kunde/Land/Frist) verhindert
//     Doppelversand, auch nach Neustarts
//   - ohne SMTP-Konfiguration passiert gar nichts (kein Protokolleintrag,
//     damit die Erinnerung nach dem Einrichten noch kommt)
const { db } = require('../db');
const { sendFilingReminderEmail, isEmailConfigured } = require('./email');

const REMINDER_DAYS_AHEAD = 14;
const RECENT_SUBMISSION_DAYS = 30;
const DAY_MS = 86400000;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Port von computeNextFilingDate() aus dashboard.html - Regeltypen
// 'annual', 'fixed_dates' und 'periodic' (Monat/Quartal + Karenztage).
function computeNextFilingDate(rule, now = new Date()) {
  if (!rule || !rule.type) return null;
  const today = startOfDay(now);
  if (rule.type === 'annual') {
    let candidate = new Date(today.getFullYear(), rule.month - 1, rule.day);
    if (candidate < today) candidate = new Date(today.getFullYear() + 1, rule.month - 1, rule.day);
    return candidate;
  }
  if (rule.type === 'fixed_dates' && Array.isArray(rule.dates)) {
    let best = null;
    rule.dates.forEach(d => {
      let candidate = new Date(today.getFullYear(), d.month - 1, d.day);
      if (candidate < today) candidate = new Date(today.getFullYear() + 1, d.month - 1, d.day);
      if (!best || candidate < best) best = candidate;
    });
    return best;
  }
  if (rule.type === 'periodic') {
    const periodMonths = rule.period === 'quarter' ? 3 : 1;
    const baseMonth = today.getMonth();
    const anchor = rule.period === 'quarter' ? Math.floor(baseMonth / periodMonths) * periodMonths + (periodMonths - 1) : baseMonth;
    let best = null;
    for (let offset = -2; offset <= 3; offset++) {
      const periodEnd = new Date(today.getFullYear(), anchor + offset * periodMonths + 1, 0);
      const deadline = new Date(periodEnd);
      deadline.setDate(deadline.getDate() + (rule.offsetDays || 0));
      if (deadline >= today && (!best || deadline < best)) best = deadline;
    }
    return best;
  }
  return null;
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Liefert je Kunde die fälligen, noch nicht erinnerten Fristen - getrennt
// vom Versand, damit es ohne SMTP testbar bleibt.
function findDueReminders(now = new Date()) {
  const today = startOfDay(now);
  const rows = db.prepare(`
    SELECT c.id AS customer_id, c.email, c.contact_name, c.preferred_lang,
           a.country_code, co.name AS country_name, co.next_filing_rule_json, co.reporting_frequency
    FROM customers c
    JOIN activations a ON a.customer_id = c.id
    JOIN countries co ON co.code = a.country_code
    WHERE c.subscription_status IN ('active', 'trialing')
      AND COALESCE(c.filing_reminders_enabled, 1) = 1
      AND a.status != 'inactive'
      AND COALESCE(a.stream, 'packaging') = 'packaging'
      AND co.next_filing_rule_json IS NOT NULL
  `).all();
  const recentSubmission = db.prepare(`
    SELECT 1 FROM submissions
    WHERE customer_id = ? AND destination = ? AND COALESCE(stream, 'packaging') = 'packaging'
      AND created_at >= datetime('now', ?)
    LIMIT 1
  `);
  const alreadySent = db.prepare('SELECT 1 FROM filing_reminders_sent WHERE customer_id = ? AND country_code = ? AND deadline = ?');

  const byCustomer = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (r.reporting_frequency === 'not_applicable') continue;
    const key = r.customer_id + '|' + r.country_code;
    if (seen.has(key)) continue;
    seen.add(key);
    let rule;
    try { rule = JSON.parse(r.next_filing_rule_json); } catch (e) { continue; }
    const deadline = computeNextFilingDate(rule, now);
    if (!deadline) continue;
    const days = Math.round((deadline - today) / DAY_MS);
    if (days < 0 || days > REMINDER_DAYS_AHEAD) continue;
    const deadlineIso = isoDate(deadline);
    if (alreadySent.get(r.customer_id, r.country_code, deadlineIso)) continue;
    if (recentSubmission.get(r.customer_id, r.country_code, `-${RECENT_SUBMISSION_DAYS} days`)) continue;
    if (!byCustomer.has(r.customer_id)) {
      byCustomer.set(r.customer_id, { customerId: r.customer_id, email: r.email, contactName: r.contact_name, lang: r.preferred_lang || 'de', items: [] });
    }
    byCustomer.get(r.customer_id).items.push({ countryCode: r.country_code, countryName: r.country_name, deadline, deadlineIso });
  }
  return [...byCustomer.values()];
}

function countryLabel(code, fallback, lang) {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || fallback || code;
  } catch (e) {
    return fallback || code;
  }
}

async function runFilingReminderCheck(now = new Date()) {
  if (!isEmailConfigured()) return { sent: 0 };
  const markSent = db.prepare('INSERT OR IGNORE INTO filing_reminders_sent (customer_id, country_code, deadline) VALUES (?, ?, ?)');
  let sent = 0;
  for (const reminder of findDueReminders(now)) {
    const items = reminder.items
      .sort((a, b) => a.deadline - b.deadline)
      .map(it => ({ country: countryLabel(it.countryCode, it.countryName, reminder.lang), date: it.deadline.toLocaleDateString(reminder.lang, { day: '2-digit', month: '2-digit', year: 'numeric' }) }));
    try {
      const result = await sendFilingReminderEmail(reminder.email, reminder.contactName, items, reminder.lang);
      if (result.sent) {
        reminder.items.forEach(it => markSent.run(reminder.customerId, it.countryCode, it.deadlineIso));
        sent++;
        console.log(`✅ Fristen-Erinnerung an Kunde ${reminder.customerId} (${reminder.items.length} Land/Länder)`);
      }
    } catch (err) {
      console.error(`❌ Fristen-Erinnerung an Kunde ${reminder.customerId} fehlgeschlagen:`, err.message);
    }
  }
  return { sent };
}

// Stündlich wie lib/sales-followup.js - kein externer Cron nötig.
function startFilingReminderScheduler() {
  const run = () => runFilingReminderCheck().catch(err => console.error('❌ Fristen-Erinnerungs-Check fehlgeschlagen:', err.message));
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { computeNextFilingDate, findDueReminders, runFilingReminderCheck, startFilingReminderScheduler, REMINDER_DAYS_AHEAD };
