const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { setOTP, checkOTP } = require('../utils/otp');
const { sendOTP } = require('../utils/email');
const router = express.Router();

// GET /me
router.get('/me', authenticate, (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, transaction_pin_hash, ...safe } = user;
  safe.has_pin = !!user.transaction_pin_hash;
  res.json(safe);
});

// GET /transactions
router.get('/transactions', authenticate, (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const allUsers = db.users.findAll();
  const txns = db.transactions
    .findWhere(t => t.from_account === user.account_number || t.to_account === user.account_number)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50)
    .map(t => ({ ...t,
      sender_name:   allUsers.find(u => u.account_number === t.from_account)?.name || null,
      receiver_name: allUsers.find(u => u.account_number === t.to_account)?.name   || null,
    }));
  res.json(txns);
});

// POST /transfer
router.post('/transfer', authenticate, (req, res) => {
  const { to_account, amount, description, pin } = req.body;
  if (!to_account || !amount) return res.status(400).json({ error: 'Recipient account and amount are required' });
  if (!pin) return res.status(400).json({ error: 'Transfer PIN is required' });
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const sender = db.users.findOne(u => u.id === req.user.id);
  if (!sender) return res.status(404).json({ error: 'Account not found' });
  if (sender.status === 'frozen') return res.status(403).json({ error: 'Your account is frozen. Contact support.' });
  if (sender.account_number === to_account) return res.status(400).json({ error: 'Cannot transfer to your own account' });
  if (!sender.transaction_pin_hash) return res.status(400).json({ error: 'Please set a Transfer PIN before sending money.' });
  if (!bcrypt.compareSync(String(pin), sender.transaction_pin_hash)) return res.status(401).json({ error: 'Incorrect Transfer PIN.' });
  const recipient = db.users.findOne(u => u.account_number === to_account);
  if (!recipient) return res.status(404).json({ error: 'Recipient account not found. Please verify the account number.' });
  if (recipient.status === 'frozen') return res.status(400).json({ error: 'Recipient account is not available' });
  const activeAcct = sender.account_type || 'checking';
  const balField   = activeAcct === 'savings' ? 'savings_balance' : 'balance';
  const currentBal = parseFloat(sender[balField] || 0);
  if (currentBal < parsed) return res.status(400).json({ error: `Insufficient ${activeAcct} balance. Available: $${currentBal.toFixed(2)}` });
  db.users.update(sender.id, { [balField]: Math.round((currentBal - parsed) * 100) / 100 });
  const recipientBal = parseFloat(recipient.balance || 0);
  db.users.update(recipient.id, { balance: Math.round((recipientBal + parsed) * 100) / 100 });
  const txn = db.transactions.insert({ from_account: sender.account_number, to_account: recipient.account_number, amount: parsed, type: 'transfer', description: description || 'Transfer', from_account_type: activeAcct });
  const updated = db.users.findOne(u => u.id === sender.id);
  db.activity.insert({ user_id: sender.id, user_name: sender.name, user_email: sender.email, account_no: sender.account_number, action: 'transfer', details: `Sent $${parsed} to ${recipient.name}`, page: 'transfer' });
  res.json({ message: 'Transfer successful', transaction_id: txn.id, new_balance: updated[balField], new_checking_balance: updated.balance, new_savings_balance: updated.savings_balance || 0, recipient_name: recipient.name });
});

// GET /lookup
router.get('/lookup', authenticate, (req, res) => {
  const { acct } = req.query;
  if (!acct) return res.status(400).json({ error: 'Account number required' });
  const user = db.users.findOne(u => u.account_number === acct);
  if (!user || user.status === 'frozen' || user.id === req.user.id) return res.json({ found: false });
  res.json({ found: true, name: user.name, account_type: user.account_type || 'checking', routing_number: user.routing_number || '', swift_code: user.swift_code || 'NVRAUS33XXX' });
});

// POST /pin-change-otp
router.post('/pin-change-otp', authenticate, async (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const code = setOTP(user.email, 'pin_change');
    await sendOTP(user.email, code, 'login');
    res.json({ message: 'Verification code sent to your email' });
  } catch (e) { res.status(500).json({ error: 'Failed to send verification code.' }); }
});

// POST /switch-account
router.post('/switch-account', authenticate, (req, res) => {
  const { account_type } = req.body;
  if (!['checking', 'savings'].includes(account_type)) return res.status(400).json({ error: 'Invalid account type' });
  db.users.update(req.user.id, { account_type });
  const user = db.users.findOne(u => u.id === req.user.id);
  const { password_hash, transaction_pin_hash, ...safe } = user;
  safe.has_pin = !!user.transaction_pin_hash;
  res.json({ user: safe });
});

// POST /set-pin
router.post('/set-pin', authenticate, (req, res) => {
  const { pin, current_pin, otp_code } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  const user = db.users.findOne(u => u.id === req.user.id);
  if (user.transaction_pin_hash) {
    if (otp_code) {
      const result = checkOTP(user.email, otp_code, 'pin_change');
      if (!result.ok) return res.status(400).json({ error: result.error });
    } else if (current_pin) {
      if (!bcrypt.compareSync(String(current_pin), user.transaction_pin_hash)) return res.status(401).json({ error: 'Current PIN is incorrect' });
    } else {
      return res.status(400).json({ error: 'OTP verification is required to change your PIN' });
    }
  }
  db.users.update(req.user.id, { transaction_pin_hash: bcrypt.hashSync(pin, 10) });
  db.activity.insert({ user_id: req.user.id, user_name: user.name, user_email: user.email, account_no: user.account_number, action: 'set_pin', details: 'Changed/Set Transfer PIN', page: 'security' });
  res.json({ message: 'Transfer PIN set successfully' });
});

// POST /activity
router.post('/activity', authenticate, (req, res) => {
  const { action, details, page } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const user = db.users.findOne(u => u.id === req.user.id);
  db.activity.insert({ user_id: req.user.id, user_name: user ? user.name : 'Unknown', user_email: user ? user.email : 'Unknown', account_no: user ? user.account_number : '', action, details: details || '', page: page || '' });
  res.json({ ok: true });
});

module.exports = router;
