// routes/support.js
//
// KI-Support-Chat: erste (und im Regelfall einzige) Anlaufstelle bei
// Fragen zum Dashboard oder zur rechtlichen Lage. Kennt bei jeder Anfrage
// live den tatsächlichen Stand des jeweiligen Kunden (Länder, Status,
// EPR-Nummer/Bevollmächtigter, Plan) - kein statischer, veraltender
// Wissensstand. Eskaliert bewusst NICHT an ein Pack2EU-Support-Team
// (das gibt es hier absichtlich nicht), sondern an den zuständigen
// Bevollmächtigten des Kunden, oder als letzte Stufe an eine allgemeine
// Support-Adresse.
const express = require('express');
// zodOutputFormat() liest die Schemas über die zod/v4-Introspection
// (z.toJSONSchema intern) - mit dem klassischen "zod"-Import gebaute
// Schemas haben eine andere interne Struktur und lassen zodOutputFormat()
// mit "Cannot read properties of undefined (reading 'def')" abstürzen.
const { z } = require('zod/v4');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { db } = require('../db');
const { requireAuth, requireCustomer } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');

const router = express.Router();
router.use(requireAuth, requireCustomer);

const ChatResponseSchema = z.object({
  reply: z.string(),
  escalate: z.boolean(),
  escalate_target: z.enum(['representative', 'support', 'none']),
  escalate_reason: z.string().optional(),
});

// ============================================================
// STATISCHES WISSEN
// ============================================================

const DASHBOARD_KNOWLEDGE = `
Du kennst das Pack2EU-Dashboard vollständig. Es hat diese Bereiche:

- "🌍 Meine Länder": zeigt jedes aktivierte Zielland mit Ampel-Status
  (🟢 alles hinterlegt, 🟡/🟠 Prüfung oder Teile fehlen, 🔴 EPR-Nummer
  oder Bevollmächtigter fehlt zwingend). Über "+ Land aktivieren" wird
  ein neues Land eingerichtet (EPR-Nummer und/oder Bevollmächtigter
  angeben, falls vorhanden - sonst zeigt Pack2EU den passenden
  Register-/Bestell-Link). Über "✏️ Bearbeiten" lässt sich das
  jederzeit nachtragen oder ein Tippfehler korrigieren.
- "📦 Produkte & Verpackungen": jedes Produkt mit seinen
  Verpackungsmaterialien (Material + Gewicht je Bestandteil). Auch
  direkt aus dem Bestellungs-Popup heraus über "+ Produkt anlegen"
  möglich.
- "📋 Bestellungen": manuell erfasste oder aus Shopify synchronisierte
  Bestellungen. "+ Neue Bestellung" fragt Produkte (mit Menge) und eine
  Paketgröße (S/M/L oder eigene, nur Name + Gewicht) ab. Bereits
  erfasste manuelle Bestellungen lassen sich über "✏️ Korrigieren"
  anpassen (Shopify-Bestellungen nicht, die kommen extern).
- "📨 Meldepflichten pro Land": zeigt pro aktiviertem Land, wohin und
  wie oft gemeldet werden muss. "📨 Jetzt melden" befüllt die
  Materialien automatisch aus den echten Bestellungen des Kunden für
  dieses Land (Umverpackung und Einzelprodukte zusammengerechnet) -
  der Kunde muss nichts abtippen, kann die Werte aber anpassen. Bereits
  abgegebene Meldungen lassen sich über "✏️ Bearbeiten" korrigieren.
- "🏛️ Beauftragten-Portal": nur für eingeloggte Bevollmächtigte
  sichtbar, zeigt ihnen die für sie eingegangenen Meldungen.
- Erst-Onboarding: Branche wählen → passende Beispielprodukte
  übernehmen → Zielländer wählen (Anzahl je nach Plan begrenzt) →
  kurze "So geht's"-Sequenz → Testbestellung zum Ausprobieren (wird
  NICHT gespeichert).
- Pläne: Starter (250 kg/Jahr, 2 Länder), Bestseller (1000 kg/Jahr,
  10 Länder, bei jährlicher Zahlung 1 Bevollmächtigter inklusive),
  Enterprise (unbegrenzt, 1-2 Bevollmächtigte inklusive je nach
  Zahlweise).
`.trim();

