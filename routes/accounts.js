const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

// ── GET /api/accounts/me ──────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, transaction_pin_hash, ...safe } = user;
  // Expose whether a PIN has been set (without revealing the hash)
  safe.has_pin = !!user.transaction_pin_hash;
  res.json(safe);
});

// ── GET /api/accounts/transactions ───────────────────────────────────────────
router.get('/transactions', authenticate, (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const allUsers = db.users.findAll();
  const txns = db.transactions
    .findWhere(t => t.from_account === user.account_number || t.to_account === user.account_number)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50)
    .map(t => ({
      ...t,
      sender_name:   allUsers.find(u => u.account_number === t.from_account)?.name || null,
      receiver_name: allUsers.find(u => u.account_number === t.to_account)?.name   || null,
    }));
  res.json(txns);
});

// ── POST /api/accounts/transfer ───────────────────────────────────────────────
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

  // Verify Transfer PIN
  if (!sender.transaction_pin_hash)
    return res.status(400).json({ error: 'Please set a Transfer PIN in your profile settings before sending money.' });
  if (!bcrypt.compareSync(String(pin), sender.transaction_pin_hash))
    return res.status(401).json({ error: 'Incorrect Transfer PIN. Please try again.' });

  const recipient = db.users.findOne(u => u.account_number === to_account);
  if (!recipient) return res.status(404).json({ error: 'Recipient account not found. Please verify the account number.' });
  if (recipient.status === 'frozen') return res.status(400).json({ error: 'Recipient account is not available' });

  // Determine which balance to deduct from (sender's active account)
  const activeAcct = sender.account_type || 'checking';
  const balField   = activeAcct === 'savings' ? 'savings_balance' : 'balance';
  const currentBal = parseFloat(sender[balField] || 0);

  if (currentBal < parsed)
    return res.status(400).json({
      error: `Insufficient ${activeAcct} balance. Available: $${currentBal.toFixed(2)}`
    });

  // Deduct from sender's active account
  db.users.update(sender.id, { [balField]: Math.round((currentBal - parsed) * 100) / 100 });

  // Credit to recipient's checking account (standard)
  const recipientBal = parseFloat(recipient.balance || 0);
  db.users.update(recipient.id, { balance: Math.round((recipientBal + parsed) * 100) / 100 });

  const txn = db.transactions.insert({
    from_account: sender.account_number,
    to_account:   recipient.account_number,
    amount: parsed, type: 'transfer',
    description: description || 'Transfer',
    from_account_type: activeAcct
  });

  const updated = db.users.findOne(u => u.id === sender.id);
  db.activity.insert({
    user_id: sender.id, user_name: sender.name, user_email: sender.email,
    account_no: sender.account_number, action: 'transfer',
    details: `Sent $${parsed} from ${activeAcct} to ${recipient.name} (${recipient.account_number})${description ? ' — ' + description : ''}`,
    page: 'transfer'
  });

  res.json({
    message: 'Transfer successful',
    transaction_id: txn.id,
    new_balance: updated[balField],
    new_checking_balance: updated.balance,
    new_savings_balance: updated.savings_balance || 0,
    recipient_name: recipient.name
  });
});

// ── POST /api/accounts/switch-account ────────────────────────────────────────
// Switch the user's active account (checking ↔ savings)
router.post('/switch-account', authenticate, (req, res) => {
  const { account_type } = req.body;
  if (!['checking', 'savings'].includes(account_type))
    return res.status(400).json({ error: 'Invalid account type' });
  db.users.update(req.user.id, { account_type });
  const user = db.users.findOne(u => u.id === req.user.id);
  const { password_hash, transaction_pin_hash, ...safe } = user;
  safe.has_pin = !!user.transaction_pin_hash;
  res.json({ user: safe });
});

// ── POST /api/accounts/set-pin ────────────────────────────────────────────────
// Set or change the 4-digit Transfer PIN
router.post('/set-pin', authenticate, (req, res) => {
  const { pin, current_pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const user = db.users.findOne(u => u.id === req.user.id);

  // If PIN already set, require current PIN to change it
  if (user.transaction_pin_hash) {
    if (!current_pin)
      return res.status(400).json({ error: 'Current PIN is required to change your PIN' });
    if (!bcrypt.compareSync(String(current_pin), user.transaction_pin_hash))
      return res.status(401).json({ error: 'Current PIN is incorrect' });
  }

  db.users.update(req.user.id, { transaction_pin_hash: bcrypt.hashSync(pin, 10) });
  db.activity.insert({
    user_id: req.user.id, user_name: user.name, user_email: user.email,
    account_no: user.account_number, action: 'set_pin',
    details: user.transaction_pin_hash ? 'Changed Transfer PIN' : 'Set Transfer PIN for the first time',
    page: 'profile'
  });
  res.json({ message: 'Transfer PIN set successfully' });
});

// ── POST /api/accounts/activity ───────────────────────────────────────────────
// Log user activity from the frontend
router.post('/activity', authenticate, (req, res) => {
  const { action, details, page } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const user = db.users.findOne(u => u.id === req.user.id);
  db.activity.insert({
    user_id:    req.user.id,
    user_name:  user ? user.name  : 'Unknown',
    user_email: user ? user.email : 'Unknown',
    account_no: user ? user.account_number : '',
    action, details: details || '', page: page || '',
  });
  res.json({ ok: true });
});

module.exports = router;
