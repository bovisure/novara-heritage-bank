const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');
const { sendOTP } = require('../utils/email');
const { setOTP, checkOTP } = require('../utils/otp');
const router = express.Router();

function generateAccountNumber() {
  return 'ACC' + Date.now() + Math.floor(Math.random() * 1000);
}

// ── POST /api/auth/register/send-otp ─────────────────────────────────────────
// Step 1 of registration: validate email is free, send OTP
router.post('/register/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  if (db.users.findOne(u => u.email === email))
    return res.status(400).json({ error: 'This email is already registered. Please sign in instead.' });

  try {
    const code = setOTP(email, 'register');
    await sendOTP(email, code, 'register');
    res.json({ message: 'Verification code sent to your email' });
  } catch (e) {
    console.error('OTP send error:', e.message);
    res.status(500).json({ error: 'Failed to send verification code. Please check the email address and try again.' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
// Step 2: verify OTP + create account with all new fields
router.post('/register', async (req, res) => {
  const {
    name, email, phone,
    street, city, state, zip,
    account_type, password, confirm_password,
    otp_code, transaction_pin
  } = req.body;

  if (!name || !email || !phone || !password || !otp_code || !transaction_pin)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (password !== confirm_password)
    return res.status(400).json({ error: 'Passwords do not match' });
  if (!/^\d{4}$/.test(transaction_pin))
    return res.status(400).json({ error: 'Transfer PIN must be exactly 4 digits' });

  // Check email before consuming OTP
  if (db.users.findOne(u => u.email === email))
    return res.status(400).json({ error: 'Email already registered' });

  // Verify OTP (consumes it — one-time use)
  const otpResult = checkOTP(email, otp_code, 'register');
  if (!otpResult.ok) return res.status(400).json({ error: otpResult.error });

  try {
    const routing_number = db.generateRoutingNumber();

    const user = db.users.insert({
      name, email, phone,
      address: { street: street || '', city: city || '', state: state || '', zip: zip || '' },
      password_hash: bcrypt.hashSync(password, 10),
      transaction_pin_hash: bcrypt.hashSync(transaction_pin, 10),
      account_number: generateAccountNumber(),
      routing_number,
      swift_code: 'NVRAUS33XXX',
      bank_type: 'Online Banking',
      account_type: account_type || 'checking',
      balance: 0,         // checking balance
      savings_balance: 0, // savings balance
      role: 'user',
      status: 'active',
      email_verified: true
    });

    db.activity.insert({
      user_id: user.id, user_name: user.name, user_email: user.email,
      account_no: user.account_number, action: 'register',
      details: `New account registered (${user.account_type} account)`, page: 'auth'
    });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    const { password_hash, transaction_pin_hash, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Step 1 of login: validate credentials, send OTP (admin bypasses OTP)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.users.findOne(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (user.status === 'frozen')
    return res.status(403).json({ error: 'Your account has been frozen. Please contact support.' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    db.activity.insert({
      user_id: user.id, user_name: user.name, user_email: user.email,
      account_no: user.account_number, action: 'login_failed',
      details: 'Failed login attempt — wrong password', page: 'auth'
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Admin bypasses 2FA
  if (user.role === 'admin') {
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    db.activity.insert({
      user_id: user.id, user_name: 'Admin', user_email: user.email,
      account_no: 'ADMIN', action: 'login', details: 'Admin logged in', page: 'auth'
    });
    const { password_hash, transaction_pin_hash, ...safeUser } = user;
    return res.json({ token, user: safeUser });
  }

  // Regular user: send OTP
  try {
    const code = setOTP(email, 'login');
    await sendOTP(email, code, 'login');
    res.json({ step: 'otp', message: 'Verification code sent to your email' });
  } catch (e) {
    console.error('OTP send error:', e.message);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// ── POST /api/auth/login/verify ───────────────────────────────────────────────
// Step 2 of login: verify OTP → return token
router.post('/login/verify', (req, res) => {
  const { email, otp_code } = req.body;
  if (!email || !otp_code) return res.status(400).json({ error: 'Email and code are required' });

  const result = checkOTP(email, otp_code, 'login');
  if (!result.ok) return res.status(400).json({ error: result.error });

  const user = db.users.findOne(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.status === 'frozen')
    return res.status(403).json({ error: 'Your account has been frozen. Please contact support.' });

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  db.activity.insert({
    user_id: user.id, user_name: user.name, user_email: user.email,
    account_no: user.account_number, action: 'login',
    details: 'Logged in with email OTP verification', page: 'auth'
  });
  const { password_hash, transaction_pin_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

module.exports = router;
