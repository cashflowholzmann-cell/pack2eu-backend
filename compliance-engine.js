// ============================================================
// PACK2EU – COMPLIANCE ENGINE
// ============================================================
//
// WICHTIG:
// Keine verifizierte Länderregel = niemals automatisch grün.
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
// LANDESCODE NORMALISIEREN
// ============================================================

function normalizeCode(code) {

  return String(code || '')
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
  // LAND NICHT VORHANDEN
  // ----------------------------------------------------------

  if (!destinationMeta) {

    return {
      status: 'unsupported',

      registrationRequired: false,

      representativeRequired: false,

      notaryRequired: false,

      confidence: 'unsupported',

      originCountry: origin,

      destinationCountry: destination
    };

  }


  // ----------------------------------------------------------
  // VERIFIZIERTE REGEL VORHANDEN
  // ----------------------------------------------------------

  if (rule) {

    return {

      status:
        rule.status ||
        'needs_review',

      registrationRequired:
        Number(rule.registration_required) === 1,

      representativeRequired:
        Number(rule.representative_required) === 1,

      notaryRequired:
        Number(rule.notary_required) === 1,

      legalLabel:
        rule.legal_label ||
        'Prüfung erforderlich',

      explanation:
        rule.explanation ||
        '',

      legalBasis:
        rule.legal_basis ||
        '',

      confidence:
        rule.confidence ||
        'needs_review',

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
        Number(rule.provider_available) === 1,

      providerId:
        rule.provider_id ||
        null,

      providerCostEur:
        rule.provider_cost_eur ??
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
  //
  // NIEMALS GRÜN
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
      'Für dieses Länderpaar liegt in Pack2EU noch keine verifizierte nationale Regel vor. Pack2EU zeigt deshalb bewusst keine pauschale Rechtssicherheit an.',

    legalBasis:
      'EU baseline: Regulation (EU) 2025/40',

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

    originEU,

    originCountry:
      origin,

    destinationCountry:
      destination
  };

}


// ============================================================
// VERIFIZIERTE ENTSCHEIDUNG?
// ============================================================

function isVerifiedDecision(decision) {

  return !!decision &&
    decision.confidence ===
      'primary_source_verified' &&
    decision.status !==
      'needs_review';

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
