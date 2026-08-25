// ============================================================
// PACK2EU – ZENTRALE COMPLIANCE ENGINE
// ============================================================
//
// Grundregel:
//
// 1. Nur eine explizit verifizierte Regel darf "verified" sein.
// 2. Keine Regel = needs_review.
// 3. needs_review darf niemals automatisch grün werden.
// 4. Die tatsächliche Bevollmächtigtenpflicht kommt aus
//    compliance_rules und NICHT aus einer pauschalen EU-Regel.
// ============================================================


const EU_CODES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK'
]);


// ============================================================
// NORMALISIERUNG
// ============================================================

function normalizeCode(code) {

  return String(
    code || ''
  )
    .trim()
    .toUpperCase();
}


// ============================================================
// EU-LAND?
// ============================================================

function isEUCountry(code) {

  return EU_CODES.has(
    normalizeCode(code)
  );
}


// ============================================================
// COMPLIANCE ENTSCHEIDUNG
// ============================================================

function decide({
  originCountry,
  destinationCountry,
  rule,
  destinationMeta
}) {

  const origin =
    normalizeCode(originCountry);

  const destination =
    normalizeCode(destinationCountry);

  const originEU =
    isEUCountry(origin);


  // ----------------------------------------------------------
  // Zielland existiert nicht
  // ----------------------------------------------------------

  if (!destinationMeta) {

    return {

      status: 'unsupported',

      registrationRequired: false,

      representativeRequired: false,

      notaryRequired: false,

      legalLabel:
        'Zielland nicht unterstützt',

      explanation:
        'Das Zielland wurde nicht in der Pack2EU-Länderdatenbank gefunden.',

      legalBasis: '',

      confidence:
        'unsupported',

      policyVersion:
        '',

      sourceUrl:
        '',

      sourceType:
        'internal',

      providerAvailable:
        false,

      providerId:
        null,

      providerCostEur:
        null,

      originEU,

      originCountry:
        origin,

      destinationCountry:
        destination
    };
  }


  // ----------------------------------------------------------
  // VERIFIZIERTE REGEL
  // ----------------------------------------------------------

  if (rule) {

    const confidence =
      rule.confidence ||
      'needs_review';


    const registrationRequired =
      Number(
        rule.registration_required
      ) === 1;


    const representativeRequired =
      Number(
        rule.representative_required
      ) === 1;


    const notaryRequired =
      Number(
        rule.notary_required
      ) === 1;


    return {

      status:
        rule.status ||
        'needs_review',

      registrationRequired,

      representativeRequired,

      notaryRequired,

      legalLabel:
        rule.legal_label ||
        'Prüfung erforderlich',

      explanation:
        rule.explanation ||
        '',

      legalBasis:
        rule.legal_basis ||
        '',

      confidence,

      policyVersion:
        rule.policy_version ||
        '',

      sourceUrl:
        rule.source_url ||
        '',

      sourceType:
        rule.source_type ||
        'internal',

      providerAvailable:
        Number(
          rule.provider_available
        ) === 1,

      providerId:
        rule.provider_id ||
        null,

      providerCostEur:
        rule.provider_cost_eur ??
        null,

      effectiveFrom:
        rule.effective_from ||
        null,

      originEU,

      originCountry:
        origin,

      destinationCountry:
        destination
    };
  }


  // ----------------------------------------------------------
  // KEINE VERIFIZIERTE REGEL
  // ----------------------------------------------------------
  //
  // Ganz wichtig:
  // NIEMALS automatisch "green".
  // ----------------------------------------------------------

  return {

    status:
      'needs_review',

    registrationRequired:
      true,

    representativeRequired:
      false,

    notaryRequired:
      false,

    legalLabel:
      'Nationale Regel wird geprüft',

    explanation:
      'Für dieses Länderpaar liegt bei Pack2EU noch keine verifizierte nationale Regel vor. Deshalb wird keine pauschale Bevollmächtigtenpflicht angenommen.',

    legalBasis:
      'Regulation (EU) 2025/40',

    confidence:
      'needs_national_rule',

    policyVersion:
      '2026-08-25',

    sourceUrl:
      'https://eur-lex.europa.eu/eli/reg/2025/40/oj',

    sourceType:
      'eu_regulation',

    providerAvailable:
      false,

    providerId:
      null,

    providerCostEur:
      null,

    effectiveFrom:
      null,

    originEU,

    originCountry:
      origin,

    destinationCountry:
      destination
  };
}


// ============================================================
// IST ENTSCHEIDUNG RECHTLICH VERIFIZIERT?
// ============================================================

function isVerifiedDecision(decision) {

  return Boolean(
    decision &&
    decision.confidence ===
      'primary_source_verified' &&
    decision.status !==
      'needs_review'
  );
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  EU_CODES,

  normalizeCode,

  isEUCountry,

  decide,

  isVerifiedDecision
};
