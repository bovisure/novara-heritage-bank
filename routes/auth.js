const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');
const router = express.Router();

function generateAccountNumber() {
  return 'ACC' + Date.now() + Math.floor(Math.random() * 1000);
}

router.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    if (db.users.findOne(u => u.email === email))
      return res.status(400).json({ error: 'Email already registered' });

    const user = db.users.insert({
      name, email,
      password_hash: bcrypt.hashSync(password, 10),
      account_number: generateAccountNumber(),
      balance: 0, role: 'user', status: 'active'
    });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    db.activity.insert({ user_id: user.id, user_name: user.name, user_email: user.email, account_no: user.account_number, action: 'register', details: 'New account registered', page: 'auth' });
    const { password_hash, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.users.findOne(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'frozen') return res.status(403).json({ error: 'Your account has been frozen. Contact support.' });

  if (!bcrypt.compareSync(password, user.password_hash)) {
    db.activity.insert({ user_id: user.id, user_name: user.name, user_email: user.email, account_no: user.account_number, action: 'login_failed', details: 'Failed login attempt — wrong password', page: 'auth' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  db.activity.insert({ user_id: user.id, user_name: user.name, user_email: user.email, account_no: user.account_number, action: 'login', details: 'Logged in successfully', page: 'auth' });
  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

module.exports = router;
