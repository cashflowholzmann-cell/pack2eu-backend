// lib/lucid-export.js
//
// XML-Export für die LUCID-Datenmeldung (§10 VerpackG) - Kundenwunsch
// ("ich dachte, das haben wir schon"), nachdem der Produkt-Audit ergeben
// hat, dass eine tatsächliche Behörden-Anbindung bei keinem Land
// existiert und bei LUCID auch technisch nicht als offene API angeboten
// wird (nur Web-Login + Datei-Upload). Dieses Modul erzeugt die exakte
// XML-Datei gemäß der offiziellen Anleitung der Zentralen Stelle
// Verpackungsregister ("Anleitung XML - Upload Datenmeldungen im
// Verpackungsregister LUCID", Version 1.3, Stand 12.08.26) - der Kunde
// muss die Datei danach selbst bei lucid.verpackungsregister.org
// hochladen (Login + "Datenmeldung" > "XML-Meldung"), das kann Pack2EU
// ihm nicht abnehmen (siehe oben).
//
// WICHTIG zur Sorgfalt: das ist eine rechtlich bindende Meldung - anders
// als bei der KI-Verpackungsschätzung (lib/packaging-estimate.js) gibt
// es hier kein "ungefähr richtig". Zwei reale Mehrdeutigkeiten in der
// eigenen Datenstruktur werden deshalb NICHT stillschweigend geraten,
// sondern als warnings zurückgegeben, die der Kunde vor dem Hochladen
// selbst auflösen muss:
//   1. "metall" unterscheidet sich bei LUCID in Eisenmetalle (30000) vs.
//      Aluminium (40000) - nur auflösbar, wenn am Material die subtype
//      'stahl' oder 'aluminium' hinterlegt ist (siehe dashboard.html,
//      METALL_SUBTYPES). Fehlt das, bleibt die Menge unklassifiziert.
//   2. "holz" hat in der offiziellen Materialarten-Tabelle gar keine
//      eigene LUCID-Systembeteiligungs-Kategorie (Transportverpackungen
//      aus Holz laufen typischerweise über eine andere Rücknahmepflicht,
//      nicht über die Systembeteiligung) - wird deshalb NIE automatisch
//      einer Kategorie zugeordnet, sondern immer als Warnung ausgegeben.

// ============================================================
// 2.3.4 Tabelle: Systembetreiber (Stand der Anleitung, Version 1.3)
// ============================================================
const SYSTEM_OPERATORS = [
  { id: 'DE6005779374130', name: 'Interzero Circular Solutions Germany GmbH' },
  { id: 'DE6005973594801', name: 'Reclay Systems GmbH' },
  { id: 'DE6006382012686', name: 'RKD Recycling Kontor Dual GmbH & Co. KG' },
  { id: 'DE6004919627351', name: 'Der Grüne Punkt – Duales System Deutschland GmbH' },
  { id: 'DE6005906579671', name: 'Landbell AG für Rückhol-Systeme' },
  { id: 'DE6005959764031', name: 'Noventiz Dual GmbH' },
  { id: 'DE6007094250999', name: 'Zentek GmbH & Co. KG' },
  { id: 'DE6007086225568', name: 'Veolia Umweltservice Dual GmbH' },
  { id: 'DE6007168805143', name: 'ELS Europäische LizenzierungsSysteme GmbH' },
  { id: 'DE6004738522858', name: 'BellandVision GmbH' },
  { id: 'DE6004844021815', name: 'PreZero Dual GmbH' },
  { id: 'DE6007780383579', name: 'EKO-PUNKT GmbH & Co. KG' },
  { id: 'DE6257129182400', name: 'Recycling Dual GmbH' },
  { id: 'DE6161328237553', name: 'Interzero Recycling Alliance GmbH // Lizenzero' }
];

// 2.3.3 Tabelle: Meldearten Hersteller
const REPORT_TYPES = [
  { code: 'HPM1', label: 'Initiale Planmengenmeldung' },
  { code: 'HMM1', label: 'Unterjährige Mengenmeldung' },
  { code: 'HJM1', label: 'Jahresabschlussmengenmeldung' },
  { code: 'HNM1', label: 'Nachtragsmengenmeldung (additiv)' },
  { code: 'HAM1', label: 'Abzugsmengen' }
];

