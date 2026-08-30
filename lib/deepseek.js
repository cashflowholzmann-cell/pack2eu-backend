// lib/deepseek.js
//
// Duenner HTTP-Client fuer die DeepSeek Chat-Completions-API
// (OpenAI-kompatibel: POST https://api.deepseek.com/chat/completions).
// Kein eigenes SDK noetig, axios ist ohnehin schon Abhaengigkeit.
//
// DeepSeek erzwingt kein JSON-Schema serverseitig (response_format nur
// "json_object", kein "json_schema" mit Struktur wie beim vorherigen
// Anthropic-Client) - das erwartete Format muss daher explizit im
// System-Prompt beschrieben werden, und die Antwort wird hier gegen
// das uebergebene Zod-Schema validiert.
const axios = require('axios');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// Gibt bei fehlendem Key, ungueltigem JSON oder Schema-Verstoss null
// zurueck, statt zu werfen - die aufrufende Route entscheidet dann
// selbst ueber den Fallback (z. B. Feedback trotzdem ohne Kategorie
// speichern). Echte Netzwerk-/API-Fehler werden weitergereicht, dafuer
// hat jede Route bereits einen umschliessenden try/catch.
async function callDeepSeekJSON({ system, messages, schema, maxTokens = 1024 }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const response = await axios.post(
    `${DEEPSEEK_BASE_URL}/chat/completions`,
    {
      // "deepseek-chat" wurde am 24.07.2026 abgeschaltet (liefert seither
      // Fehler statt Antworten) - deepseek-v4-flash ist der guenstige
      // Nachfolger, passend fuer kurze Chat-Antworten/Klassifikation
      // (die teurere deepseek-v4-pro-Reasoning-Stufe brauchen wir hier
      // nicht).
      model: 'deepseek-v4-flash',
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, ...messages]
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) return null;

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return null;
  }

  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}

module.exports = { callDeepSeekJSON };