const LEGAL_KNOWLEDGE = `
Rechtlicher Hintergrund (Stand: allgemeines, sich änderndes EU-Recht -
IMMER als allgemeine Einordnung formulieren, NIE als verbindliche
Rechtsberatung im Einzelfall):

- Seit 12.08.2026 gilt die EU-Verpackungsverordnung (PPWR) unmittelbar
  in allen 27 Mitgliedstaaten - keine Bagatellgrenze, Pflichten greifen
  ab dem ersten Paket.
- Wer aus einem Land in ein anderes EU-Land verkauft, braucht dort in
  der Regel: Registrierung im nationalen Verpackungsregister, laufende
  Mengenmeldung, und je nach Land einen dortigen Bevollmächtigten -
  besonders zwingend für Händler mit Sitz außerhalb der EU.
- Verstöße können mit Bußgeldern geahndet werden, die je nach Land
  erheblich sein können.
- Die genauen Fristen, Formulare und Schwellenwerte unterscheiden sich
  von Land zu Land und ändern sich auch mal - deshalb bei konkreten,
  bindenden Fragen (z. B. "reicht meine Frist noch", "brauche ich für
  Land X wirklich einen Bevollmächtigten in meinem Fall") NIEMALS eine
  eigene verbindliche Einschätzung geben, sondern an den Bevollmächtigten
  des Kunden für das jeweilige Land verweisen (siehe Eskalations-Regeln).
- Für die tatsächlich aktivierten Länder des Kunden bekommst du unten bei
  "AKTUELLE DATEN DIESES KUNDEN" den konkreten, für Pack2EU recherchierten
  Stand (Registerstelle, Öko-Gebühr, Anforderungen, Kennzeichnung,
  Datenstand). Nutze diese konkreten Angaben statt allgemeiner Vermutungen,
  wo vorhanden - aber auch hier gilt: bei "Datenstand: noch nicht
  abschließend verifiziert" nie als zu 100% verbindlich ausgeben.
`.trim();

const ESCALATION_RULES = `
Eskalations-Regeln:

- Beantworte alles, was sich aus deinem Wissen über das Dashboard und
  den unten stehenden aktuellen Kundendaten sicher beantworten lässt,
  selbst und vollständig - ein Pack2EU-Team steht bewusst NICHT für
  persönlichen Support zur Verfügung, das ist explizit gewünscht.
- Setze "escalate": true UND "escalate_target": "representative" nur,
  wenn es um eine verbindliche rechtliche Einzelfallfrage für ein Land
  geht, für das der Kunde bereits einen Bevollmächtigten hinterlegt hat.
  Nenne in "reply" freundlich, dass du das nicht verbindlich beurteilen
  kannst und der Bevollmächtigte die richtige Stelle dafür ist.
- Setze "escalate": true UND "escalate_target": "support" nur in
  echten Ausnahmefällen: ein technischer Fehler/Bug, ein Abrechnungs-
  problem, oder eine verbindliche Rechtsfrage für ein Land OHNE
  hinterlegten Bevollmächtigten. Das ist die letzte Stufe, nicht die
  erste Wahl.
- In allen anderen Fällen "escalate": false, "escalate_target": "none".
- "reply" ist immer die eigentliche, hilfreiche Antwort an den Kunden -
  auch wenn du gleichzeitig eskalierst, beantworte so viel wie möglich
  selbst.
`.trim();

