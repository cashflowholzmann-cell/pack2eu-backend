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
const rateLimit = require('express-rate-limit');
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

module.exports = router;
