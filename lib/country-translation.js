// lib/country-translation.js
//
// Gemeinsame Helper für routes/countries.js und routes/activations.js:
// die Länder-Rechtstexte (register_body, eco_fee, requirements, labeling,
// notary_cost) liegen NUR auf Deutsch in countries/country_stream_rules -
// wenn scripts/translate-country-legal-text.js bereits gelaufen ist, steht
// in der translations_json-Spalte zusätzlich
// {"en":{...},"fr":{...},"it":{...},"es":{...}}. Diese Funktionen
// übersteuern die deutschen Basiswerte damit, wenn eine unterstützte
// Sprache angefragt UND für dieses Land bereits übersetzt wurde - sonst
// bleibt es beim deutschen Original (nie ein kaputtes UI wegen fehlender
// Übersetzung).
const SUPPORTED_TRANSLATION_LANGS = ['en', 'fr', 'it', 'es'];

function parseLang(rawLang) {
  const lang = String(rawLang || '').toLowerCase();
  return SUPPORTED_TRANSLATION_LANGS.includes(lang) ? lang : null;
}

function applyTranslation(fields, translationsJson, lang) {
  if (!lang || !translationsJson) return fields;
  let translations;
  try {
    translations = JSON.parse(translationsJson);
  } catch (e) {
    return fields;
  }
  const t = translations?.[lang];
  if (!t) return fields;
  return {
    ...fields,
    register_body: t.register_body || fields.register_body,
    eco_fee: t.eco_fee || fields.eco_fee,
    requirements: Array.isArray(t.requirements) && fields.requirements && t.requirements.length === fields.requirements.length
      ? t.requirements
      : fields.requirements,
    labeling: Array.isArray(t.labeling) && fields.labeling && t.labeling.length === fields.labeling.length
      ? t.labeling
      : fields.labeling,
    notary_cost: t.notary_cost || fields.notary_cost
  };
}

module.exports = { SUPPORTED_TRANSLATION_LANGS, parseLang, applyTranslation };
