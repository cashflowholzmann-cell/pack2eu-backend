// lib/sales-followup.js
//
// Vertriebs-Follow-up-Mail an Kunden, die sich registriert, aber 24
// Stunden später immer noch keinen Plan bezahlt haben. Existierte bisher
// nur als Idee, nie als Code (Audit-Fund) - kein Cron-Dienst nötig, ein
// einfacher stündlicher Check reicht, siehe startSalesFollowupScheduler()
// in server.js. Bewusst konservativ:
//   - nur EINMAL pro Kunde (sales_followup_sent_at verhindert Wiederholung)
//   - nur Konten aus den letzten 14 Tagen (verhindert einen Massenversand
//     an alte Karteileichen beim ersten Deploy dieser Funktion)
//   - Geschenk-/Test-Zugänge (comp_account_note gesetzt) werden
//     ausgeschlossen - denen eine Vertriebsmail zu schicken wäre falsch
//   - Konten, die schon einmal ein Stripe-Abo hatten, werden ausgeschlossen
//     (auch wenn es zwischenzeitlich gekündigt wurde) - das ist kein
//     Erstkontakt-Fall mehr, dafür braucht es andere Kommunikation
const { db } = require('../db');
const { sendSalesFollowupEmail, isEmailConfigured } = require('./email');

async function runSalesFollowupCheck() {
  if (!isEmailConfigured()) return;

  const candidates = db.prepare(`
    SELECT id, email, contact_name
    FROM customers
    WHERE subscription_status != 'active'
      AND stripe_subscription_id IS NULL
      AND comp_account_note IS NULL
      AND sales_followup_sent_at IS NULL
      AND created_at <= datetime('now', '-24 hours')
      AND created_at >= datetime('now', '-14 days')
  `).all();

  for (const customer of candidates) {
    try {
      const result = await sendSalesFollowupEmail(customer.email, customer.contact_name);
      if (result.sent) {
        db.prepare(`UPDATE customers SET sales_followup_sent_at = datetime('now') WHERE id = ?`).run(customer.id);
        console.log(`✅ Vertriebs-Follow-up-Mail verschickt an Kunde ${customer.id} (${customer.email})`);
      }
    } catch (err) {
      console.error(`❌ Vertriebs-Follow-up-Mail an Kunde ${customer.id} fehlgeschlagen:`, err.message);
    }
  }
}

// Stündlicher Check reicht für eine 24h-Frist völlig aus (Versand-Zeitpunkt
// liegt dann zwischen 24h und 25h nach Registrierung) - kein externer
// Cron-Dienst nötig, läuft einfach im selben Prozess mit.
function startSalesFollowupScheduler() {
  runSalesFollowupCheck().catch(err => console.error('❌ Vertriebs-Follow-up-Check fehlgeschlagen:', err.message));
  setInterval(() => {
    runSalesFollowupCheck().catch(err => console.error('❌ Vertriebs-Follow-up-Check fehlgeschlagen:', err.message));
  }, 60 * 60 * 1000);
}

module.exports = { runSalesFollowupCheck, startSalesFollowupScheduler };
