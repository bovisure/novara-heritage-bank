// Pure JavaScript JSON database — no native compilation needed
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'banking.db.json');

function load() {
  if (!fs.existsSync(DB_PATH)) return { users: [], transactions: [], activity_log: [] };
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data.activity_log) data.activity_log = [];
    return data;
  }
  catch { return { users: [], transactions: [], activity_log: [] }; }
}

function save(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Auto-incrementing ID
let _nextId = null;
function nextId() {
  if (_nextId === null) {
    const data = load();
    const ids = [...data.users, ...data.transactions].map(x => x.id).filter(Number.isInteger);
    _nextId = ids.length ? Math.max(...ids) + 1 : 2;
  }
  return _nextId++;
}

// Generate a valid ABA routing number (9 digits, passes checksum)
function generateRoutingNumber() {
  // First digit 0-3 for US Federal Reserve routing districts
  const d = [Math.floor(Math.random() * 4)];
  for (let i = 1; i < 8; i++) d.push(Math.floor(Math.random() * 10));
  // ABA checksum: 3*d0 + 7*d1 + d2 + 3*d3 + 7*d4 + d5 + 3*d6 + 7*d7 + d8 ≡ 0 (mod 10)
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = d.reduce((acc, v, i) => acc + v * weights[i], 0);
  d.push((10 - (sum % 10)) % 10);
  return d.join('');
}

// Ensure routing numbers are unique across all users
function uniqueRoutingNumber(existingNums) {
  let num;
  do { num = generateRoutingNumber(); } while (existingNums.has(num));
  existingNums.add(num);
  return num;
}

// Seed default admin on first run
(function seedAdmin() {
  const data = load();
  if (!data.users.find(u => u.role === 'admin')) {
    data.users.push({
      id: 1,
      name: 'Admin',
      email: 'admin@bank.com',
      password_hash: bcrypt.hashSync('admin123', 10),
      account_number: 'ADM' + Date.now(),
      routing_number: generateRoutingNumber(),
      swift_code: 'NVRAUS33XXX',
      bank_type: 'Online Banking',
      balance: 0,
      savings_balance: 0,
      account_type: 'checking',
      role: 'admin',
      status: 'active',
      created_at: new Date().toISOString()
    });
    save(data);
    console.log('Default admin created: admin@bank.com / admin123');
  }
})();

// Migration: add new fields to existing users who predate this update
(function migrateUsers() {
  const data = load();
  const existingRouting = new Set(data.users.map(u => u.routing_number).filter(Boolean));
  let changed = false;
  data.users = data.users.map(user => {
    if (!user.routing_number) { user.routing_number = uniqueRoutingNumber(existingRouting); changed = true; }
    if (!user.swift_code)     { user.swift_code = 'NVRAUS33XXX'; changed = true; }
    if (!user.bank_type)      { user.bank_type = 'Online Banking'; changed = true; }
    if (user.savings_balance === undefined) { user.savings_balance = 0; changed = true; }
    if (!user.account_type)   { user.account_type = 'checking'; changed = true; }
    // transaction_pin_hash may be null for existing users — that's fine, transfer will prompt them
    return user;
  });
  if (changed) { save(data); console.log('DB migration: added banking fields to existing users'); }
})();

const db = {
  users: {
    findAll()       { return load().users; },
    findOne(pred)   { return load().users.find(pred) || null; },
    insert(user)    {
      const data = load();
      user.id = nextId();
      user.created_at = new Date().toISOString();
      data.users.push(user);
      save(data);
      return user;
    },
    update(id, changes) {
      const data = load();
      const i = data.users.findIndex(u => u.id === id);
      if (i === -1) return null;
      Object.assign(data.users[i], changes);
      save(data);
      return data.users[i];
    }
  },
  transactions: {
    findAll()        { return load().transactions; },
    findWhere(pred)  { return load().transactions.filter(pred); },
    insert(txn)      {
      const data = load();
      txn.id = nextId();
      txn.status = 'success';
      txn.created_at = new Date().toISOString();
      data.transactions.push(txn);
      save(data);
      return txn;
    },
    update(id, changes) {
      const data = load();
      const i = data.transactions.findIndex(t => t.id === id);
      if (i === -1) return null;
      Object.assign(data.transactions[i], changes);
      save(data);
      return data.transactions[i];
    }
  },
  activity: {
    findAll()       { return load().activity_log; },
    findWhere(pred) { return load().activity_log.filter(pred); },
    insert(entry)   {
      const data = load();
      entry.id = nextId();
      entry.created_at = new Date().toISOString();
      data.activity_log.push(entry);
      // Keep only last 5000 entries
      if (data.activity_log.length > 5000) data.activity_log = data.activity_log.slice(-5000);
      save(data);
      return entry;
    }
  },
  generateRoutingNumber
};

module.exports = db;
