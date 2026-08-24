// ============================================================
// PACK2EU – COMPLIANCE ENGINE
// ============================================================
//
// Zentrale Stelle für die Entscheidung:
//
// 1. Wo sitzt der Händler?
// 2. Wohin liefert er?
// 3. Ist das Herkunftsland EU?
// 4. Wird ein Bevollmächtigter benötigt?
// 5. Welcher Modus gilt?
//
// WICHTIG:
// Diese Engine bildet die technische Produktlogik ab.
// Sie ersetzt keine individuelle Rechtsberatung.
// Die tatsächlichen Länderanforderungen kommen aus
// der countries-Tabelle.
//

const EU_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE'
]);

function normalizeCountry(code) {
  if (!code) return null;

  return String(code)
    .trim()
    .toUpperCase();
}

function isEUCountry(code) {
  return EU_COUNTRIES.has(
    normalizeCountry(code)
  );
}

/**
 * Ermittelt den Compliance-Modus.
 *
 * EU-Händler:
 *   → Registrierung erforderlich
 *   → Bevollmächtigtenstatus kann je nach
 *     aktueller Länderregelung / Übergangslage
 *     gesondert dargestellt werden.
 *
 * Nicht-EU-Händler:
 *   → grundsätzlich Bevollmächtigtenprüfung
 *   → wenn das Zielland einen Bevollmächtigten
 *     verlangt, wird "representative_required"
 *
 * Die konkrete Länderinformation kommt aus der DB.
 */

function calculateCompliance({
  originCountry,
  destinationCountry,
  country
}) {
  const origin = normalizeCountry(originCountry);
  const destination = normalizeCountry(destinationCountry);

  if (!origin) {
    throw new Error('Herkunftsland fehlt.');
  }

  if (!destination) {
    throw new Error('Zielland fehlt.');
  }

  if (!country) {
    throw new Error(
      `Zielland ${destination} ist nicht in Pack2EU hinterlegt.`
    );
  }

  const originIsEU = isEUCountry(origin);

  const countryRequiresRepresentative =
    Number(country.representative_required) === 1;

  const countryRequiresNotary =
    Number(country.notary_required) === 1;

  // ----------------------------------------------------------
  // NICHT-EU-HÄNDLER
  // ----------------------------------------------------------

  if (!originIsEU) {
    return {
      origin_country: origin,
      destination_country: destination,

      origin_is_eu: false,

      status: countryRequiresRepresentative
        ? 'representative_required'
        : 'registration_required',

      mode: countryRequiresRepresentative
        ? 'premium'
        : 'registration',

      representative_required:
        countryRequiresRepresentative,

      notary_required:
        countryRequiresRepresentative &&
        countryRequiresNotary,

      color: countryRequiresRepresentative
        ? 'red'
        : 'orange',

      headline: countryRequiresRepresentative
        ? 'Bevollmächtigter erforderlich'
        : 'Registrierung erforderlich',

      message: countryRequiresRepresentative
        ? 'Dein Unternehmen sitzt außerhalb der EU. Für dieses Zielland benötigt Pack2EU einen Bevollmächtigten.'
        : 'Dein Unternehmen sitzt außerhalb der EU. Für dieses Zielland ist zunächst die Registrierung erforderlich.',

      action: countryRequiresRepresentative
        ? 'representative'
        : 'registration'
    };
  }

  // ----------------------------------------------------------
  // EU-HÄNDLER
  // ----------------------------------------------------------

  return {
    origin_country: origin,
    destination_country: destination,

    origin_is_eu: true,

    status: 'registration_required',

    // Für EU-Händler NICHT automatisch premium.
    mode: 'grauzone',

    representative_required:
      false,

    notary_required:
      false,

    color: 'orange',

    headline:
      'Registrierung erforderlich',

    message:
      'Dein Unternehmen sitzt in der EU. Pack2EU führt dich durch die Registrierung für dieses Zielland. Die aktuelle Einordnung des Bevollmächtigten wird dir transparent angezeigt.',

    action:
      'registration',

    // Technische Information für das Frontend
    // und spätere rechtliche Aktualisierungen.
    country_representative_rule:
      countryRequiresRepresentative
        ? 'country_data_requires_representative'
        : 'country_data_does_not_require_representative'
  };
}

module.exports = {
  EU_COUNTRIES,
  normalizeCountry,
  isEUCountry,
  calculateCompliance
};
