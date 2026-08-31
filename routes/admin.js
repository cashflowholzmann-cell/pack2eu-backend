// routes/admin.js
//
// Internes Vertriebs-/Marketing-Tool: Traffic-Übersicht (woher kommen die
// Besucher), Leads (auch Telefon-Interessenten, die nie ein Formular
// ausfüllen) und einfache Aufgabenverwaltung - alles an einem Ort.
//
// Eigenes, einfaches Admin-Login statt eines vollen Rollensystems: ein
// gemeinsames Passwort aus der Env-Var ADMIN_PASSWORD. Reicht für ein
// One-Person/Kleinteam-Tool; kein Ersatz für echtes Nutzer-Management,
// falls mehrere Personen mit unterschiedlichen Rechten dazukommen.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
// zodOutputFormat() liest Schemas über die zod/v4-Introspection - siehe
// die Erklärung in routes/feedback.js.
const { z } = require('zod/v4');
const { db } = require('../db');
const { signToken, requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Nur auf /login - der Rest des Routers braucht viele Anfragen für
// normale Nutzung (Übersicht, Leads, Aufgaben laden/ändern) und darf
// dadurch nicht ausgebremst werden.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});

// ============================================================
// LOGIN
// ============================================================
router.post('/login', adminLoginLimiter, (req, res) => {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) {
    return res.status(503).json({ error: 'Admin-Zugang ist noch nicht eingerichtet (ADMIN_PASSWORD fehlt).' });
  }

  const provided = String(req.body?.password || '');
  const a = Buffer.from(provided.padEnd(configured.length, '\0'));
  const b = Buffer.from(configured.padEnd(provided.length, '\0'));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b) && provided.length === configured.length;

  if (!matches) {
    return res.status(401).json({ error: 'Falsches Passwort.' });
  }

  const token = signToken({ sub: 1, role: 'admin' });
  res.json({ token });
});

router.use(requireAuth, requireAdmin);

// ============================================================
// ÜBERSICHT
// ============================================================
function classifyChannel(row) {
  if (row.utm_source) return row.utm_source.toLowerCase();
  const ref = (row.referrer || '').toLowerCase();
  if (!ref) return 'direkt';
  if (/facebook|instagram|tiktok|linkedin|twitter|x\.com|pinterest/.test(ref)) return 'social_media';
  if (/google|bing|duckduckgo|yahoo/.test(ref)) return 'suchmaschine';
  return 'sonstige_website';
}

router.get('/overview', (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const views30d = db.prepare('SELECT referrer, utm_source, created_at FROM page_views WHERE created_at >= ?').all(since30d);
    const viewsByChannel = {};
    views30d.forEach(v => {
      const ch = classifyChannel(v);
      viewsByChannel[ch] = (viewsByChannel[ch] || 0) + 1;
    });

    const viewsLast7d = views30d.filter(v => v.created_at >= since7d).length;

    const leadsBySource = db.prepare(`
      SELECT source, COUNT(*) as count FROM leads GROUP BY source
    `).all();

    const leadsByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM leads GROUP BY status
    `).all();

    const customersByAcquisition = db.prepare(`
      SELECT COALESCE(acquisition_source, 'organisch') as source, COUNT(*) as count
      FROM customers GROUP BY COALESCE(acquisition_source, 'organisch')
    `).all();

    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers) as totalCustomers,
        (SELECT COUNT(*) FROM customers WHERE subscription_status = 'active') as activeCustomers,
        (SELECT COUNT(*) FROM leads WHERE status NOT IN ('converted', 'lost')) as openLeads,
        (SELECT COUNT(*) FROM admin_tasks WHERE status = 'open') as openTasks,
        (SELECT COUNT(*) FROM page_views WHERE created_at >= ?) as views30d
    `).get(since30d);

    res.json({
      totals: { ...totals, viewsLast7d },
      viewsByChannel,
      leadsBySource,
      leadsByStatus,
      customersByAcquisition
    });
  } catch (error) {
    console.error('❌ Admin-Overview-Fehler:', error);
    res.status(500).json({ error: 'Übersicht konnte nicht geladen werden.' });
  }
});

// ============================================================
// LEADS
// ============================================================
router.get('/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(leads);
});

