const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET fehlt in der .env — Server wird nicht gestartet.'
  );
}


// ============================================================
// TOKEN ERSTELLEN
// ============================================================

// options.expiresIn / options.extra: nur für Admin-Impersonation genutzt
// (siehe routes/admin.js POST /customers/:id/impersonate) - ein kürzeres
// Ablaufdatum und eine zusätzliche impersonatedBy-Markierung im Token,
// damit ein Impersonation-Token im Zweifel (z.B. in Logs) von einem
// normalen Kunden-Login unterscheidbar bleibt. Alle bestehenden Aufrufer
// übergeben kein options-Objekt und bekommen exakt das bisherige
// Verhalten (7 Tage, keine Zusatzclaims).
function signToken(identity = {}, options = {}) {

  const role =
    identity.role ||
    'customer';

  const subject =
    identity.sub ??
    identity.id;

  if (!subject) {
    throw new Error(
      'Token kann ohne Benutzer-ID nicht erstellt werden.'
    );
  }

  const customerNumber =
    identity.customer_number ??
    identity.customerNumber ??
    null;

  return jwt.sign(
    {
      sub: Number(subject),
      role,
      customerNumber,
      ...(options.extra || {})
    },
    JWT_SECRET,
    {
      expiresIn: options.expiresIn || '7d'
    }
  );
}


// ============================================================
// AUTHENTIFIZIERUNG
// ============================================================

function requireAuth(req, res, next) {

  const header =
    req.headers.authorization || '';

  const token =
    header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : null;

  if (!token) {

    return res.status(401).json({
      error: 'Kein Token übergeben.'
    });
  }

  try {

    const payload =
      jwt.verify(
        token,
        JWT_SECRET
      );

    const userId =
      Number(payload.sub);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {

      return res.status(401).json({
        error:
          'Token enthält keine gültige Benutzer-ID.'
      });
    }

    req.auth = {

      userId,

      role:
        payload.role ||
        'customer',

      customerNumber:
        payload.customerNumber ||
        null,

      // Nur gesetzt, wenn dieses Token von POST /admin/customers/:id/
      // impersonate ausgestellt wurde (siehe signToken()) - Routen/Frontend
      // können daran eine Admin-Impersonation-Sitzung erkennen, ohne dafür
      // eine eigene Session-Tabelle führen zu müssen.
      impersonatedBy:
        payload.impersonatedBy ||
        null

    };

    // Compatibility for existing route modules. New code should use req.auth.
    req.customer = {
      sub: userId,
      role: req.auth.role,
      customerNumber: req.auth.customerNumber
    };

    next();

  } catch (error) {

    console.error(
      '❌ JWT Fehler:',
      error.message
    );

    return res.status(401).json({
      error:
        'Token ungültig oder abgelaufen.'
    });
  }
}


// ============================================================
// NUR HÄNDLER
// ============================================================

function requireCustomer(req, res, next) {

  if (
    !req.auth ||
    req.auth.role !== 'customer'
  ) {

    return res.status(403).json({
      error:
        'Nur Händler dürfen diese Funktion verwenden.'
    });
  }

  next();
}


// ============================================================
// NUR BEVOLLMÄCHTIGTE
// ============================================================

function requireRepresentative(req, res, next) {

  if (
    !req.auth ||
    req.auth.role !== 'representative'
  ) {

    return res.status(403).json({
      error:
        'Nur Bevollmächtigte dürfen diese Funktion verwenden.'
    });
  }

  next();
}


// ============================================================
// NUR ADMIN (internes Vertriebs-/Marketing-Tool, siehe routes/admin.js)
// ============================================================

function requireAdmin(req, res, next) {

  if (
    !req.auth ||
    req.auth.role !== 'admin'
  ) {

    return res.status(403).json({
      error:
        'Nur für Admins.'
    });
  }

  next();
}


// ============================================================
// AKTIVES ABO ERFORDERLICH
// ============================================================
// Schützt die eigentliche Produktnutzung (Aktivierungen, Bestellungen,
// Compliance-Prüfungen, Berichte, ...): ein registrierter, aber noch
// nicht bezahlter Kunde (subscription_status != 'active') darf sich
// zwar einloggen, bekommt hier aber eine klare Zahlungs-Aufforderung
// statt echten Zugriff. Gilt nur für die Rolle "customer" -
// Beauftragte haben kein eigenes Abo und werden durchgelassen.
function requireActiveSubscription(req, res, next) {

  if (!req.auth || req.auth.role !== 'customer') {
    return next();
  }

  const customer = db.prepare(
    'SELECT subscription_status, trial_ends_at FROM customers WHERE id = ?'
  ).get(req.auth.userId);

  if (!customer) {
    return res.status(402).json({
      error: 'Bitte zuerst die Zahlung abschließen, um Pack2EU zu nutzen.'
    });
  }

  if (customer.subscription_status === 'active') {
    return next();
  }

  // Kartenloser 14-Tage-Trial (siehe routes/auth.js registerSchema.
  // cardlessTrial): kein Stripe-Objekt existiert, daher kein Webhook, der
  // den Status am Tag 15 automatisch umschaltet - stattdessen wird
  // trial_ends_at bei jedem Request live geprüft (kein Cron-Job nötig).
  // Lazy-Flip auf 'inactive' bei Ablauf, damit der Status in der DB nicht
  // dauerhaft fälschlich 'trialing' zeigt (u.a. relevant fürs Admin-Tool).
  if (customer.subscription_status === 'trialing') {
    const stillInTrial = db.prepare(
      "SELECT trial_ends_at > datetime('now') AS valid FROM customers WHERE id = ?"
    ).get(req.auth.userId);

    if (stillInTrial && stillInTrial.valid) {
      return next();
    }

    db.prepare(
      "UPDATE customers SET subscription_status = 'inactive' WHERE id = ? AND subscription_status = 'trialing'"
    ).run(req.auth.userId);

    return res.status(402).json({
      error: 'Deine 14 kostenlosen Tage sind abgelaufen. Bitte hinterlege eine Zahlungsmethode, um Pack2EU weiter zu nutzen.',
      trialExpired: true
    });
  }

  return res.status(402).json({
    error: 'Bitte zuerst die Zahlung abschließen, um Pack2EU zu nutzen.'
  });
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {
  signToken,
  requireAuth,
  requireCustomer,
  requireRepresentative,
  requireActiveSubscription,
  requireAdmin
};
