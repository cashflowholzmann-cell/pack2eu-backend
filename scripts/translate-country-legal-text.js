// scripts/translate-country-legal-text.js
//
// Einmalig auszuführendes Skript (KEIN Teil des normalen Serverstarts,
// siehe db/index.js-Kommentar bei translations_json): übersetzt die
// deutschen Länder-Rechtstexte (register_body, eco_fee, requirements,
// labeling, notary_cost) in countries + country_stream_rules nach
// EN/FR/IT/ES und speichert sie in der jeweiligen translations_json-Spalte.
//
// Bewusst NUR reine Übersetzung - kein Websearch, kein Adaptive Thinking,
// Sonnet statt Opus (Kosten-Vorfall 03.09.2026 bei legal-watch.js, siehe
// dortigen Kommentar - dieses Skript hat aber ein fundamental anderes
// Kostenprofil: eine reine Übersetzungsanfrage ohne Tools/Suche ist um
// Größenordnungen billiger als eine Recherche mit Websuche).
//
// Läuft NUR gegen Zeilen mit translations_json IS NULL (idempotent, sicher
// erneut ausführbar - z.B. für neu hinzugefügte Länder), holt sich NICHT
// automatisch bei jedem Serverstart aktualisierte Übersetzungen.
//
// Aufruf: ANTHROPIC_API_KEY=... node scripts/translate-country-legal-text.js
//   [--only=countries|streams]  (Default: beide)
//   [--limit=N]                 (Default: alle offenen Zeilen)
//   [--dry-run]                 (übersetzt, schreibt aber nicht in die DB)
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod/v4');
const { db, init } = require('../db');

const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || 'both';
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const dryRun = args.includes('--dry-run');

const LangContentSchema = z.object({
  register_body: z.string().nullable().describe('Übersetzung von register_body - Eigennamen von Behörden/Registern/Systembetreibern (z.B. "EOAN", "HERRCO", "CONAI", "stiftung ear") NIEMALS übersetzen, nur die deutschen Füllwörter drumherum (z.B. "Nationales Produzentenregister", "über", "Systembeteiligung über", "Übergang").'),
  eco_fee: z.string().nullable().describe('Übersetzung von eco_fee, falls vorhanden.'),
  requirements: z.array(z.string()).describe('Übersetzung jedes Eintrags in requirements, gleiche Reihenfolge und Anzahl wie die Quelle.'),
  labeling: z.array(z.string()).describe('Übersetzung jedes Eintrags in labeling, gleiche Reihenfolge und Anzahl wie die Quelle.'),
  notary_cost: z.string().nullable().describe('Übersetzung von notary_cost, falls vorhanden.')
});

const TranslationSchema = z.object({
  en: LangContentSchema,
  fr: LangContentSchema,
  it: LangContentSchema,
  es: LangContentSchema
});

function buildPrompt(source) {
  return `Übersetze die folgenden deutschen Rechtstexte zu Verpackungs-/EPR-Compliance-Pflichten für ein Land nach Englisch, Französisch, Italienisch und Spanisch. Zielgruppe: Kleinunternehmer:innen in einem SaaS-Dashboard, keine Jurist:innen - klar und präzise, aber nicht bürokratisch geschwollen.

WICHTIG:
- Eigennamen von Behörden, Registern, Systembetreibern, Gesetzen (z.B. "EOAN", "HERRCO", "CONAI", "stiftung ear", "PPWR", "VerpackG") bleiben IMMER unübersetzt/unverändert - das sind Eigennamen, keine beschreibenden Begriffe.
- URLs, Zahlen, Geldbeträge, Prozentangaben unverändert lassen.
- requirements und labeling sind Arrays - gib pro Sprache exakt gleich viele Einträge in exakt gleicher Reihenfolge zurück wie in der Quelle.
- Ein Feld, das in der Quelle null/leer ist, bleibt in der Übersetzung ebenfalls null.

Quelle (Deutsch):
${JSON.stringify(source, null, 2)}`;
}

async function translateRow(client, source) {
  const result = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildPrompt(source) }],
    output_config: { format: zodOutputFormat(TranslationSchema) }
  });
  return result.parsed_output;
}

async function run() {
  init();
  const client = new Anthropic();

  const results = { countries: { done: 0, failed: 0 }, streams: { done: 0, failed: 0 } };

  if (only === 'both' || only === 'countries') {
    let rows = db.prepare(`
      SELECT code, register_body, eco_fee, requirements_json, labeling_json, notary_cost
      FROM countries
      WHERE translations_json IS NULL
      ORDER BY code
    `).all();
    if (limit) rows = rows.slice(0, limit);

    console.log(`\n🌍 countries: ${rows.length} Land/Länder ohne Übersetzung gefunden.`);

    for (const row of rows) {
      const source = {
        register_body: row.register_body || null,
        eco_fee: row.eco_fee || null,
        requirements: JSON.parse(row.requirements_json || '[]'),
        labeling: JSON.parse(row.labeling_json || '[]'),
        notary_cost: row.notary_cost || null
      };
      try {
        const translated = await translateRow(client, source);
        if (!dryRun) {
          db.prepare(`UPDATE countries SET translations_json = ? WHERE code = ?`)
            .run(JSON.stringify(translated), row.code);
        }
        results.countries.done++;
        console.log(`  ✅ ${row.code}${dryRun ? ' (dry-run, nicht gespeichert)' : ''}`);
      } catch (err) {
        results.countries.failed++;
        console.error(`  ❌ ${row.code}: ${err.message}`);
      }
    }
  }

  if (only === 'both' || only === 'streams') {
    let rows = db.prepare(`
      SELECT id, country_code, stream, register_body, requirements_json, labeling_json, notary_cost
      FROM country_stream_rules
      WHERE translations_json IS NULL
      ORDER BY country_code, stream
    `).all();
    if (limit) rows = rows.slice(0, limit);

    console.log(`\n🔌 country_stream_rules: ${rows.length} Zeile(n) ohne Übersetzung gefunden.`);

    for (const row of rows) {
      const source = {
        register_body: row.register_body || null,
        eco_fee: null,
        requirements: JSON.parse(row.requirements_json || '[]'),
        labeling: JSON.parse(row.labeling_json || '[]'),
        notary_cost: row.notary_cost || null
      };
      try {
        const translated = await translateRow(client, source);
        if (!dryRun) {
          db.prepare(`UPDATE country_stream_rules SET translations_json = ? WHERE id = ?`)
            .run(JSON.stringify(translated), row.id);
        }
        results.streams.done++;
        console.log(`  ✅ ${row.country_code}/${row.stream}${dryRun ? ' (dry-run, nicht gespeichert)' : ''}`);
      } catch (err) {
        results.streams.failed++;
        console.error(`  ❌ ${row.country_code}/${row.stream}: ${err.message}`);
      }
    }
  }

  console.log('\n==============================================');
  console.log(`countries: ${results.countries.done} übersetzt, ${results.countries.failed} fehlgeschlagen`);
  console.log(`country_stream_rules: ${results.streams.done} übersetzt, ${results.streams.failed} fehlgeschlagen`);
  console.log('==============================================\n');
}

run().catch(err => {
  console.error('❌ Übersetzungs-Skript fehlgeschlagen:', err);
  process.exit(1);
});