// 2.3.1 Tabelle: Übersicht Materialarten - getrennt nach Rechtsregime,
// weil sich die Codes unterscheiden (z.B. Aluminium 49000 bei VerpackV,
// 40000 bei VerpackG/VerpackDG). Meldungen vor 2019 (VerpackV) sind
// bewusst nicht unterstützt (siehe resolveRegime()) - zu selten/veraltet,
// um das Mehrdeutigkeits-Risiko einer ungetesteten dritten Code-Tabelle
// einzugehen.
const MATERIAL_CODES = {
  verpackg: { glas: '10000', ppk: '20000', eisenmetalle: '30000', aluminium: '40000', kunststoffe: '50000', getraenkekarton: '60000', sonstigeVerbund: '70000', sonstige: '80000' },
  verpackdg: { glas: '10000', ppk: '20000', eisenmetalle: '30000', aluminium: '40000', kunststoffe: '50000', fluessigkeitskartons: '68000', sonstigeVerbund: '70000', sonstige: '80000' }
};

function resolveRegime(year) {
  if (year >= 2027) return 'verpackdg';
  if (year >= 2019) return 'verpackg';
  throw new Error(`LUCID-XML-Export unterstützt nur Meldejahre ab 2019 (VerpackG/VerpackDG) - ${year} läge noch unter der alten Verpackungsverordnung (VerpackV), die hier bewusst nicht abgebildet ist.`);
}

// Ordnet die aggregierten kg-Summen (siehe lib/annual-report-data.js,
// reportData[country].materials - unser interner Schlüssel karton/
// kunststoff/papier/glas/metall/holz/sonstige, optional nach Subtype
// aufgeschlüsselt) den offiziellen LUCID-MaterialCodes zu. materialsByKey
// ist das einfache {material: kg}-Objekt aus buildReportData();
// metalSubtypeKg ist optional eine zusätzliche {subtype: kg}-Aufschlüsselung
// NUR für 'metall' (siehe routes/reports.js), falls verfügbar - ohne sie
// wird die GESAMTE Metall-Menge als unklassifiziert gewarnt.
function mapMaterialsToLucidCodes(materialsByKey, year, metalSubtypeKg = null) {
  const regime = resolveRegime(year);
  const codes = MATERIAL_CODES[regime];
  const codeTotals = {}; // { MaterialCode: kg }
  const warnings = [];

  function addToCode(code, kg) {
    if (!kg) return;
    codeTotals[code] = (codeTotals[code] || 0) + kg;
  }

  for (const [key, kg] of Object.entries(materialsByKey)) {
    if (!kg) continue;
    switch (key) {
      case 'glas':
        addToCode(codes.glas, kg);
        break;
      case 'karton':
      case 'papier':
        // LUCID kennt keine Unterscheidung Papier vs. Karton - beides ist
        // "PPK" (Papier/Pappe/Karton), ein gemeinsamer Code.
        addToCode(codes.ppk, kg);
        break;
      case 'kunststoff':
        addToCode(codes.kunststoffe, kg);
        break;
      case 'sonstige':
        addToCode(codes.sonstige, kg);
        break;
      case 'metall': {
        if (metalSubtypeKg && (metalSubtypeKg.stahl || metalSubtypeKg.aluminium || metalSubtypeKg.unbekannt)) {
          addToCode(codes.eisenmetalle, metalSubtypeKg.stahl || 0);
          addToCode(codes.aluminium, metalSubtypeKg.aluminium || 0);
          if (metalSubtypeKg.unbekannt) {
            warnings.push(`${formatMassForLucid(metalSubtypeKg.unbekannt)} kg Metall ohne Angabe "Stahl/Weißblech" oder "Aluminium" - bitte im Produkt-Editor nachtragen und Export wiederholen, sonst fehlt diese Menge in der Meldung.`);
          }
        } else {
          warnings.push(`${formatMassForLucid(kg)} kg Metall konnten nicht in Eisenmetalle/Aluminium aufgeteilt werden (keine Subtype-Angabe verfügbar) - bitte im Produkt-Editor nachtragen und Export wiederholen, sonst fehlt diese Menge in der Meldung.`);
        }
        break;
      }
      case 'holz':
        // Bewusst KEINE automatische Zuordnung - siehe Modul-Kommentar
        // oben. Holz-Transportverpackungen laufen i.d.R. über eine andere
        // Rücknahmepflicht, nicht über die LUCID-Systembeteiligung.
        warnings.push(`${formatMassForLucid(kg)} kg Holz wurden NICHT in die XML-Datei aufgenommen - Holzverpackungen haben keine eigene LUCID-Systembeteiligungs-Kategorie. Bitte prüfen, ob dafür eine andere Meldepflicht gilt.`);
        break;
      default:
        warnings.push(`${formatMassForLucid(kg)} kg mit unbekanntem internem Material-Schlüssel "${key}" wurden nicht zugeordnet.`);
    }
  }

  return { codeTotals, warnings };
}

