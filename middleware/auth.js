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

function signToken(identity = {}) {

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
      customerNumber
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
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
    'SELECT subscription_status FROM customers WHERE id = ?'
  ).get(req.auth.userId);

  if (!customer || customer.subscription_status !== 'active') {
    return res.status(402).json({
      error: 'Bitte zuerst die Zahlung abschließen, um Pack2EU zu nutzen.'
    });
  }

  next();
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
