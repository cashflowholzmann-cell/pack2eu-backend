// ================================================================
// PLAN-GRENZEN (S / M / L)
//
// Zentrale Quelle der Wahrheit für Gewichtskontingent und maximale
// Anzahl gleichzeitig aktivierbarer Länder je Plan. Wird sowohl bei der
// Aktivierungs-Prüfung (routes/activations.js) als auch für die im
// Dashboard angezeigten Werte verwendet.
//
// weightQuotaKg / maxCountries = null bedeutet "unbegrenzt" (Enterprise).
// ================================================================

const PLAN_LIMITS = {
  S: { weightQuotaKg: 250,  maxCountries: 2 },
  M: { weightQuotaKg: 1000, maxCountries: 10 },
  L: { weightQuotaKg: null, maxCountries: null }
};

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.M;
}

// ================================================================
// KOSTENLOSER BEVOLLMÄCHTIGTER (DE und/oder ES) ALS TREUE-BONUS
//
// Nur für DE (REP-Germany) und ES (Heura) - unsere beiden Partner mit
// bekannter (wenn auch noch nicht final bestätigter) Preisstruktur.
// Bewusst NICHT "ein Bevollmächtigter nach freier Wahl" für JEDES Land -
// das wäre eine unkalkulierbare Kostenzusage.
//
// Anzahl geschenkter Bevollmächtigter je nach Plan + Zahlweise:
//   S            -> 0 (kein Bonus)
//   M monatlich   -> 0
//   M jährlich    -> 1 (DE ODER ES, Kundenwahl)
//   L monatlich   -> 1 (DE ODER ES, Kundenwahl)
//   L jährlich    -> 2 (DE UND ES)
// ================================================================

const REP_ENTITLEMENT_COUNTRIES = ['DE', 'ES'];

function getRepEntitlementCount(plan, billingInterval) {
  if (plan === 'M' && billingInterval === 'annual') return 1;
  if (plan === 'L' && billingInterval === 'monthly') return 1;
  if (plan === 'L' && billingInterval === 'annual') return 2;
  return 0;
}

module.exports = {
  PLAN_LIMITS,
  getPlanLimits,
  REP_ENTITLEMENT_COUNTRIES,
  getRepEntitlementCount
};