router.post('/leads', (req, res) => {
  const { name, contact, source, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name ist erforderlich.' });

  const result = db.prepare(`
    INSERT INTO leads (name, contact, source, notes)
    VALUES (?, ?, ?, ?)
  `).run(name, contact || null, source || 'other', notes || null);

  res.status(201).json(db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/leads/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Lead nicht gefunden.' });

  const { name, contact, source, status, notes } = req.body || {};
  db.prepare(`
    UPDATE leads
    SET name = COALESCE(?, name),
        contact = ?,
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(name || null, contact ?? null, source || null, status || null, notes ?? null, req.params.id);

  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id));
});

router.delete('/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// AUFGABEN
// ============================================================
router.get('/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, l.name as lead_name
    FROM admin_tasks t
    LEFT JOIN leads l ON l.id = t.related_lead_id
    ORDER BY (t.status = 'done'), COALESCE(t.due_date, '9999-12-31'), t.created_at
  `).all();
  res.json(tasks);
});

router.post('/tasks', (req, res) => {
  const { title, due_date, related_lead_id } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Titel ist erforderlich.' });

  const result = db.prepare(`
    INSERT INTO admin_tasks (title, due_date, related_lead_id)
    VALUES (?, ?, ?)
  `).run(title, due_date || null, related_lead_id || null);

  res.status(201).json(db.prepare('SELECT * FROM admin_tasks WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM admin_tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });

  const { title, due_date, status } = req.body || {};
  db.prepare(`
    UPDATE admin_tasks
    SET title = COALESCE(?, title),
        due_date = ?,
        status = COALESCE(?, status),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(title || null, due_date ?? null, status || null, req.params.id);

  res.json(db.prepare('SELECT * FROM admin_tasks WHERE id = ?').get(req.params.id));
});

router.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM admin_tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// KUNDEN (Lese-Übersicht fürs Vertriebs-Tool)
// ============================================================
router.get('/customers', (req, res) => {
  const customers = db.prepare(`
    SELECT id, customer_number, company_name, email, plan, subscription_status,
           acquisition_source, created_at
    FROM customers
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  res.json(customers);
});

// ============================================================
// DATENBANK-BACKUP HERUNTERLADEN
//
// Nutzt SQLites Online-Backup-API (nicht einfach die Datei kopieren -
// bei aktivem WAL-Modus könnte eine rohe Dateikopie unvollständig/
// inkonsistent sein). Der Download landet auf dem Rechner der Person,
// die ihn auslöst - das ist aktuell der einzige echte Off-Server-
// Backup-Weg, solange kein Cloud-Speicher (S3 o. ä.) angebunden ist.
// ============================================================
router.get('/backup/download', async (req, res) => {
  const tempPath = path.join(os.tmpdir(), `pack2eu-backup-${Date.now()}.db`);

  try {
    await db.backup(tempPath);

    const stamp = new Date().toISOString().slice(0, 10);
    res.download(tempPath, `pack2eu-backup-${stamp}.db`, (err) => {
      fs.unlink(tempPath, () => {});
      if (err) console.error('❌ Backup-Download-Fehler:', err.message);
    });
  } catch (error) {
    console.error('❌ Backup-Fehler:', error);
    fs.unlink(tempPath, () => {});
    res.status(500).json({ error: 'Backup konnte nicht erstellt werden.' });
  }
});

// ============================================================
// THEMENANALYSE (häufigste Anliegen aus Feedback + Support-Chat)
//
// Läuft NICHT automatisch bei jedem Laden des Tools, sondern nur auf
// Knopfdruck ("Jetzt analysieren") - jeder Lauf kostet einen echten
// KI-Aufruf. Das letzte Ergebnis wird in topic_analysis
// zwischengespeichert, damit man beim Öffnen des Tools sofort etwas
// sieht, ohne erneut zu bezahlen.
// ============================================================
const TopicsSchema = z.object({
  topics: z.array(z.object({
    topic: z.string(),
    count: z.number().int(),
    example_quotes: z.array(z.string()).max(3)
  })).max(10)
});

const TOPICS_SYSTEM_PROMPT = `
Du bekommst eine Liste von Kunden-Feedback- und Support-Chat-Nachrichten
für die SaaS Pack2EU (EU-Verpackungscompliance für Online-Händler).

Fasse sie in maximal 10 wiederkehrende Themen/Anliegen zusammen, sortiert
nach Häufigkeit (häufigstes zuerst). Fasse inhaltlich ähnliche Nachrichten
zu einem Thema zusammen (z. B. mehrere Fragen zu Frankreich-EPR als ein
Thema). Ignoriere reinen Spam oder Einzelfälle ohne Muster - die müssen
nicht als eigenes Thema auftauchen.

Für jedes Thema:
- "topic": kurzer, konkreter Titel auf Deutsch (max. 8 Wörter)
- "count": wie viele der gegebenen Nachrichten zu diesem Thema passen
- "example_quotes": 1-3 kurze, wörtliche Ausschnitte als Beleg (max. 25 Wörter je Zitat)

Wenn die Liste zu wenige/zu unterschiedliche Nachrichten für erkennbare
Muster enthält, gib weniger oder gar keine Themen zurück statt Themen zu
erfinden.
`.trim();

router.get('/topics', (req, res) => {
  const latest = db.prepare('SELECT * FROM topic_analysis ORDER BY created_at DESC LIMIT 1').get();
  if (!latest) return res.json({ topics: [], sourceCount: 0, analyzedAt: null });
  res.json({ topics: JSON.parse(latest.results_json), sourceCount: latest.source_count, analyzedAt: latest.created_at });
});

router.post('/topics/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Themenanalyse ist noch nicht eingerichtet (ANTHROPIC_API_KEY fehlt).' });
  }

  try {
    const feedbackRows = db.prepare(`
      SELECT message FROM feedback
      WHERE category IS NULL OR category != 'spam'
      ORDER BY created_at DESC LIMIT 150
    `).all();
    const supportRows = db.prepare(`
      SELECT content FROM support_messages
      WHERE role = 'user'
      ORDER BY created_at DESC LIMIT 150
    `).all();

    const items = [
      ...feedbackRows.map(r => `[Feedback] ${r.message}`),
      ...supportRows.map(r => `[Support-Chat] ${r.content}`)
    ];

    if (items.length === 0) {
      return res.json({ topics: [], sourceCount: 0, analyzedAt: null });
    }

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 2048,
      output_config: {
        format: zodOutputFormat(TopicsSchema),
        effort: 'medium'
      },
      system: TOPICS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: items.map((t, i) => `${i + 1}. ${t}`).join('\n') }]
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      return res.status(502).json({ error: 'Analyse konnte nicht verarbeitet werden.' });
    }

    db.prepare('INSERT INTO topic_analysis (results_json, source_count) VALUES (?, ?)')
      .run(JSON.stringify(parsed.topics), items.length);

    res.json({ topics: parsed.topics, sourceCount: items.length, analyzedAt: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Themenanalyse-Fehler:', error);
    res.status(503).json({ error: 'Themenanalyse gerade nicht verfügbar. Bitte später erneut versuchen.' });
  }
});

module.exports = router;
