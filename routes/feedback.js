// routes/feedback.js
//
// "Verbesserungsvorschlag"-Button im Dashboard. Jede Einreichung wird
// sofort per KI in spam / useful / very_useful eingeordnet; bei
// useful/very_useful geht eine Benachrichtigung an FEEDBACK_WEBHOOK_URL
// raus (ein einfacher Webhook-POST - kompatibel mit Slack/Discord/
// Zapier/Make, die wiederum an E-Mail weiterleiten können). Es gibt
// hier bewusst keine eigene SMTP-Integration, da dafür echte
// Mail-Zugangsdaten nötig wären.
const express = require('express');
const { z } = require('zod');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { db } = require('../db');
const { requireAuth, requireCustomer } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireCustomer);

const ClassificationSchema = z.object({
  category: z.enum(['spam', 'useful', 'very_useful']),
  reasoning: z.string()
});

const CLASSIFICATION_SYSTEM_PROMPT = `
Du sortierst eingereichte Verbesserungsvorschläge für die SaaS Pack2EU
(EU-Verpackungscompliance für Online-Händler) in genau eine Kategorie:

- "spam": kein echtes Feedback (leer, Werbung, Beleidigung, offensichtlich
  automatisiert, völlig themenfremd).
- "useful": ein nachvollziehbarer, konkreter Vorschlag oder Fehlerbericht,
  auch wenn er klein oder unscharf formuliert ist.
- "very_useful": ein besonders klarer, umsetzbarer Vorschlag mit
  erkennbarem Nutzen fürs Produkt, oder ein Bericht über einen echten
  Bug/eine echte Hürde im Produkt.

Gib eine kurze, konkrete Begründung (1-2 Sätze, Deutsch).
`.trim();

router.post('/', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Bitte gib einen Vorschlag ein.' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'Vorschlag ist zu lang (max. 4000 Zeichen).' });
  }

  const customerId = req.auth.userId;

  try {
    const customer = db.prepare('SELECT company_name, customer_number FROM customers WHERE id = ?').get(customerId);

    const insertResult = db.prepare('INSERT INTO feedback (customer_id, message) VALUES (?, ?)').run(customerId, message);
    const feedbackId = insertResult.lastInsertRowid;

    if (!process.env.ANTHROPIC_API_KEY) {
      // Ohne Schlüssel wird trotzdem gespeichert, nur ohne Einordnung/Benachrichtigung.
      return res.status(201).json({ ok: true, id: feedbackId, category: null });
    }

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 512,
      output_config: {
        format: zodOutputFormat(ClassificationSchema),
        effort: 'low'
      },
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }]
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      return res.status(201).json({ ok: true, id: feedbackId, category: null });
    }

    db.prepare('UPDATE feedback SET category = ?, ai_reasoning = ? WHERE id = ?')
      .run(parsed.category, parsed.reasoning, feedbackId);

    let notified = false;
    if (parsed.category !== 'spam' && process.env.FEEDBACK_WEBHOOK_URL) {
      try {
        await axios.post(process.env.FEEDBACK_WEBHOOK_URL, {
          text: `💡 Neuer Verbesserungsvorschlag (${parsed.category === 'very_useful' ? '🌟 äußerst nützlich' : '✅ nützlich'})\n`
            + `Von: ${customer?.company_name || 'Unbekannt'} (${customer?.customer_number || customerId})\n\n`
            + `„${message}"\n\nKI-Einschätzung: ${parsed.reasoning}`
        }, { timeout: 8000 });
        notified = true;
        db.prepare('UPDATE feedback SET notified = 1 WHERE id = ?').run(feedbackId);
      } catch (webhookError) {
        console.error('❌ Feedback-Webhook Fehler:', webhookError.message);
      }
    }

    res.status(201).json({ ok: true, id: feedbackId, category: parsed.category, notified });
  } catch (error) {
    console.error('❌ Feedback Fehler:', error);
    res.status(500).json({ error: 'Feedback konnte nicht gespeichert werden: ' + error.message });
  }
});

module.exports = router;