// ============================================================
// FAQ-VORFILTER (0 Cent, keine KI-Anfrage)
// ============================================================
//
// Deckt die Fragen ab, die erfahrungsgemäß (eigener Test) und laut
// einem Blick in die FAQs bekannter Mitbewerber (u.a. Lappa, Lizenzero,
// Landbell) mit Abstand am häufigsten vorkommen UND sich generisch,
// unabhängig vom einzelnen Kunden, korrekt beantworten lassen. Trifft
// eine Nachricht hier, kostet die Antwort nichts - nur wenn nichts
// passt, geht es weiter zur eigentlichen KI mit den echten
// Kundendaten. Bewusst konservativ: jeder Eintrag braucht mehrere
// passende Stichwort-Gruppen gleichzeitig (AND über die Gruppen, OR
// innerhalb einer Gruppe), damit eine kundenspezifische Frage (z.B.
// "muss ich für Frankreich selbst zahlen?") nicht hier landet, sondern
// korrekt bei der KI mit den echten Kundendaten beantwortet wird.
const FAQ_ENTRIES = [
  {
    id: 'ppwr_general',
    groups: [[/ppwr/, /verpackungsverordnung/], [/was ist/, /seit wann/, /gilt/, /bedeutet/]],
    answer: 'Die EU-Verpackungsverordnung (PPWR) gilt seit dem 12.08.2026 unmittelbar in allen 27 EU-Mitgliedstaaten - ohne Bagatellgrenze, also grundsätzlich ab dem ersten verkauften Paket. Sie schreibt je nach Land u. a. eine Registrierung im nationalen Verpackungsregister, laufende Mengenmeldungen und teils einen dortigen Bevollmächtigten vor.'
  },
  {
    id: 'registration_per_country',
    groups: [[/registrier/], [/jedem land/, /jedes land/, /alle länder/, /pro land/, /pro eu-land/, /in jedem eu-land/]],
    answer: 'Ja - grundsätzlich musst du dich in jedem EU-Land, in das du verkaufst, im dortigen nationalen Verpackungsregister registrieren und dort deine Verpackungsmengen melden. Das ist Ländersache, es gibt keine EU-weite Sammelregistrierung. Im Dashboard unter "🌍 Meine Länder" siehst du für jedes aktivierte Land den genauen Status.'
  },
  {
    id: 'representative_general',
    groups: [[/bevollmächtigt/], [/was ist/, /brauche ich/, /wozu/, /wofür/, /muss ich einen/, /benötige ich/]],
    answer: 'Ein Bevollmächtigter (Authorized Representative) ist eine im jeweiligen Land ansässige Person/Firma, die für dich die dortigen Verpackungspflichten (Registrierung, Meldung, Kommunikation mit Behörden) wahrnimmt. Besonders zwingend ist das für Händler mit Sitz außerhalb der EU. Ob und wo du für deine aktivierten Länder einen brauchst, siehst du im Dashboard bei "🌍 Meine Länder" (🔴 = zwingend erforderlich und noch nicht hinterlegt).'
  },
  {
    id: 'pack2eu_is_representative',
    groups: [[/pack2eu/, /ihr seid/, /seid ihr/, /bist du/], [/bevollmächtigt/]],
    answer: 'Nein: Pack2EU selbst ist nicht dein Bevollmächtigter. Wir vermitteln bzw. organisieren dir einen passenden Bevollmächtigten im Zielland, dieser wird aber auf Grundlage einer eigenen Beauftragung/Vollmacht direkt für dich tätig und erfüllt die gesetzlichen Pflichten im eigenen Namen und in eigener Verantwortung. Details dazu stehen auch in unseren AGB.'
  },
  {
    id: 'penalties',
    groups: [[/bußgeld/, /strafe/, /geldbuße/, /sanktion/], [/wenn ich nicht/, /ohne registr/, /was passiert/, /wie hoch/]],
    answer: 'Verstöße gegen die Verpackungspflichten können mit Bußgeldern geahndet werden, die je nach Land erheblich sein können (u. a. auch Sperren bei Marktplätzen oder Probleme beim Zoll sind möglich). Die genaue Höhe und wie streng das durchgesetzt wird, unterscheidet sich von Land zu Land - deshalb lohnt sich eine frühzeitige Registrierung statt abzuwarten.'
  },
  {
    id: 'reporting_frequency',
    groups: [[/wie oft/, /wie häufig/], [/melden/, /meldung/, /meldepflicht/]],
    answer: 'Wie oft gemeldet werden muss (z. B. jährlich oder quartalsweise), ist von Land zu Land unterschiedlich. Für deine aktivierten Länder siehst du die konkrete Meldefrequenz im Dashboard unter "📨 Meldepflichten pro Land" - dort befüllt "📨 Jetzt melden" die Mengen sogar automatisch aus deinen erfassten Bestellungen.'
  },
  {
    id: 'minimum_threshold',
    groups: [[/bagatell/, /mindestmenge/, /schwellenwert/, /freigrenze/, /ab welcher menge/, /untergrenze/]],
    answer: 'Nein, es gibt grundsätzlich keine Bagatell- oder Mindestmengengrenze - die Pflichten gelten in der Regel ab dem ersten verkauften Paket, unabhängig vom Umsatz oder der Menge. Manche Länder haben aber vereinfachte Verfahren für sehr kleine Mengen; Details dazu findest du für deine aktivierten Länder im Dashboard.'
  },
  {
    id: 'representative_cost',
    groups: [[/bevollmächtigt/], [/kosten/, /kostet/, /preis/, /gebühr/]],
    answer: 'Die Kosten für einen Bevollmächtigten hängen stark vom Land und Anbieter ab und kommen zusätzlich zu den Registrierungs-/Öko-Gebühren des jeweiligen Landes hinzu. Bei Bestseller (bei jährlicher Zahlung) und Enterprise ist je nach Plan ein Bevollmächtigter bereits inklusive. Die für dich konkret geltenden Kosten siehst du am zuverlässigsten im Dashboard bei "🌍 Meine Länder" - frag mich gern auch direkt zu einem bestimmten Land, dann schaue ich in deine echten Daten.'
  },
  {
    id: 'add_country',
    groups: [[/land hinzufügen/, /land aktivieren/, /neues land/, /weiteres land/, /zusätzliches land/]],
    answer: 'Ein neues Land aktivierst du im Dashboard unter "🌍 Meine Länder" über "+ Land aktivieren". Dort kannst du direkt eine vorhandene EPR-Nummer und/oder einen Bevollmächtigten eintragen - falls du noch keinen hast, zeigt dir Pack2EU den passenden Register-/Bestell-Link für dieses Land.'
  },
  {
    id: 'how_to_report',
    groups: [[/wie melde ich/, /meldung abgeben/, /wie funktioniert.{0,15}melden/]],
    answer: 'Unter "📨 Meldepflichten pro Land" siehst du pro aktiviertem Land, wohin und wie oft gemeldet werden muss. Über "📨 Jetzt melden" werden die Materialien automatisch aus deinen echten erfassten Bestellungen befüllt - du musst nichts abtippen, kannst die Werte vor dem Absenden aber noch anpassen.'
  },
  {
    id: 'epr_number',
    groups: [[/epr-nummer/, /epr nummer/], [/was ist/, /brauche ich/, /wo finde ich/, /wo bekomme ich/, /wie beantrage/]],
    answer: 'Die EPR-Nummer ist deine Registrierungsnummer im jeweiligen nationalen Verpackungsregister - sie bestätigt, dass du dort für dieses Land als Inverkehrbringer gemeldet bist. Falls du für ein Land noch keine hast, findest du im Dashboard bei "🌍 Meine Länder" den passenden Link zur zuständigen Registerstelle.'
  },
  {
    id: 'notary',
    groups: [[/notar/]],
    answer: 'Ob für die Beauftragung eines Bevollmächtigten eine notarielle Beglaubigung nötig ist, hängt vom jeweiligen Land ab. Für deine aktivierten Länder siehst du das (inkl. ggf. der Kosten dafür) im Dashboard bei "🌍 Meine Länder" in den Detailangaben.'
  },
  {
    id: 'plan_comparison',
    groups: [[/starter/, /bestseller/, /enterprise/], [/unterschied/, /vergleich/, /welcher plan/, /welches paket/]],
    answer: 'Starter: 250 kg/Jahr, 2 Länder. Bestseller: 1.000 kg/Jahr, 10 Länder, bei jährlicher Zahlung 1 Bevollmächtigter inklusive. Enterprise: unbegrenzte Menge, 1-2 Bevollmächtigte inklusive je nach Zahlweise. Welcher Plan zu dir passt, hängt von deiner Verpackungsmenge und Anzahl Zielländer ab - ein Wechsel ist jederzeit über die Kontoeinstellungen möglich.'
  },
  {
    id: 'cancellation',
    groups: [[/kündig/, /vertragslaufzeit/, /vertrag beenden/, /abo kündigen/]],
    answer: 'Die genauen Kündigungsfristen und -bedingungen findest du in unseren AGB (Link im Footer der Seite) sowie direkt in deinen Kontoeinstellungen im Dashboard. Bei Fragen zu deinem konkreten Vertrag helfe ich dir gern auch hier weiter, wenn du magst.'
  },
  {
    id: 'volume_change',
    groups: [[/menge ändert/, /mehr verpackung/, /volumen erhöht/, /menge.{0,15}erhöht/, /mehr menge/, /plan wechseln/, /kontingent/, /quota/]],
    answer: 'Wenn sich deine jährliche Verpackungsmenge deutlich ändert, kann es sein, dass dein aktueller Plan nicht mehr passt (Starter 250 kg, Bestseller 1.000 kg, Enterprise unbegrenzt) - ein Wechsel ist jederzeit über die Kontoeinstellungen möglich. Deine tatsächliche Meldemenge berechnet sich ohnehin automatisch aus deinen erfassten Bestellungen, du musst nichts manuell nachrechnen.'
  },
  {
    id: 'lucid',
    groups: [[/lucid/]],
    answer: 'LUCID ist das zentrale deutsche Verpackungsregister der Stiftung Zentrale Stelle Verpackungsregister (ZSVR). Wer Verpackungen mit Erstbefüllung in Deutschland in Verkehr bringt, muss sich dort registrieren - unabhängig von der Menge. Für Deutschland als aktiviertes Land siehst du den Status dazu im Dashboard bei "🌍 Meine Länder".'
  },
  {
    id: 'data_status_meaning',
    groups: [[/datenstand/, /noch nicht abschließend verifiziert/]],
    answer: 'Der "Datenstand" zeigt an, wie sicher die für ein Land hinterlegten Angaben (Registerstelle, Öko-Gebühr, Anforderungen) aktuell sind: "geprüft" heißt, das wurde bereits verifiziert. "Noch nicht abschließend verifiziert" heißt, die Angaben sind eine gute Orientierung, aber für verbindliche Detailfragen solltest du dich zusätzlich an deinen Bevollmächtigten für dieses Land wenden.'
  },
  {
    id: 'registration_vs_reporting',
    groups: [[/unterschied/], [/registrierung/, /lizenzierung/, /meldung/]],
    answer: 'Registrierung ist die einmalige Anmeldung im nationalen Verpackungsregister (du bekommst dabei deine EPR-Nummer). Meldung ist die laufende Angabe deiner tatsächlich verkauften Verpackungsmengen an diese Stelle. Lizenzierung meint in manchen Ländern (z. B. Deutschland über ein duales System) zusätzlich die Beteiligung an der Entsorgung/Verwertung - das läuft neben der reinen Registrierung.'
  }
];

