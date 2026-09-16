// routes/representatives.js
//
// Zugang für Bevollmächtigte (Partner, die in ihrem Land die rechtliche
// Vertretung unserer Kunden übernehmen). Kein Self-Service-Signup: Accounts
// werden ausschließlich von uns per Einladung angelegt (siehe
// routes/admin.js), und jeder Bevollmächtigte sieht ausschließlich die ihm
// explizit zugewiesenen Kunden (representative_customer_assignments) -
// nicht automatisch "alle Kunden seines Landes". Login läuft zweistufig:
// Passwort, danach ein per E-Mail zugestellter Bestätigungscode - erst
// danach wird ein Token ausgestellt. Jeder Datenzugriff wird protokolliert
// (representative_access_log).
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { sendRepresentativeLoginCodeEmail } = require('../lib/email');

const router = express.Router();

// Login und Code-Verifizierung sind die einzigen Stellen, an denen jemand
// ohne gültiges Token Kundendaten-nahe Aktionen auslösen kann (Bestätigungs-
// Mail, Passwort-Rateversuche) - deshalb strikter begrenzt als der Rest.
const repAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});

function requireRepRole(req, res, next) {
  if (!req.auth || req.auth.role !== 'representative') {
    return res.status(403).json({ error: 'Nur für Bevollmächtigte.' });
  }
  next();
}

