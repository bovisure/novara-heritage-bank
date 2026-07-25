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
      balance: 0,
      role: 'admin',
      status: 'active',
      created_at: new Date().toISOString()
    });
    save(data);
    console.log('Default admin created: admin@bank.com / admin123');
  }
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
      // Keep only last 5000 entries to prevent unbounded growth
      if (data.activity_log.length > 5000) data.activity_log = data.activity_log.slice(-5000);
      save(data);
      return entry;
    }
  }
};

module.exports = db;
