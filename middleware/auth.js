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

function signToken(identity) {
  const role = identity.role || 'customer';

  return jwt.sign(
    {
      sub: identity.sub,
      role,
      customerNumber:
        identity.customer_number ||
        identity.customerNumber ||
        null
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
      ? header.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      error: 'Kein Token übergeben.'
    });
  }

  try {

    const payload =
      jwt.verify(token, JWT_SECRET);

    req.auth = {
      userId: Number(payload.sub),

      role:
        payload.role ||
        'customer',

      customerNumber:
        payload.customerNumber ||
        null
    };

    next();

  } catch (error) {

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
        'Nur Beauftragte dürfen diese Funktion verwenden.'
    });
  }

  next();
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  signToken,
  requireAuth,
  requireCustomer,
  requireRepresentative
};
