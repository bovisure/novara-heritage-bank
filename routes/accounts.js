const express = require('express');
const bcrypt = require('bcryptjs');
const https = require('https');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { setOTP, checkOTP } = require('../utils/otp');
const { sendOTP, sendTransactionEmail } = require('../utils/email');
const router = express.Router();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NovaBankApp/1.0', 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

// ── GET /api/accounts/me ──────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const user = await db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, transaction_pin_hash, ...safe } = user;
  safe.has_pin = !!user.transaction_pin_hash;
  res.json(safe);
});

// ── GET /api/accounts/transactions ───────────────────────────────────────────
router.get('/transactions', authenticate, async (req, res) => {
  const user = await db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const allUsers = await db.users.findAll();
  const txns = (await db.transactions.findWhere(t => t.from_account === user.account_number || t.to_account === user.account_number))
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
router.post('/transfer', authenticate, async (req, res) => {
  const { to_account, amount, description, pin } = req.body;

  if (!to_account || !amount) return res.status(400).json({ error: 'Recipient account and amount are required' });
  if (!pin) return res.status(400).json({ error: 'Transfer PIN is required' });

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const sender = await db.users.findOne(u => u.id === req.user.id);
  if (!sender) return res.status(404).json({ error: 'Account not found' });
  if (sender.status === 'frozen') return res.status(403).json({ error: 'Your account is frozen. Contact support.' });
  if (sender.account_number === to_account) return res.status(400).json({ error: 'Cannot transfer to your own account' });

  if (!sender.transaction_pin_hash)
    return res.status(400).json({ error: 'Please set a Transfer PIN in your profile settings before sending money.' });
  if (!bcrypt.compareSync(String(pin), sender.transaction_pin_hash))
    return res.status(401).json({ error: 'Incorrect Transfer PIN. Please try again.' });

  const recipient = await db.users.findOne(u => u.account_number === to_account);
  if (!recipient) return res.status(404).json({ error: 'Recipient account not found. Please verify the account number.' });
  if (recipient.status === 'frozen') return res.status(400).json({ error: 'Recipient account is not available' });

  const activeAcct = sender.account_type || 'checking';
  const balField   = activeAcct === 'savings' ? 'savings_balance' : 'balance';
  const currentBal = parseFloat(sender[balField] || 0);

  if (currentBal < parsed)
    return res.status(400).json({ error: `Insufficient ${activeAcct} balance. Available: $${currentBal.toFixed(2)}` });

  await db.users.update(sender.id, { [balField]: Math.round((currentBal - parsed) * 100) / 100 });

  const recipientBal = parseFloat(recipient.balance || 0);
  await db.users.update(recipient.id, { balance: Math.round((recipientBal + parsed) * 100) / 100 });

  const txn = await db.transactions.insert({
    from_account: sender.account_number,
    to_account:   recipient.account_number,
    amount: parsed, type: 'transfer',
    description: description || 'Transfer',
    from_account_type: activeAcct
  });

  const updated = await db.users.findOne(u => u.id === sender.id);
  await db.activity.insert({
    user_id: sender.id, user_name: sender.name, user_email: sender.email,
    account_no: sender.account_number, action: 'transfer',
    details: `Sent $${parsed} from ${activeAcct} to ${recipient.name} (${recipient.account_number})${description ? ' — ' + description : ''}`,
    page: 'transfer'
  });

  await db.notifications.insert({
    user_id: sender.id, title: '📤 Transfer Sent',
    message: `$${parsed.toFixed(2)} sent to ${recipient.name}. New balance: $${updated[balField].toFixed(2)}`,
    type: 'info'
  });
  await db.notifications.insert({
    user_id: recipient.id, title: '📥 Money Received',
    message: `$${parsed.toFixed(2)} received from ${sender.name}${description ? ' — ' + description : ''}`,
    type: 'success'
  });

  const recipientUpdated = await db.users.findOne(u => u.id === recipient.id);
  sendTransactionEmail(sender.email, 'debit', {
    amount: parsed, counterparty: recipient.name, description,
    new_balance: updated[balField]
  }).catch(e => console.error('Sender txn email error:', e.message));
  sendTransactionEmail(recipient.email, 'credit', {
    amount: parsed, counterparty: sender.name, description,
    new_balance: recipientUpdated.balance
  }).catch(e => console.error('Recipient txn email error:', e.message));

  res.json({
    message: 'Transfer successful',
    transaction_id: txn.id,
    new_balance: updated[balField],
    new_checking_balance: updated.balance,
    new_savings_balance: updated.savings_balance || 0,
    recipient_name: recipient.name
  });
});

// ── GET /api/accounts/lookup ──────────────────────────────────────────────────
router.get('/lookup', authenticate, async (req, res) => {
  const { acct } = req.query;
  if (!acct) return res.status(400).json({ error: 'Account number required' });
  const user = await db.users.findOne(u => u.account_number === acct);
  if (!user || user.status === 'frozen' || user.id === req.user.id)
    return res.json({ found: false });
  res.json({
    found: true,
    name: user.name,
    account_type: user.account_type || 'checking',
    routing_number: user.routing_number || '',
    swift_code: user.swift_code || 'NVRAUS33XXX'
  });
});

// ── POST /api/accounts/pin-change-otp ─────────────────────────────────────────
router.post('/pin-change-otp', authenticate, async (req, res) => {
  const user = await db.users.findOne(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const code = setOTP(user.email, 'pin_change');
    await sendOTP(user.email, code, 'login');
    res.json({ message: 'Verification code sent to your email' });
  } catch (e) {
    console.error('PIN change OTP error:', e.message);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

// ── POST /api/accounts/switch-account ────────────────────────────────────────
router.post('/switch-account', authenticate, async (req, res) => {
  const { account_type } = req.body;
  if (!['checking', 'savings'].includes(account_type))
    return res.status(400).json({ error: 'Invalid account type' });
  await db.users.update(req.user.id, { account_type });
  const user = await db.users.findOne(u => u.id === req.user.id);
  const { password_hash, transaction_pin_hash, ...safe } = user;
  safe.has_pin = !!user.transaction_pin_hash;
  res.json({ user: safe });
});

// ── POST /api/accounts/set-pin ────────────────────────────────────────────────
router.post('/set-pin', authenticate, async (req, res) => {
  const { pin, current_pin, otp_code } = req.body;
  if (!pin || !/^\d{4}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const user = await db.users.findOne(u => u.id === req.user.id);

  if (user.transaction_pin_hash) {
    if (otp_code) {
      const result = checkOTP(user.email, otp_code, 'pin_change');
      if (!result.ok) return res.status(400).json({ error: result.error });
    } else if (current_pin) {
      if (!bcrypt.compareSync(String(current_pin), user.transaction_pin_hash))
        return res.status(401).json({ error: 'Current PIN is incorrect' });
    } else {
      return res.status(400).json({ error: 'OTP verification is required to change your PIN' });
    }
  }

  await db.users.update(req.user.id, { transaction_pin_hash: bcrypt.hashSync(pin, 10) });
  await db.activity.insert({
    user_id: req.user.id, user_name: user.name, user_email: user.email,
    account_no: user.account_number, action: 'set_pin',
    details: user.transaction_pin_hash ? 'Changed Transfer PIN' : 'Set Transfer PIN for the first time',
    page: 'profile'
  });
  res.json({ message: 'Transfer PIN set successfully' });
});

// ── POST /api/accounts/avatar ─────────────────────────────────────────────────
router.post('/avatar', authenticate, express.json({ limit: '5mb' }), async (req, res) => {
  const { avatar } = req.body;
  if (!avatar || !avatar.startsWith('data:image/'))
    return res.status(400).json({ error: 'Invalid image format' });
  await db.users.update(req.user.id, { avatar });
  res.json({ message: 'Avatar updated' });
});

// ── GET /api/accounts/bank-lookup ─────────────────────────────────────────────
router.get('/bank-lookup', authenticate, async (req, res) => {
  const { routing, iban } = req.query;
  try {
    if (routing) {
      if (!/^\d{9}$/.test(routing)) return res.status(400).json({ error: 'Routing number must be exactly 9 digits' });
      const data = await httpsGet(`https://www.routingnumbers.info/api/data.json?rn=${routing}`);
      if (data.code === 200) {
        return res.json({
          found: true, type: 'us',
          bank_name: data.customer_name || data.telegraphic_name || 'Unknown Bank',
          city: data.city || '', state: data.state || '',
          zip: data.zipcode || '', phone: data.phone || '',
          swift: ''
        });
      }
      return res.json({ found: false });
    }
    if (iban) {
      const clean = iban.replace(/\s+/g, '').toUpperCase();
      if (clean.length < 15) return res.status(400).json({ error: 'Invalid IBAN' });
      const data = await httpsGet(`https://openiban.com/validate/${clean}?getBIC=true&validateBankCode=true`);
      if (data.valid) {
        return res.json({
          found: true, type: 'eu',
          bank_name: data.bankData?.name || '',
          bic: data.bankData?.bic || '',
          country: clean.slice(0, 2)
        });
      }
      return res.json({ found: false, error: data.messages?.[0] || 'Invalid IBAN' });
    }
    res.status(400).json({ error: 'Provide routing or iban parameter' });
  } catch(e) {
    console.error('Bank lookup error:', e.message);
    res.status(500).json({ error: 'Lookup service unavailable' });
  }
});

// ── POST /api/accounts/external-transfer ─────────────────────────────────────
router.post('/external-transfer', authenticate, async (req, res) => {
  const { amount, pin, description, dest_type, recipient_name, bank_name,
          routing, account_number, iban, sort_code, bic, account_type } = req.body;

  if (!amount || !pin) return res.status(400).json({ error: 'Amount and PIN are required' });
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const sender = await db.users.findOne(u => u.id === req.user.id);
  if (!sender) return res.status(404).json({ error: 'Account not found' });
  if (sender.status === 'frozen') return res.status(403).json({ error: 'Your account is frozen. Contact support.' });
  if (!sender.transaction_pin_hash)
    return res.status(400).json({ error: 'Please set a Transfer PIN in your profile before sending money.' });
  if (!bcrypt.compareSync(String(pin), sender.transaction_pin_hash))
    return res.status(401).json({ error: 'Incorrect Transfer PIN. Please try again.' });

  const activeAcct = sender.account_type || 'checking';
  const balField   = activeAcct === 'savings' ? 'savings_balance' : 'balance';
  const currentBal = parseFloat(sender[balField] || 0);
  if (currentBal < parsed)
    return res.status(400).json({ error: `Insufficient ${activeAcct} balance. Available: $${currentBal.toFixed(2)}` });

  await db.users.update(sender.id, { [balField]: Math.round((currentBal - parsed) * 100) / 100 });

  const txn = await db.transactions.insert({
    from_account: sender.account_number,
    to_account:   account_number || iban || sort_code || 'EXTERNAL',
    amount: parsed, type: 'external_transfer',
    description: description || `Transfer to ${recipient_name || 'external account'}`,
    dest_type, recipient_name, bank_name, routing, iban, sort_code, bic, account_type,
    from_account_type: activeAcct
  });

  const updated = await db.users.findOne(u => u.id === sender.id);

  await db.activity.insert({
    user_id: sender.id, user_name: sender.name, user_email: sender.email,
    account_no: sender.account_number, action: 'external_transfer',
    details: `Sent ${parsed} to ${recipient_name || 'external'} via ${(dest_type||'').toUpperCase()} (${bank_name || ''})`,
    page: 'transfer'
  });

  await db.notifications.insert({
    user_id: sender.id, title: '📤 External Transfer Sent',
    message: `$${parsed.toFixed(2)} sent to ${recipient_name || 'external account'} via ${(dest_type||'').toUpperCase()}`,
    type: 'info'
  });
  sendTransactionEmail(sender.email, 'debit', {
    amount: parsed, counterparty: recipient_name || 'External Account',
    description: description || `${(dest_type||'').toUpperCase()} transfer to ${bank_name || 'external bank'}`,
    new_balance: updated[balField]
  }).catch(e => console.error('External txn email error:', e.message));

  res.json({
    message: 'Transfer initiated successfully',
    transaction_id: txn.id,
    new_balance: updated.balance,
    new_checking_balance: updated.balance,
    new_savings_balance: updated.savings_balance || 0
  });
});

// ── GET /api/accounts/notifications ──────────────────────────
router.get('/notifications', authenticate, async (req, res) => {
  const notifs = (await db.notifications.findWhere(n => n.user_id === req.user.id))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  res.json(notifs);
});

// ── PATCH /api/accounts/notifications/read-all ───────────────
router.patch('/notifications/read-all', authenticate, async (req, res) => {
  const notifs = await db.notifications.findWhere(n => n.user_id === req.user.id && !n.read);
  await Promise.all(notifs.map(n => db.notifications.update(n.id, { read: true })));
  res.json({ ok: true, count: notifs.length });
});

// ── POST /api/accounts/activity ───────────────────────────────────────────────
router.post('/activity', authenticate, async (req, res) => {
  const { action, details, page } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const user = await db.users.findOne(u => u.id === req.user.id);
  await db.activity.insert({
    user_id:    req.user.id,
    user_name:  user ? user.name  : 'Unknown',
    user_email: user ? user.email : 'Unknown',
    account_no: user ? user.account_number : '',
    action, details: details || '', page: page || '',
  });
  res.json({ ok: true });
});

module.exports = router;
