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
