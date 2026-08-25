// ============================================================
// PACK2EU – ZENTRALE COMPLIANCE ENGINE
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
// CODE NORMALISIEREN
// ============================================================

function normalizeCode(code) {

  return String(
    code ?? ''
  )
    .trim()
    .toUpperCase();
}


// ============================================================
// EU LAND?
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
    normalizeCode(
      originCountry
    );

  const destination =
    normalizeCode(
      destinationCountry
    );

  const originEU =
    isEUCountry(origin);

  // A producer established outside the EU needs an EPR authorised
  // representative in every EU Member State where it first makes
  // packaging or packaged products available.
  const nonEURepresentativeRequired =
    !originEU &&
    isEUCountry(destination);


  // ----------------------------------------------------------
  // Zielland existiert nicht
  // ----------------------------------------------------------

  if (!destinationMeta) {

    return {

      status:
        'unsupported',

      registrationRequired:
        false,

      representativeRequired:
        false,

      notaryRequired:
        false,

      legalLabel:
        'Zielland nicht unterstützt',

      explanation:
        'Das Zielland wurde in der Pack2EU-Länderdatenbank nicht gefunden.',

      legalBasis:
        '',

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

      effectiveFrom:
        null,

      originEU,

      originCountry:
        origin,

      destinationCountry:
        destination

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
        Number(
          rule.registration_required
        ) === 1,

      representativeRequired:
        nonEURepresentativeRequired ||
        Number(rule.representative_required) === 1,

      notaryRequired:
        Number(
          rule.notary_required
        ) === 1,

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
  // Für EU-Händler wird ohne verifizierte Länderregel keine pauschale
  // Bevollmächtigtenpflicht behauptet. Bei Nicht-EU-Händlern und einem
  // EU-Zielland gilt die Pflicht jedoch unabhängig davon.
  // ----------------------------------------------------------

  return {

    status:
      'needs_review',

    registrationRequired:
      true,

    representativeRequired:
      nonEURepresentativeRequired,

    notaryRequired:
      false,

    legalLabel:
      'Nationale Regel wird geprüft',

    explanation:
      nonEURepresentativeRequired
        ? 'Als außerhalb der EU ansässiger Händler benötigen Sie für dieses EU-Zielland einen Bevollmächtigten für die erweiterte Herstellerverantwortung. Die weiteren nationalen Anforderungen werden noch geprüft.'
        : 'Für dieses Länderpaar liegt bei Pack2EU noch keine verifizierte nationale Regel vor. Deshalb wird keine pauschale Bevollmächtigtenpflicht angenommen.',

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
// ENTSCHEIDUNG VERIFIZIERT?
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