// Masse in kg mit drei Nachkommastellen, Komma als Dezimaltrennzeichen,
// kein Tausendertrennzeichen - exakt wie in Abschnitt 2.2 der Anleitung
// gefordert (z.B. "3244,000", "54,125").
function formatMassForLucid(kg) {
  return (Math.round(kg * 1000) / 1000).toFixed(3).replace('.', ',');
}

// Baut die XML-Datei exakt nach dem in Abschnitt 2.1 der Anleitung
// gezeigten Beispiel. Erste zwei Zeilen und letzte Zeile sind das von der
// ZSVR vorgegebene "Grundgerüst" und dürfen laut Anleitung nicht verändert
// werden. periodFrom/periodTo müssen im selben Kalenderjahr liegen (siehe
// 2.4 "Weitere Hinweise") - buildLucidXml erzwingt das nicht selbst,
// Aufrufer übergibt bewusst nur EIN Jahr (siehe routes/reports.js).
function buildLucidXml({ systemOperatorId, typeOfReportCode, year, codeTotals }) {
  if (!SYSTEM_OPERATORS.some(op => op.id === systemOperatorId)) {
    throw new Error('Unbekannte SystemOperatorID - bitte einen Systembetreiber aus der hinterlegten Liste wählen.');
  }
  if (!REPORT_TYPES.some(t => t.code === typeOfReportCode)) {
    throw new Error('Unbekannter TypeOfReportCode.');
  }

  const periodFrom = `${year}-01-01`;
  const periodTo = `${year}-12-31`;

  // Materialcodes in aufsteigender Reihenfolge - die Anleitung erlaubt
  // beliebige Reihenfolge, eine feste Sortierung macht die Datei aber
  // beim manuellen Gegenlesen vorhersehbar.
  const materialLines = Object.entries(codeTotals)
    .filter(([, kg]) => kg > 0) // "Entspricht die Menge eines Materials 0,000 kg, dann kann... weggelassen werden" (2.4)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([code, kg]) => `        <Material>\n          <MaterialCode>${code}</MaterialCode>\n          <Mass>${formatMassForLucid(kg)}</Mass>\n        </Material>`)
    .join('\n');

  return [
    '<?xml version="1.0"?>',
    '<Root>',
    '  <VersionNoInterface>1.0</VersionNoInterface>',
    '  <PackagingTypeCode>V</PackagingTypeCode>',
    `  <TypeOfReportCode>${typeOfReportCode}</TypeOfReportCode>`,
    `  <ReportingPeriodFrom>${periodFrom}</ReportingPeriodFrom>`,
    `  <ReportingPeriodTo>${periodTo}</ReportingPeriodTo>`,
    '  <ListOfSystemOperators>',
    '    <SystemOperator>',
    `      <SystemOperatorID>${systemOperatorId}</SystemOperatorID>`,
    '      <ListOfMaterials>',
    materialLines,
    '      </ListOfMaterials>',
    '    </SystemOperator>',
    '  </ListOfSystemOperators>',
    '</Root>'
  ].join('\n');
}

module.exports = {
  SYSTEM_OPERATORS,
  REPORT_TYPES,
  MATERIAL_CODES,
  resolveRegime,
  mapMaterialsToLucidCodes,
  formatMassForLucid,
  buildLucidXml
};
