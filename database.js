// PostgreSQL database — persistent across Render restarts
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Generate a valid ABA routing number (9 digits, passes checksum)
function generateRoutingNumber() {
  const d = [Math.floor(Math.random() * 4)];
  for (let i = 1; i < 8; i++) d.push(Math.floor(Math.random() * 10));
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = d.reduce((acc, v, i) => acc + v * weights[i], 0);
  d.push((10 - (sum % 10)) % 10);
  return d.join('');
}

// Create tables + seed admin
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                  SERIAL PRIMARY KEY,
      name                TEXT,
      email               TEXT UNIQUE,
      phone               TEXT,
      street              TEXT,
      city                TEXT,
      state               TEXT,
      zip                 TEXT,
      password_hash       TEXT,
      account_number      TEXT UNIQUE,
      routing_number      TEXT UNIQUE,
      swift_code          TEXT,
      bank_type           TEXT,
      balance             NUMERIC DEFAULT 0,
      savings_balance     NUMERIC DEFAULT 0,
      account_type        TEXT    DEFAULT 'checking',
      role                TEXT    DEFAULT 'user',
      status              TEXT    DEFAULT 'active',
      transaction_pin_hash TEXT,
      avatar              TEXT,
      force_logout_at     BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                SERIAL PRIMARY KEY,
      from_account      TEXT,
      to_account        TEXT,
      amount            NUMERIC,
      type              TEXT,
      description       TEXT,
      status            TEXT DEFAULT 'success',
      from_account_type TEXT,
      dest_type         TEXT,
      recipient_name    TEXT,
      bank_name         TEXT,
      routing           TEXT,
      iban              TEXT,
      sort_code         TEXT,
      bic               TEXT,
      account_type      TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER,
      user_name   TEXT,
      user_email  TEXT,
      account_no  TEXT,
      action      TEXT,
      details     TEXT,
      page        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER,
      title       TEXT,
      message     TEXT,
      type        TEXT,
      read        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed default admin if none exists
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (rows.length === 0) {
    const password_hash = bcrypt.hashSync('admin123', 10);
    await pool.query(`
      INSERT INTO users (name, email, password_hash, account_number, routing_number,
                         swift_code, bank_type, balance, savings_balance, account_type,
                         role, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      'Admin', 'admin@bank.com', password_hash,
      'ADM' + Date.now(), generateRoutingNumber(),
      'NVRAUS33XXX', 'Online Banking', 0, 0, 'checking', 'admin', 'active'
    ]);
    console.log('Default admin created: admin@bank.com / admin123');
  }
}

// Exported ready promise — server.js awaits this before listening
const ready = initDb().catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Convert Postgres row (numeric strings) to the shape the routes expect
function row(r) {
  if (!r) return null;
  if (r.balance         != null) r.balance         = parseFloat(r.balance);
  if (r.savings_balance != null) r.savings_balance = parseFloat(r.savings_balance);
  if (r.amount          != null) r.amount          = parseFloat(r.amount);
  return r;
}

// ── db API ────────────────────────────────────────────────────────────────────
const db = {
  generateRoutingNumber,

  users: {
    async findAll() {
      const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
      return rows.map(row);
    },
    async findOne(pred) {
      const { rows } = await pool.query('SELECT * FROM users');
      return rows.map(row).find(pred) || null;
    },
    async insert(user) {
      const cols = Object.keys(user);
      const vals = Object.values(user);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      return row(rows[0]);
    },
    async update(id, changes) {
      const keys = Object.keys(changes);
      if (!keys.length) return db.users.findOne(u => u.id === id);
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE users SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
        [...Object.values(changes), id]
      );
      return row(rows[0]) || null;
    },
    async delete(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  },

  transactions: {
    async findAll() {
      const { rows } = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC');
      return rows.map(row);
    },
    async findWhere(pred) {
      const { rows } = await pool.query('SELECT * FROM transactions');
      return rows.map(row).filter(pred);
    },
    async insert(txn) {
      txn.status = txn.status || 'success';
      const cols = Object.keys(txn);
      const vals = Object.values(txn);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `INSERT INTO transactions (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      return row(rows[0]);
    },
    async update(id, changes) {
      const keys = Object.keys(changes);
      if (!keys.length) return null;
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE transactions SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
        [...Object.values(changes), id]
      );
      return row(rows[0]) || null;
    },
  },

  activity: {
    async findAll() {
      const { rows } = await pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 5000');
      return rows.map(row);
    },
    async findWhere(pred) {
      const { rows } = await pool.query('SELECT * FROM activity_log ORDER BY created_at DESC');
      return rows.map(row).filter(pred);
    },
    async insert(entry) {
      const cols = Object.keys(entry);
      const vals = Object.values(entry);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `INSERT INTO activity_log (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      // Trim to last 5000 entries
      pool.query(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY created_at DESC LIMIT 5000)`).catch(() => {});
      return rows[0];
    },
  },

  notifications: {
    async findAll() {
      const { rows } = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
      return rows.map(row);
    },
    async findWhere(pred) {
      const { rows } = await pool.query('SELECT * FROM notifications');
      return rows.map(row).filter(pred);
    },
    async insert(entry) {
      entry.read = entry.read || false;
      const cols = Object.keys(entry);
      const vals = Object.values(entry);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `INSERT INTO notifications (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      return rows[0];
    },
    async update(id, changes) {
      const keys = Object.keys(changes);
      if (!keys.length) return null;
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE notifications SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
        [...Object.values(changes), id]
      );
      return rows[0] || null;
    },
  },
};

module.exports = { ...db, ready };