function logAccess(representativeId, customerId, action, req) {
  try {
    db.prepare(`
      INSERT INTO representative_access_log (representative_id, customer_id, action, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(representativeId, customerId ?? null, action, req.ip || null);
  } catch (err) {
    console.error('❌ Zugriffs-Protokoll konnte nicht geschrieben werden:', err.message);
  }
}


// ============================================================
// KUNDE GIBT BEIM LAND-AKTIVIEREN EINEN VORHANDENEN BEVOLLMÄCHTIGTEN AN
//
// Wird von routes/activations.js bei jedem Anlegen/Ändern einer
// Aktivierung mit representative_email aufgerufen (nicht hier als
// eigener Endpoint, sondern direkt als Funktion, da es Teil des
// bestehenden Aktivierungs-Formulars ist statt eines separaten Schritts).
//
// Ist die angegebene E-Mail bereits ein bei uns aktiver, verifizierter
// Bevollmächtigten-Account für genau dieses Land: sofort automatisch
// verbinden (assigned_by='auto_match') - der Kunde kennt seinen Partner
// ja bereits, keine weitere Prüfung nötig. Ist die E-Mail unbekannt:
// KEIN automatisches Anlegen+Einladen (das wäre ein Scam-Vektor - jeder
// könnte durch bloßes Eintippen einer E-Mail eine Einladung mit
// Datenzugriff auslösen) - stattdessen landet sie als "pending" in der
// Admin-Queue (siehe /admin/representative-requests).
//
// Löst nur "auto_match"-Zuweisungen wieder, nie von einem Admin manuell
// gesetzte (assigned_by='admin') - eine Änderung/Löschung der vom Kunden
// eingetragenen E-Mail darf keine bewusste Admin-Entscheidung umwerfen.
function syncCustomerRepresentativeRequest(customerId, countryCode, email) {
  const cleanEmail = String(email || '').trim().toLowerCase();

  const previousRequest = db.prepare(`
    SELECT representative_id, status
    FROM customer_representative_requests
    WHERE customer_id = ? AND country_code = ?
  `).get(customerId, countryCode);

  function releasePreviousAutoMatch() {
    if (previousRequest?.status === 'matched' && previousRequest.representative_id) {
      db.prepare(`
        DELETE FROM representative_customer_assignments
        WHERE representative_id = ? AND customer_id = ? AND assigned_by = 'auto_match'
      `).run(previousRequest.representative_id, customerId);
    }
  }

  if (!cleanEmail) {
    releasePreviousAutoMatch();
    db.prepare(`
      DELETE FROM customer_representative_requests
      WHERE customer_id = ? AND country_code = ?
    `).run(customerId, countryCode);
    return;
  }

  const knownRep = db.prepare(`
    SELECT id FROM representatives
    WHERE email = ? AND country_code = ? AND active = 1 AND email_verified_at IS NOT NULL
  `).get(cleanEmail, countryCode);

  if (knownRep && previousRequest?.representative_id !== knownRep.id) {
    releasePreviousAutoMatch();
  }

  db.prepare(`
    INSERT INTO customer_representative_requests (customer_id, country_code, requested_email, status, representative_id, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(customer_id, country_code) DO UPDATE SET
      requested_email = excluded.requested_email,
      status = excluded.status,
      representative_id = excluded.representative_id,
      updated_at = datetime('now')
  `).run(customerId, countryCode, cleanEmail, knownRep ? 'matched' : 'pending', knownRep ? knownRep.id : null);

  if (knownRep) {
    db.prepare(`
      INSERT OR IGNORE INTO representative_customer_assignments (representative_id, customer_id, assigned_by)
      VALUES (?, ?, 'auto_match')
    `).run(knownRep.id, customerId);
  }
}


// ============================================================
// EINLADUNG ANNEHMEN (Passwort erstmalig festlegen)
//
// POST /api/representatives/accept-invite
// Body: { token, password }
// ============================================================

router.post('/accept-invite', repAuthLimiter, (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');

  if (!token || password.length < 8) {
    return res.status(400).json({ error: 'Ungültiger Link oder Passwort zu kurz (mind. 8 Zeichen).' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const rep = db.prepare(`
      SELECT id, invite_expires_at
      FROM representatives
      WHERE invite_token_hash = ?
    `).get(tokenHash);

    if (!rep || !rep.invite_expires_at || new Date(rep.invite_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Der Einladungslink ist ungültig oder abgelaufen. Bitte beim Pack2EU-Team einen neuen anfordern.' });
    }

    const passwordHash = bcrypt.hashSync(password, 12);

    db.prepare(`
      UPDATE representatives
      SET password_hash = ?, email_verified_at = datetime('now'),
          invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = ?
    `).run(passwordHash, rep.id);

    return res.json({ success: true, message: 'Account aktiviert. Du kannst dich jetzt einloggen.' });
  } catch (error) {
    console.error('❌ Accept-Invite-Fehler:', error);
    return res.status(500).json({ error: 'Einladung konnte nicht angenommen werden.' });
  }
});


// ============================================================
// LOGIN, SCHRITT 1: PASSWORT
//
// Stellt noch KEIN Token aus - schickt bei korrektem Passwort einen
// Bestätigungscode per E-Mail (siehe /verify-login-code).
//
// POST /api/representatives/login
// Body: { email, password }
// ============================================================

router.post('/login', repAuthLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const genericError = { error: 'E-Mail oder Passwort falsch.' };

  if (!email || !password) return res.status(401).json(genericError);

  try {
    const rep = db.prepare('SELECT * FROM representatives WHERE email = ?').get(email);

    if (!rep || !rep.password_hash || !bcrypt.compareSync(password, rep.password_hash)) {
      return res.status(401).json(genericError);
    }
    if (!rep.active) {
      return res.status(403).json({ error: 'Dieser Zugang ist deaktiviert. Bitte an Pack2EU wenden.' });
    }
    if (!rep.email_verified_at) {
      return res.status(403).json({ error: 'Bitte zuerst die Einladung über den Link in deiner E-Mail annehmen.' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE representatives
      SET login_code_hash = ?, login_code_expires_at = ?
      WHERE id = ?
    `).run(codeHash, expiresAt, rep.id);

    await sendRepresentativeLoginCodeEmail(rep.email, code);

    return res.json({ requiresCode: true, message: 'Bestätigungscode wurde per E-Mail verschickt.' });
  } catch (error) {
    console.error('❌ Representative-Login-Fehler:', error);
    return res.status(500).json({ error: 'Login fehlgeschlagen.' });
  }
});


// ============================================================
// LOGIN, SCHRITT 2: BESTÄTIGUNGSCODE
//
// POST /api/representatives/verify-login-code
// Body: { email, code }
// ============================================================

