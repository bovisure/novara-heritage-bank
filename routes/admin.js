const express = require('express');
const db = require('../database');
const { authenticate, adminOnly } = require('../middleware/auth');
const { sendAccountEmail } = require('../utils/email');
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

router.patch('/users/:id/status', async (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'frozen'].includes(status)) return res.status(400).json({ error: 'Status must be active or frozen' });
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Cannot freeze admin account' });
  db.users.update(user.id, { status });

  const isFrozen = status === 'frozen';
  // Create in-app notification
  db.notifications.insert({
    user_id: user.id,
    title: isFrozen ? '🔒 Account Suspended' : '🔓 Account Reactivated',
    message: isFrozen
      ? `Your account has been suspended${reason ? ': ' + reason : '. Contact support for details.'}`
      : 'Your account has been reactivated. You can now log in normally.',
    type: isFrozen ? 'danger' : 'success'
  });

  // Send email notification (non-blocking)
  sendAccountEmail(user.email, isFrozen ? 'frozen' : 'unfrozen', { name: user.name, reason }).catch(e =>
    console.error('Freeze email error:', e.message)
  );

  logAdminAction(req, isFrozen ? 'freeze_account' : 'unfreeze_account',
    `${isFrozen ? 'Froze' : 'Unfroze'} account of ${user.name} (${user.email})${reason ? ' — ' + reason : ''}`);
  res.json({ message: `Account ${isFrozen ? 'frozen' : 'unfrozen'} successfully` });
});

// ── GET /api/admin/pending-users ──────────────────────────────
router.get('/pending-users', (req, res) => {
  const pending = db.users.findAll()
    .filter(u => u.status === 'pending_admin')
    .map(({ password_hash, transaction_pin_hash, ...u }) => u)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json(pending);
});

// ── POST /api/admin/users/:id/approve ────────────────────────
router.post('/users/:id/approve', async (req, res) => {
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status !== 'pending_admin') return res.status(400).json({ error: 'Account is not pending approval' });
  db.users.update(user.id, { status: 'active' });

  // In-app notification
  db.notifications.insert({
    user_id: user.id,
    title: '🎉 Account Approved!',
    message: `Welcome, ${user.name}! Your Novara Heritage Bank account has been verified and is ready to use.`,
    type: 'success'
  });

  // Approval email (non-blocking)
  sendAccountEmail(user.email, 'approved', {
    name: user.name,
    account_number: user.account_number,
    routing_number: user.routing_number
  }).catch(e => console.error('Approval email error:', e.message));

  logAdminAction(req, 'approve_account', `Approved account for ${user.name} (${user.email})`);
  res.json({ message: 'Account approved successfully' });
});

// ── POST /api/admin/users/:id/reject ─────────────────────────
router.post('/users/:id/reject', async (req, res) => {
  const { reason } = req.body;
  const user = db.users.findOne(u => u.id === uid(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status !== 'pending_admin') return res.status(400).json({ error: 'Account is not pending approval' });

  // Send rejection email before deleting
  sendAccountEmail(user.email, 'rejected', { name: user.name, reason })
    .catch(e => console.error('Rejection email error:', e.message));

  logAdminAction(req, 'reject_account', `Rejected account for ${user.name} (${user.email})${reason ? ' — ' + reason : ''}`);

  // Remove user record
  const data = require('../database').users.findAll();
  // Direct DB manipulation to delete
  const dbData = require('fs').existsSync(process.env.DB_PATH || require('path').join(__dirname, '../banking.db.json'))
    ? JSON.parse(require('fs').readFileSync(process.env.DB_PATH || require('path').join(__dirname, '../banking.db.json'), 'utf8'))
    : { users: [] };
  dbData.users = dbData.users.filter(u => u.id !== user.id);
  require('fs').writeFileSync(process.env.DB_PATH || require('path').join(__dirname, '../banking.db.json'), JSON.stringify(dbData, null, 2));

  res.json({ message: 'Account rejected and removed' });
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
    pending_users:      users.filter(u => u.status === 'pending_admin').length,
    total_transactions: txns.length,
    total_volume:       txns.filter(t => t.type === 'transfer').reduce((s, t) => s + t.amount, 0),
    total_balance:      users.reduce((s, u) => s + u.balance, 0),
  });
});

module.exports = router;
