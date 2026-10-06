// lib/lang-by-country.js
//
// Grobe Sprachzuordnung anhand eines Länder-Codes - genutzt, um
// Bevollmächtigten (routes/admin.js) ohne eigenes Sprachfeld im
// Anlage-Formular trotzdem eine sinnvolle Standardsprache für Einladungs-/
// Login-Code-Mails zu geben (siehe representatives.preferred_lang).
// Deckt nur die 5 im Produkt unterstützten Sprachen ab (de/en/fr/it/es),
// alles andere fällt auf 'en' zurück (gleiche Konvention wie
// COMP_ACCESS_NEW_ACCOUNT_TEXT in lib/email.js).
const LANG_BY_COUNTRY = {
  DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr',
  IT: 'it',
  ES: 'es'
};

function langForCountry(countryCode) {
  return LANG_BY_COUNTRY[String(countryCode || '').toUpperCase()] || 'en';
}

module.exports = { langForCountry };