router.post('/verify-login-code', repAuthLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const genericError = { error: 'Code ungültig oder abgelaufen.' };

  if (!email || !code) return res.status(401).json(genericError);

  try {
    const rep = db.prepare('SELECT * FROM representatives WHERE email = ?').get(email);
    if (!rep || !rep.active || !rep.login_code_hash || !rep.login_code_expires_at) {
      return res.status(401).json(genericError);
    }
    if (new Date(rep.login_code_expires_at) < new Date()) {
      return res.status(401).json(genericError);
    }

    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    if (codeHash !== rep.login_code_hash) {
      return res.status(401).json(genericError);
    }

    db.prepare(`
      UPDATE representatives
      SET login_code_hash = NULL, login_code_expires_at = NULL, last_login_at = datetime('now')
      WHERE id = ?
    `).run(rep.id);

    const token = signToken({ sub: rep.id, role: 'representative' });
    logAccess(rep.id, null, 'login', req);

    return res.json({
      token,
      representative: { id: rep.id, name: rep.name, email: rep.email, country_code: rep.country_code }
    });
  } catch (error) {
    console.error('❌ Verify-Login-Code-Fehler:', error);
    return res.status(500).json({ error: 'Code konnte nicht geprüft werden.' });
  }
});


// ============================================================
// ZUGEWIESENE KUNDEN
//
// Nur Firmenname/Kontaktdaten/Registrierdaten, die für die Vertretung
// nötig sind - keine Zahlungs-/Abo-Interna (Stripe-IDs o.ä.).
//
// GET /api/representatives/customers
// ============================================================

// ============================================================
// EIGENE STAMMDATEN (für den Seiten-Reload, ohne erneuten Login)
//
// GET /api/representatives/me
// ============================================================

router.get('/me', requireAuth, requireRepRole, (req, res) => {
  const rep = db.prepare('SELECT id, name, email, country_code, active FROM representatives WHERE id = ?')
    .get(req.auth.userId);
  if (!rep || !rep.active) return res.status(404).json({ error: 'Bevollmächtigter nicht gefunden.' });
  res.json({ id: rep.id, name: rep.name, email: rep.email, country_code: rep.country_code });
});

router.get('/customers', requireAuth, requireRepRole, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.customer_number, c.company_name, c.contact_name, c.email, c.origin_country
      FROM customers c
      JOIN representative_customer_assignments rca ON rca.customer_id = c.id
      WHERE rca.representative_id = ?
      ORDER BY c.company_name
    `).all(req.auth.userId);

    logAccess(req.auth.userId, null, 'list_customers', req);

    res.json(rows);
  } catch (error) {
    console.error('❌ Representative-Customers-Fehler:', error);
    res.status(500).json({ error: 'Kunden konnten nicht geladen werden.' });
  }
});


// ============================================================
// EINGEHENDE MELDUNGEN FÜR DAS EIGENE LAND
//
// Scoped auf tatsächlich zugewiesene Kunden (nicht mehr "alle Kunden
// dieses Landes") + zusätzlich auf das eigene Land als zweite Absicherung.
//
// GET /api/representatives/submissions
// ============================================================

router.get('/submissions', requireAuth, requireRepRole, (req, res) => {
  try {
    const rep = db.prepare('SELECT country_code FROM representatives WHERE id = ?').get(req.auth.userId);
    if (!rep) return res.status(404).json({ error: 'Bevollmächtigter nicht gefunden.' });

    const rows = db.prepare(`
      SELECT s.*, c.company_name, c.customer_number
      FROM submissions s
      JOIN customers c ON c.id = s.customer_id
      JOIN representative_customer_assignments rca ON rca.customer_id = c.id
      WHERE rca.representative_id = ?
        AND s.destination = ?
      ORDER BY s.created_at DESC
    `).all(req.auth.userId, rep.country_code);

    logAccess(req.auth.userId, null, 'list_submissions', req);

    res.json(rows);
  } catch (error) {
    console.error('❌ Representative-Submissions-Fehler:', error);
    res.status(500).json({ error: 'Meldungen konnten nicht geladen werden.' });
  }
});

router.syncCustomerRepresentativeRequest = syncCustomerRepresentativeRequest;
module.exports = router;
