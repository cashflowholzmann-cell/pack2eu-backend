const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET fehlt in der .env — Server wird nicht gestartet.');
}

function signToken(customer) {
  return jwt.sign(
    { sub: customer.id, customerNumber: customer.customer_number },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Kein Token übergeben.' });

  try {
    req.customer = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen.' });
  }
}

module.exports = { signToken, requireAuth };
