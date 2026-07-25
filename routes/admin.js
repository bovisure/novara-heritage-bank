const express = require('express');
const db = require('../database');
const { authenticate, adminOnly } = require('../middleware/auth');
const router = express.Router();

router.use(authenticate, adminOnly);

function logAdminAction(req, action, details) {
  try {
    db.activity.insert({
      user_id:    req.user.id,
      user_name:  'Admin',
      user_email: req.user.email,
      account_no: 'ADMIN',
      action,
      details,
      page: 'admin',
    });
  } catch(e) { /* non-fatal */ }
}

function uid(id) { return parseInt(id); }

router.get('/users', (req, res) => {
  const users = db.users.findAll()
    .map(({ password_hash, ...u }) => u)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(users);
});

router.patch('/users/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'frozen'].includes(status)) return res.status(400).json({ error: 'Status must be active or frozen' });
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Cannot freeze admin account' });
  db.users.update(user.id, { status });
  logAdminAction(req, status === 'frozen' ? 'freeze_account' : 'unfreeze_account', `${status === 'frozen' ? 'Froze' : 'Unfroze'} account of ${user.name} (${user.email})`);
  res.json({ message: `Account ${status === 'frozen' ? 'frozen' : 'unfrozen'} successfully` });
});

router.post('/users/:id/credit', (req, res) => {
  const parsed = parseFloat(req.body.amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = db.users.update(user.id, { balance: Math.round((user.balance + parsed) * 100) / 100 });
  db.transactions.insert({ from_account: 'BANK', to_account: user.account_number, amount: parsed, type: 'credit', description: req.body.description || 'Admin credit' });
  logAdminAction(req, 'admin_credit', `Credited $${parsed} to ${user.name} (${user.email}). New balance: $${updated.balance}`);
  res.json({ message: 'Credit applied', new_balance: updated.balance });
});

router.post('/users/:id/debit', (req, res) => {
  const parsed = parseFloat(req.body.amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < parsed) return res.status(400).json({ error: 'Insufficient user balance' });
  const updated = db.users.update(user.id, { balance: Math.round((user.balance - parsed) * 100) / 100 });
  db.transactions.insert({ from_account: user.account_number, to_account: 'BANK', amount: parsed, type: 'debit', description: req.body.description || 'Admin debit' });
  logAdminAction(req, 'admin_debit', `Debited $${parsed} from ${user.name} (${user.email}). New balance: $${updated.balance}`);
  res.json({ message: 'Debit applied', new_balance: updated.balance });
});

router.get('/transactions', (req, res) => {
  const allUsers = db.users.findAll();
  const txns = db.transactions.findAll()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 200)
    .map(t => ({
      ...t,
      sender_name:   allUsers.find(u => u.account_number === t.from_account)?.name || null,
      receiver_name: allUsers.find(u => u.account_number === t.to_account)?.name   || null,
    }));
  res.json(txns);
});

// PATCH /api/admin/transactions/:id/date — backdate a transaction
router.patch('/transactions/:id/date', (req, res) => {
  const { created_at } = req.body;
  if (!created_at) return res.status(400).json({ error: 'Date is required' });
  const txnId = uid(req.params.id);
  const txn = db.transactions.findAll().find(t => t.id === txnId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const d = new Date(created_at);
  if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date format' });
  db.transactions.update(txnId, { created_at: d.toISOString() });
  logAdminAction(req, 'backdate_transaction', `Changed date of transaction #${txnId} to ${d.toISOString()}`);
  res.json({ message: 'Transaction date updated successfully' });
});

// GET /api/admin/activity — full activity log
router.get('/activity', (req, res) => {
  const logs = db.activity.findAll()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 500);
  res.json(logs);
});

// PATCH /api/admin/users/:id/regdate — change registration date
router.patch('/users/:id/regdate', (req, res) => {
  const { created_at } = req.body;
  if (!created_at) return res.status(400).json({ error: 'Date is required' });
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Cannot modify admin account' });
  // Accept date string and store as ISO
  const d = new Date(created_at);
  if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date format' });
  db.users.update(user.id, { created_at: d.toISOString() });
  logAdminAction(req, 'change_reg_date', `Changed registration date of ${user.name} (${user.email}) to ${d.toISOString()}`);
  res.json({ message: 'Registration date updated successfully' });
});

router.get('/stats', (req, res) => {
  const users = db.users.findAll().filter(u => u.role === 'user');
  const txns  = db.transactions.findAll();
  res.json({
    total_users:        users.length,
    active_users:       users.filter(u => u.status === 'active').length,
    frozen_users:       users.filter(u => u.status === 'frozen').length,
    total_transactions: txns.length,
    total_volume:       txns.filter(t => t.type === 'transfer').reduce((s, t) => s + t.amount, 0),
    total_balance:      users.reduce((s, u) => s + u.balance, 0),
  });
});

module.exports = router;
