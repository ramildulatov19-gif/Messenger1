const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== ХРАНИЛИЩЕ ====================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('loadJSON error:', e); }
  return fallback;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadJSON(USERS_FILE, {});       // { name: { passwordHash, salt, createdAt } }
let messages = loadJSON(MSG_FILE, {});      // { chatId: [ {from,to,text,at} ] }

const sessions = new Map();                 // token -> name
const online = new Map();                   // name -> socket.id

// ==================== УТИЛИТЫ ====================
function hash(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}
function token() {
  return crypto.randomBytes(24).toString('hex');
}
function chatId(a, b) {
  return [a, b].sort().join('|');
}

// ==================== API ====================
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ error: 'Заполни имя и пароль' });

  const name = String(username).trim().toLowerCase();
  if (name.length < 3 || name.length > 16) return res.json({ error: 'Имя: 3–16 символов' });
  if (!/^[a-z0-9_]+$/.test(name)) return res.json({ error: 'Имя: только латиница, цифры и _' });
  if (String(password).length < 4) return res.json({ error: 'Пароль: минимум 4 символа' });
  if (users[name]) return res.json({ error: 'Такое имя уже занято' });

  const salt = crypto.randomBytes(8).toString('hex');
  users[name] = {
    name,
    salt,
    passwordHash: hash(password, salt),
    createdAt: Date.now()
  };
  saveJSON(USERS_FILE, users);

  const t = token();
  sessions.set(t, name);
  res.json({ token: t, name });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ error: 'Заполни имя и пароль' });

  const name = String(username).trim().toLowerCase();
  const u = users[name];
  if (!u) return res.json({ error: 'Неверное имя или пароль' });
  if (hash(password, u.salt) !== u.passwordHash) return res.json({ error: 'Неверное имя или пароль' });

  const t = token();
  sessions.set(t, name);
  res.json({ token: t, name });
});

app.get('/api/me', (req, res) => {
  const t = req.headers['x-token'];
  const name = sessions.get(t);
  if (!name) return res.status(401).json({ error: 'unauthorized' });
  res.json({ name });
});

app.get('/api/users', (req, res) => {
  const t = req.headers['x-token'];
  const me = sessions.get(t);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  const list = Object.values(users)
    .filter(u => u.name !== me)
    .map(u => ({ name: u.name, online: online.has(u.name) }));

  res.json({ users: list });
});

app.get('/api/messages/:with', (req, res) => {
  const t = req.headers['x-token'];
  const me = sessions.get(t);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  const other = String(req.params.with).toLowerCase();
  const id = chatId(me, other);
  res.json({ messages: messages[id] || [] });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  socket.on('auth', ({ token: t }) => {
    const name = sessions.get(t);
    if (!name) return socket.emit('authError');

    socket.username = name;
    online.set(name, socket.id);

    socket.emit('authed', { name });
    io.emit('presence', { users: Array.from(online.keys()) });
  });

  socket.on('send', ({ to, text }) => {
    const from = socket.username;
    if (!from || !to || !text) return;

    const clean = String(text).slice(0, 2000).trim();
    if (!clean) return;

    const msg = { from, to, text: clean, at: Date.now() };
    const id = chatId(from, to);

    if (!messages[id]) messages[id] = [];
    messages[id].push(msg);
    // Ограничим историю последними 2000 сообщениями
    if (messages[id].length > 2000) messages[id] = messages[id].slice(-2000);
    saveJSON(MSG_FILE, messages);

    // Отправим себе (для подтверждения) и получателю
    socket.emit('message', msg);
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('message', msg);
  });

  socket.on('typing', ({ to, typing }) => {
    const from = socket.username;
    if (!from || !to) return;
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('typing', { from, typing: !!typing });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      online.delete(socket.username);
      io.emit('presence', { users: Array.from(online.keys()) });
    }
  });
});

// ==================== СТАРТ ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n💬 Мессенджер запущен!`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});