function matchFaq(message) {
  const text = message.toLowerCase();
  return FAQ_ENTRIES.find(entry =>
    entry.groups.every(group => group.some(re => re.test(text)))
  ) || null;
}

function buildCustomerContext(customerId) {
  const customer = db.prepare(`
    SELECT company_name, origin_country, is_eu, plan, billing_interval
    FROM customers WHERE id = ?
  `).get(customerId);

  if (!customer) return null;

  // Zieht dieselbe "countries"-Tabelle, die auch das Rechtsänderungs-Radar
  // (legal-watch.js) pflegt - der Chat sieht also automatisch den
  // aktuellsten Stand, sobald ein Fund im Admin-Tool per "Übernehmen"
  // bestätigt wurde. Bewusst NICHT direkt an legal_watch_findings
  // angebunden: ungeprüfte KI-Recherche darf nie ungefiltert in ein
  // Kundengespräch einfließen, nur was schon menschlich freigegeben in
  // "countries" gelandet ist.
  const activations = db.prepare(`
    SELECT a.country_code, c.name, a.status, a.existing_number,
           a.representative_name, a.representative_company,
           c.reporting_frequency, c.register_body, c.eco_fee,
           c.representative_required, c.notary_required, c.notary_cost,
           c.registration_generally_required, c.requirements_json,
           c.labeling_json, c.data_status
    FROM activations a
    JOIN countries c ON c.code = a.country_code
    WHERE a.customer_id = ?
  `).all(customerId);

  const skuCount = db.prepare('SELECT COUNT(*) AS n FROM product_packaging WHERE customer_id = ?').get(customerId).n;
  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(customerId).n;
  const submissionCount = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE customer_id = ?').get(customerId).n;

  const planLimits = getPlanLimits(customer.plan);

  const countryLines = activations.length > 0
    ? activations.map(a => {
        const hasEpr = !!a.existing_number;
        const hasRep = !!a.representative_name;
        const requirements = JSON.parse(a.requirements_json || '[]');
        const labeling = JSON.parse(a.labeling_json || '[]');
        return [
          `- ${a.name} (${a.country_code}): Status=${a.status}, EPR-Nummer=${hasEpr ? 'vorhanden' : 'FEHLT'}, `
            + `Bevollmächtigter=${hasRep ? `${a.representative_name}${a.representative_company ? ' / ' + a.representative_company : ''}` : 'keiner hinterlegt'}, `
            + `Meldefrequenz=${a.reporting_frequency}`,
          `  Registerstelle: ${a.register_body || 'unbekannt'} · Öko-Gebühr: ${a.eco_fee || 'unbekannt'} · `
            + `Bevollmächtigter gesetzlich nötig: ${a.representative_required ? 'ja' : 'nein'} · `
            + `Notarielle Beglaubigung nötig: ${a.notary_required ? `ja${a.notary_cost ? ' (' + a.notary_cost + ')' : ''}` : 'nein'}`,
          requirements.length ? `  Anforderungen: ${requirements.join('; ')}` : null,
          labeling.length ? `  Kennzeichnung: ${labeling.join('; ')}` : null,
          `  Datenstand: ${a.data_status === 'verified' ? 'geprüft' : 'noch nicht abschließend verifiziert - bei bindenden Detailfragen an den Bevollmächtigten verweisen'}`
        ].filter(Boolean).join('\n');
      }).join('\n')
    : '(noch kein Land aktiviert)';

  return {
    text: [
      `KUNDE: ${customer.company_name}`,
      `Herkunftsland: ${customer.origin_country} (${customer.is_eu ? 'EU' : 'außerhalb der EU'})`,
      `Plan: ${customer.plan} (${planLimits.weightQuotaKg ? planLimits.weightQuotaKg + ' kg/Jahr' : 'unbegrenzt'}, `
        + `max. ${planLimits.maxCountries ?? 'unbegrenzt'} Länder)`,
      `Produkte angelegt: ${skuCount} · Bestellungen erfasst: ${orderCount} · Meldungen abgegeben: ${submissionCount}`,
      '',
      'AKTIVIERTE LÄNDER (inkl. aktuellstem Rechts- und Registerstand aus unserer Länder-Datenbank):',
      countryLines
    ].join('\n'),
    activations
  };
}

