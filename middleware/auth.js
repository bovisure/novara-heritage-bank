const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'bankapp_secret_key_2024';

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check if admin force-logged out this user after the token was issued
    const db = require('../database');
    const user = db.users.findOne(u => u.id === decoded.id);
    if (user && user.force_logout_at && user.force_logout_at > decoded.iat * 1000) {
      return res.status(401).json({ error: 'Session terminated by administrator' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authenticate, adminOnly, JWT_SECRET };
