const express = require('express');
const cors = require('cors');
const path = require('path');

// DB initializes synchronously on require (tables + admin seed)
require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/admin',    require('./routes/admin'));

app.get('/',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((_, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });

app.listen(PORT, () => {
  console.log(`\n🏦  Banking App  →  http://localhost:${PORT}`);
  console.log(`📊  Admin Panel  →  http://localhost:${PORT}/admin`);
  console.log(`\n🔑  Admin login: admin@bank.com / admin123\n`);
});
