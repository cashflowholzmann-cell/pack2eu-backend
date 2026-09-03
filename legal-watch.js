// ================================================================
// RECHTSÄNDERUNGS-RADAR
//
// Recherchiert pro Land automatisiert (Web-Suche via Claude) den
// aktuellen Stand der Verpackungs-/EPR-Registrierungspflichten und
// vergleicht ihn mit dem bei uns gespeicherten Stand ("countries"-
// Tabelle). Schreibt NIE direkt in "countries" - jeder Fund landet
// erst in "legal_watch_findings" und muss im internen Tool von einem
// Menschen bestätigt werden, bevor er live geht (siehe Kommentar beim
// CREATE TABLE in db/index.js). Wir sind kein Rechtsberater; das hier
// ist eine Recherche-Beschleunigung, keine automatisierte Rechtsauskunft.
//
// Bewusst nicht täglich, sondern dienstags und donnerstags in Batches
// (siehe runDailyLegalWatchIfDue in server.js) - Gesetzestexte ändern
// sich nicht stundenweise, und jeder Check kostet zwei Claude-Aufrufe
// (Recherche mit Websuche + strukturierte Auswertung). Zusätzlich über
// den "Jetzt prüfen"-Button im internen Tool jederzeit manuell
// auslösbar.
//
// Kosten-Vorfall 03.09.2026: ein einzelner 3-Länder-Testlauf mit Claude
// Opus + Adaptive Thinking + 6 Websuchen pro Land hat mehrere Dollar
// Guthaben verbraucht. Daraufhin bewusst reduziert: Claude Sonnet statt
// Opus (Nutzerentscheidung), max. 2 Websuchen statt 6, effort "medium"
// statt Standard/hoch.
// ================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod/v4');
const { db } = require('./db');

const LegalFindingSchema = z.object({
  has_meaningful_update: z
    .boolean()
    .describe('true, wenn die Recherche konkrete, verwertbare Informationen ergeben hat - entweder eine Lücke gefüllt oder einen Unterschied zum gespeicherten Stand gefunden hat'),
  summary: z.string().describe('Kurze deutsche Zusammenfassung dessen, was gefunden bzw. was geändert wurde'),
  confidence: z.enum(['hoch', 'mittel', 'niedrig']),
  suggested_fields: z.object({
    register_body: z.string().nullable(),
    representative_required: z.boolean().nullable(),
    notary_required: z.boolean().nullable(),
    notary_cost: z.string().nullable(),
    registration_url: z.string().nullable(),
    eco_fee: z.string().nullable(),
    registration_generally_required: z.boolean().nullable(),
    reporting_frequency: z.enum(['monthly', 'quarterly', 'annually', 'needs_verification']).nullable(),
    requirements: z.array(z.string()).nullable(),
    labeling: z.array(z.string()).nullable()
  }),
  sources: z.array(z.object({ title: z.string(), url: z.string() }))
});

async function researchCountry(country, currentData) {
  const client = new Anthropic();

  const researchPrompt = `Du recherchierst den aktuellen Stand der Verpackungs-/EPR-Registrierungspflichten für ${country.name} (${country.code}).

Bevorzugte Quellen: offizielle Register-/Behördenseiten des Landes, IHK-Länderprofile (ihk.de), die EU-Verpackungsverordnung PPWR (Verordnung (EU) 2025/40), sowie andere seriöse offizielle Quellen. Keine Foren, keine SEO-Blogartikel von Compliance-Dienstleistern als Hauptquelle.

Bereits bei uns gespeicherter Stand (kann veraltet oder unvollständig sein):
${JSON.stringify(currentData, null, 2)}

Recherchiere und fasse zusammen:
1. Ist eine Registrierung im nationalen Verpackungsregister erforderlich?
2. Ist ein Bevollmächtigter (representative) für nicht im Land ansässige Hersteller erforderlich? (Wichtig: PPWR Art. 45 macht das ab 12. August 2026 EU-weit für Drittstaaten-Hersteller verpflichtend.)
3. Ist eine notarielle Beglaubigung erforderlich?
4. Ungefähre Höhe der Recycling-/Lizenzgebühren, falls öffentlich bekannt.
5. Melde-Rhythmus (monatlich/quartalsweise/jährlich).
6. Hinweise auf jüngste Gesetzesänderungen.

Schließe mit einer klaren Zusammenfassung inkl. Quellen-URLs ab.`;

  // Kosten-Deckel: max_uses und effort bewusst niedrig gehalten - eine
  // Recherche mit Opus + Adaptive Thinking + Websuche ist teuer, siehe
  // Vorfall vom 03.09.2026 (ein einzelner "Jetzt prüfen"-Lauf über nur
  // 3 Länder hat mehrere Dollar Guthaben verbraucht).
  let research = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
    messages: [{ role: 'user', content: researchPrompt }]
  });

  // web_search ist ein Server-Tool - läuft normalerweise automatisch
  // innerhalb einer Antwort durch. Nur bei sehr langen Recherchen kann
  // "pause_turn" auftreten, dann einmal fortsetzen.
  if (research.stop_reason === 'pause_turn') {
    research = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
      messages: [
        { role: 'user', content: researchPrompt },
        { role: 'assistant', content: research.content }
      ]
    });
  }

  const researchText = research.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');

  if (!researchText.trim()) return null;

  const extraction = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `Extrahiere aus dieser Recherche strukturierte Daten:\n\n${researchText}`
      }
    ],
    output_config: { format: zodOutputFormat(LegalFindingSchema) }
  });

  return extraction.parsed_output;
}

async function runLegalWatch({ limit = 3 } = {}) {
  const targets = db.prepare(`
    SELECT
      code, name, register_body, representative_required, notary_required,
      notary_cost, registration_url, eco_fee, registration_generally_required,
      reporting_frequency, requirements_json, labeling_json, data_status
    FROM countries
    ORDER BY (data_status = 'needs_verification') DESC, code
    LIMIT ?
  `).all(limit);

  const insertFinding = db.prepare(`
    INSERT INTO legal_watch_findings
      (country_code, has_update, summary, ai_confidence, suggested_fields_json, sources_json, status)
    VALUES (?, 1, ?, ?, ?, ?, 'new')
  `);

  const results = [];

  for (const country of targets) {
    const currentData = {
      register_body: country.register_body,
      representative_required: !!country.representative_required,
      notary_required: !!country.notary_required,
      notary_cost: country.notary_cost,
      registration_url: country.registration_url,
      eco_fee: country.eco_fee,
      registration_generally_required: !!country.registration_generally_required,
      reporting_frequency: country.reporting_frequency,
      requirements: JSON.parse(country.requirements_json || '[]'),
      labeling: JSON.parse(country.labeling_json || '[]'),
      data_status: country.data_status
    };

    try {
      const finding = await researchCountry(country, currentData);
      if (finding && finding.has_meaningful_update) {
        insertFinding.run(
          country.code,
          finding.summary,
          finding.confidence,
          JSON.stringify(finding.suggested_fields),
          JSON.stringify(finding.sources)
        );
        results.push({ country: country.code, inserted: true });
      } else {
        results.push({ country: country.code, inserted: false });
      }
    } catch (err) {
      console.error(`❌ Rechtsänderungs-Check für ${country.code} fehlgeschlagen:`, err.message);
      results.push({ country: country.code, error: err.message });
    }
  }

  return results;
}

module.exports = { runLegalWatch };
