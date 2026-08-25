const jwt = require('jsonwebtoken');

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
// EXPORT
// ============================================================

module.exports = {
  signToken,
  requireAuth,
  requireCustomer,
  requireRepresentative
};
