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
const { z } = require('zod');
const { callDeepSeekJSON } = require('../lib/deepseek');
const { db } = require('../db');
const { requireAuth, requireCustomer } = require('../middleware/auth');
const { getPlanLimits } = require('../config/plans');

const router = express.Router();
router.use(requireAuth, requireCustomer);

const ChatResponseSchema = z.object({
  reply: z.string(),
  escalate: z.boolean(),
  escalate_target: z.enum(['representative', 'support', 'none']),
  escalate_reason: z.string().nullable().optional(),
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

const RESPONSE_FORMAT_INSTRUCTIONS = `
Antworte AUSSCHLIESSLICH mit einem einzigen validen JSON-Objekt (kein
Markdown, kein Fließtext davor oder danach) in genau diesem Format:

{
  "reply": string,
  "escalate": boolean,
  "escalate_target": "representative" | "support" | "none",
  "escalate_reason": string oder null
}
`.trim();

function buildCustomerContext(customerId) {
  const customer = db.prepare(`
    SELECT company_name, origin_country, is_eu, plan, billing_interval
    FROM customers WHERE id = ?
  `).get(customerId);

  if (!customer) return null;

  const activations = db.prepare(`
    SELECT a.country_code, c.name, a.status, a.existing_number,
           a.representative_name, a.representative_company,
           c.reporting_frequency
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
        return `- ${a.name} (${a.country_code}): Status=${a.status}, EPR-Nummer=${hasEpr ? 'vorhanden' : 'FEHLT'}, `
          + `Bevollmächtigter=${hasRep ? `${a.representative_name}${a.representative_company ? ' / ' + a.representative_company : ''}` : 'keiner hinterlegt'}, `
          + `Meldefrequenz=${a.reporting_frequency}`;
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
      'AKTIVIERTE LÄNDER:',
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

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(503).json({
      error: 'Der Support-Chat ist noch nicht aktiv - dazu muss DEEPSEEK_API_KEY in der Backend-Konfiguration gesetzt sein.'
    });
  }

  const customerId = req.auth.userId;

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

    const systemPrompt = [
      'Du bist der Support-Assistent von Pack2EU, einer SaaS für EU-Verpackungscompliance. '
        + 'Antworte auf Deutsch, freundlich, konkret und knapp.',
      DASHBOARD_KNOWLEDGE,
      LEGAL_KNOWLEDGE,
      ESCALATION_RULES,
      'AKTUELLE DATEN DIESES KUNDEN (live aus dem Dashboard, nicht statisch):\n' + context.text,
      RESPONSE_FORMAT_INSTRUCTIONS
    ].join('\n\n---\n\n');

    const parsed = await callDeepSeekJSON({
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }],
      schema: ChatResponseSchema,
      maxTokens: 1024
    });

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
    console.error('❌ Support-Chat Fehler:', error);
    res.status(500).json({ error: 'Fehler im Support-Chat: ' + error.message });
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
