// lib/baselinker-scheduler.js
//
// Automatischer Hintergrund-Sync für Base.com-Bestellungen. Bisher musste
// jeder Kunde selbst auf den "🔄 Sync"-Button im Dashboard klicken
// (routes/baselinker.js, POST /sync) - neue Bestellungen wurden sonst nie
// automatisch abgeholt. Dieser Scheduler ruft dieselbe Sync-Funktion
// periodisch für alle Kunden mit hinterlegtem Base.com-API-Token auf.

const { db } = require('../db');
const { syncBaselinkerOrdersForCustomer } = require('../routes/baselinker');

const SYNC_INTERVAL_MS = 20 * 60 * 1000; // alle 20 Minuten

async function runBaselinkerAutoSync() {
  const customers = db.prepare(`
    SELECT *
    FROM customers
    WHERE baselinker_api_token IS NOT NULL
  `).all();

  for (const customer of customers) {
    try {
      const result = await syncBaselinkerOrdersForCustomer(customer);
      if (result.imported > 0) {
        console.log(
          `🔄 Base.com Auto-Sync Kunde ${customer.id}: ${result.imported} neue Bestellung(en) importiert.`
        );
      }
    } catch (err) {
      // Ein fehlgeschlagener Kunde (z.B. ungültiger/widerrufener API-Token)
      // darf den Sync für alle anderen Kunden nicht abbrechen.
      console.error(
        `❌ Base.com Auto-Sync Fehler bei Kunde ${customer.id}:`,
        err.response?.data || err.message
      );
    }
  }
}

function startBaselinkerAutoSync() {
  setInterval(() => {
    runBaselinkerAutoSync().catch((err) => {
      console.error('❌ Base.com Auto-Sync (Durchlauf) Fehler:', err.message);
    });
  }, SYNC_INTERVAL_MS);

  console.log(
    `🔄 Base.com Auto-Sync aktiv (alle ${SYNC_INTERVAL_MS / 60000} Minuten).`
  );
}

module.exports = { startBaselinkerAutoSync, runBaselinkerAutoSync };
