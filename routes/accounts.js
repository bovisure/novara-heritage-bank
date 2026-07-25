const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

router.get('/me', authenticate, (req, res) => {
  const user = db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...safe } = user;
  res.json(safe);
});

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

router.post('/transfer', authenticate, (req, res) => {
  const { to_account, amount, description } = req.body;
  if (!to_account || !amount) return res.status(400).json({ error: 'Recipient account and amount are required' });

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const sender = db.users.findOne(u => u.id === req.user.id);
  if (!sender) return res.status(404).json({ error: 'Sender not found' });
  if (sender.status === 'frozen') return res.status(403).json({ error: 'Your account is frozen. Contact support.' });
  if (sender.account_number === to_account) return res.status(400).json({ error: 'Cannot transfer to your own account' });

  const recipient = db.users.findOne(u => u.account_number === to_account);
  if (!recipient) return res.status(404).json({ error: 'Recipient account not found' });
  if (recipient.status === 'frozen') return res.status(400).json({ error: 'Recipient account is frozen' });
  if (sender.balance < parsed) return res.status(400).json({ error: 'Insufficient balance' });

  db.users.update(sender.id,    { balance: Math.round((sender.balance - parsed) * 100) / 100 });
  db.users.update(recipient.id, { balance: Math.round((recipient.balance + parsed) * 100) / 100 });
  const txn = db.transactions.insert({
    from_account: sender.account_number,
    to_account:   recipient.account_number,
    amount: parsed, type: 'transfer',
    description: description || 'Transfer'
  });

  const updated = db.users.findOne(u => u.id === sender.id);
  db.activity.insert({ user_id: sender.id, user_name: sender.name, user_email: sender.email, account_no: sender.account_number, action: 'transfer', details: `Sent $${parsed} to ${recipient.name} (${recipient.account_number})${description ? ' — ' + description : ''}`, page: 'transfer' });
  res.json({ message: 'Transfer successful', transaction_id: txn.id, new_balance: updated.balance, recipient_name: recipient.name });
});

// POST /api/accounts/activity — log user activity (called from frontend)
router.post('/activity', authenticate, (req, res) => {
  const { action, details, page } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const user = db.users.findOne(u => u.id === req.user.id);
  db.activity.insert({
    user_id:    req.user.id,
    user_name:  user ? user.name  : 'Unknown',
    user_email: user ? user.email : 'Unknown',
    account_no: user ? user.account_number : '',
    action,
    details: details || '',
    page:    page    || '',
  });
  res.json({ ok: true });
});

module.exports = router;