router.post('/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Nachricht fehlt.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Nachricht ist zu lang (max. 2000 Zeichen).' });
  }

  const customerId = req.auth.userId;

  const faqMatch = matchFaq(message);
  if (faqMatch) {
    try {
      db.prepare('INSERT INTO support_messages (customer_id, role, content, escalated) VALUES (?, ?, ?, 0)')
        .run(customerId, 'user', message);
      db.prepare('INSERT INTO support_messages (customer_id, role, content, escalated) VALUES (?, ?, ?, 0)')
        .run(customerId, 'assistant', faqMatch.answer);
    } catch (dbError) {
      console.error('❌ Support-Chat FAQ-Verlauf Fehler:', dbError);
    }
    console.log(`💬 Support-Chat: FAQ-Treffer "${faqMatch.id}" (0 Cent, keine KI-Anfrage)`);
    return res.json({
      reply: faqMatch.answer,
      escalate: false,
      escalate_target: 'none',
      escalate_reason: null,
      representative: null,
      support_email: null
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'Der Support-Chat ist noch nicht aktiv - dazu muss ANTHROPIC_API_KEY in der Backend-Konfiguration gesetzt sein.'
    });
  }

  try {
    const context = buildCustomerContext(customerId);
    if (!context) {
      return res.status(404).json({ error: 'Kunde nicht gefunden.' });
    }

    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-10)
          .map(m => ({ role: m.role, content: m.content }))
      : [];

    // Prompt-Caching: der Instruktionsteil (Intro + Dashboard-/Rechts-Wissen +
    // Eskalationsregeln) ist für JEDEN Kunden und JEDE Nachricht identisch -
    // eigener cache_control-Breakpoint dafür, damit er nicht bei jeder
    // einzelnen Chat-Nachricht neu (und voll bezahlt) mitgeschickt wird.
    // Die Live-Kundendaten ändern sich dagegen pro Kunde/Zeitpunkt und
    // bleiben deshalb bewusst außerhalb des gecachten Blocks.
    const staticSystemPrompt = [
      'Du bist der Support-Assistent von Pack2EU, einer SaaS für EU-Verpackungscompliance. '
        + 'Antworte auf Deutsch, freundlich, konkret und knapp.',
      DASHBOARD_KNOWLEDGE,
      LEGAL_KNOWLEDGE,
      ESCALATION_RULES
    ].join('\n\n---\n\n');

    const client = new Anthropic();

    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: {
        format: zodOutputFormat(ChatResponseSchema),
        effort: 'medium'
      },
      system: [
        { type: 'text', text: staticSystemPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'AKTUELLE DATEN DIESES KUNDEN (live aus dem Dashboard, nicht statisch):\n' + context.text }
      ],
      messages: [...history, { role: 'user', content: message }]
    });

    // Kurzes Kosten-Logging, u. a. um Prompt-Caching zu verifizieren -
    // cache_read_input_tokens > 0 bedeutet: der Cache-Treffer hat
    // gegriffen, dieser Anteil der Anfrage kostet ~90% weniger.
    console.log(
      `💬 Support-Chat: input=${response.usage.input_tokens} `
      + `cache_read=${response.usage.cache_read_input_tokens ?? 0} `
      + `cache_write=${response.usage.cache_creation_input_tokens ?? 0} `
      + `output=${response.usage.output_tokens}`
    );

    const parsed = response.parsed_output;
    if (!parsed) {
      return res.status(502).json({ error: 'Antwort konnte nicht verarbeitet werden.' });
    }

    db.prepare('INSERT INTO support_messages (customer_id, role, content, escalated) VALUES (?, ?, ?, 0)')
      .run(customerId, 'user', message);
    db.prepare('INSERT INTO support_messages (customer_id, role, content, escalated) VALUES (?, ?, ?, ?)')
      .run(customerId, 'assistant', parsed.reply, parsed.escalate ? 1 : 0);

    let representative = null;
    if (parsed.escalate_target === 'representative') {
      const repRow = context.activations.find(a => a.representative_name);
      if (repRow) {
        representative = {
          name: repRow.representative_name,
          company: repRow.representative_company || null
        };
      }
    }

    res.json({
      reply: parsed.reply,
      escalate: parsed.escalate,
      escalate_target: parsed.escalate_target,
      escalate_reason: parsed.escalate_reason || null,
      representative,
      support_email: parsed.escalate_target === 'support' ? (process.env.SUPPORT_EMAIL || null) : null
    });
  } catch (error) {
    // Interne Fehlerdetails (z.B. eine ungültige ANTHROPIC_API_KEY) landen
    // nur im Server-Log, nie in der Antwort an den Kunden.
    console.error('❌ Support-Chat Fehler:', error);
    res.status(503).json({ error: 'Der Support-Chat ist gerade nicht erreichbar. Bitte versuch es in ein paar Minuten erneut.' });
  }
});

router.get('/history', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT role, content, escalated, created_at
      FROM support_messages
      WHERE customer_id = ?
      ORDER BY id ASC
      LIMIT 50
    `).all(req.auth.userId);
    res.json(rows);
  } catch (error) {
    console.error('❌ Support-Verlauf Fehler:', error);
    res.status(500).json({ error: 'Verlauf konnte nicht geladen werden.' });
  }
});

module.exports = router;
