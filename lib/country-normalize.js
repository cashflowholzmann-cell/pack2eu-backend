// lib/country-normalize.js
//
// Normalisiert Zielland-Angaben aus Marktplatz-/Shop-Sync-Quellen
// (Base/BaseLinker, Shopify, manuelle Eingabe) auf einen einheitlichen
// ISO-3166-1-Alpha-2-Code. Ohne das landet z.B. "Italy" (BaseLinker
// delivery_country als Klartext) als eigener Report-Bucket neben "IT"
// (delivery_country_code) - genau der im Jahresreport beobachtete Bug
// (getrennte Zeilen "IT" / "ITALY" / "SWEDEN" / "Unbekannt").
//
// Bewusst eine reine, synchrone Textzuordnung ohne DB-Zugriff - muss auch
// beim Sync selbst (kein await, kein zusätzlicher Query) und in Reports
// günstig aufrufbar sein.

const COUNTRY_NAME_TO_CODE = {
  // Deutschland
  'deutschland': 'DE', 'germany': 'DE', 'allemagne': 'DE', 'germania': 'DE', 'alemania': 'DE',
  // Österreich
  'österreich': 'AT', 'oesterreich': 'AT', 'austria': 'AT', 'autriche': 'AT', 'austria republic': 'AT',
  // Schweiz
  'schweiz': 'CH', 'switzerland': 'CH', 'suisse': 'CH', 'svizzera': 'CH', 'suiza': 'CH',
  // Belgien
  'belgien': 'BE', 'belgium': 'BE', 'belgique': 'BE', 'belgio': 'BE', 'bélgica': 'BE', 'belgica': 'BE',
  // Bulgarien
  'bulgarien': 'BG', 'bulgaria': 'BG', 'bulgarie': 'BG',
  // Kanada
  'kanada': 'CA', 'canada': 'CA',
  // China
  'china': 'CN', 'chine': 'CN', 'cina': 'CN',
  // Zypern
  'zypern': 'CY', 'cyprus': 'CY', 'chypre': 'CY', 'cipro': 'CY', 'chipre': 'CY',
  // Tschechien
  'tschechien': 'CZ', 'czech republic': 'CZ', 'czechia': 'CZ', 'république tchèque': 'CZ',
  'repubblica ceca': 'CZ', 'república checa': 'CZ',
  // Dänemark
  'dänemark': 'DK', 'daenemark': 'DK', 'denmark': 'DK', 'danemark': 'DK', 'danimarca': 'DK', 'dinamarca': 'DK',
  // Estland
  'estland': 'EE', 'estonia': 'EE', 'estonie': 'EE',
  // Spanien
  'spanien': 'ES', 'spain': 'ES', 'espagne': 'ES', 'spagna': 'ES', 'españa': 'ES', 'espana': 'ES',
  // Finnland
  'finnland': 'FI', 'finland': 'FI', 'finlande': 'FI', 'finlandia': 'FI',
  // Frankreich
  'frankreich': 'FR', 'france': 'FR', 'francia': 'FR',
  // Vereinigtes Königreich
  'vereinigtes königreich': 'GB', 'vereinigtes koenigreich': 'GB', 'united kingdom': 'GB', 'great britain': 'GB',
  'uk': 'GB', 'royaume-uni': 'GB', 'regno unito': 'GB', 'reino unido': 'GB', 'england': 'GB',
  // Griechenland
  'griechenland': 'GR', 'greece': 'GR', 'grèce': 'GR', 'grecia': 'GR',
  // Kroatien
  'kroatien': 'HR', 'croatia': 'HR', 'croatie': 'HR', 'croazia': 'HR',
  // Ungarn
  'ungarn': 'HU', 'hungary': 'HU', 'hongrie': 'HU', 'ungheria': 'HU', 'hungría': 'HU', 'hungria': 'HU',
  // Irland
  'irland': 'IE', 'ireland': 'IE', 'irlande': 'IE', 'irlanda': 'IE',
  // Indien
  'indien': 'IN', 'india': 'IN', 'inde': 'IN',
  // Island
  'island': 'IS', 'iceland': 'IS', 'islande': 'IS', 'islanda': 'IS', 'islandia': 'IS',
  // Italien
  'italien': 'IT', 'italy': 'IT', 'italie': 'IT', 'italia': 'IT',
  // Japan
  'japan': 'JP', 'japon': 'JP', 'giappone': 'JP',
  // Liechtenstein
  'liechtenstein': 'LI',
  // Litauen
  'litauen': 'LT', 'lithuania': 'LT', 'lituanie': 'LT', 'lituania': 'LT',
  // Luxemburg
  'luxemburg': 'LU', 'luxembourg': 'LU', 'lussemburgo': 'LU',
  // Lettland
  'lettland': 'LV', 'latvia': 'LV', 'lettonie': 'LV', 'lettonia': 'LV',
  // Malta
  'malta': 'MT',
  // Niederlande
  'niederlande': 'NL', 'netherlands': 'NL', 'pays-bas': 'NL', 'paesi bassi': 'NL', 'países bajos': 'NL',
  'paises bajos': 'NL', 'holland': 'NL',
  // Norwegen
  'norwegen': 'NO', 'norway': 'NO', 'norvège': 'NO', 'norvegia': 'NO', 'noruega': 'NO',
  // Polen
  'polen': 'PL', 'poland': 'PL', 'pologne': 'PL', 'polonia': 'PL',
  // Portugal
  'portugal': 'PT',
  // Rumänien
  'rumänien': 'RO', 'ruaenien': 'RO', 'romania': 'RO', 'roumanie': 'RO', 'romania (rou)': 'RO',
  // Schweden
  'schweden': 'SE', 'sweden': 'SE', 'suède': 'SE', 'suede': 'SE', 'svezia': 'SE', 'suecia': 'SE',
  // Slowenien
  'slowenien': 'SI', 'slovenia': 'SI', 'slovénie': 'SI', 'slovenie': 'SI',
  // Slowakei
  'slowakei': 'SK', 'slovakia': 'SK', 'slovaquie': 'SK', 'slovacchia': 'SK', 'eslovaquia': 'SK',
  // Thailand
  'thailand': 'TH', 'thailande': 'TH', 'thaïlande': 'TH', 'tailandia': 'TH',
  // USA
  'usa': 'US', 'united states': 'US', 'united states of america': 'US', 'états-unis': 'US',
  'etats-unis': 'US', 'stati uniti': 'US', 'estados unidos': 'US',
  // Australien
  'australien': 'AU', 'australia': 'AU', 'australie': 'AU'
};

const VALID_ISO_CODES = new Set([
  'AT', 'AU', 'BE', 'BG', 'CA', 'CH', 'CN', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HR', 'HU', 'IE', 'IN', 'IS', 'IT', 'JP', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'TH', 'US'
]);

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Nimmt beliebig viele Roh-Werte entgegen (z.B. delivery_country_code UND
// delivery_country) und liefert den ersten, der sich sicher auf einen
// ISO-Code abbilden lässt - null, wenn keiner passt (führt bewusst zu
// "Unbekannt" statt einer stillschweigend falschen Zuordnung).
function normalizeCountryCode(...rawValues) {
  for (const raw of rawValues) {
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;

    const upper = trimmed.toUpperCase();
    if (upper.length === 2 && VALID_ISO_CODES.has(upper)) {
      return upper;
    }

    const key = stripDiacritics(trimmed.toLowerCase());
    if (COUNTRY_NAME_TO_CODE[key]) {
      return COUNTRY_NAME_TO_CODE[key];
    }
  }
  return null;
}

module.exports = { normalizeCountryCode, VALID_ISO_CODES };
