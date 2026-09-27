const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==================== ПУТИ И ПАПКИ ====================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const VAPID_PUBLIC = 'BPZSpsG_Tiz1yYuWS2ETGr2nMophRxn7QIt7MFLDmueaoWxIVhoM8kynUpRUAwxwcF6wJ3A3SqWml9Au5YDv9gQ';
const VAPID_PRIVATE = 'lgqMVUwKdQdxmy5Oa2Hhr7wX3f_ycgj3vWTNoXSmUP8';
const VAPID_EMAIL = 'mailto:ramildulatov19@gmail.com';  

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');        

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });   

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(AVATARS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ==================== ХРАНИЛИЩЕ ====================
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('loadJSON error:', e); }
  return fallback;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadJSON(USERS_FILE, {});
let messages = loadJSON(MSG_FILE, {});
let groups = loadJSON(GROUPS_FILE, {});
let pushSubs = loadJSON(PUSH_SUBS_FILE, {});  // { name: [subscription, ...] }

const sessions = new Map();
const online = new Map();

// ==================== MULTER ====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => {
      const name = req.username || 'unknown';
      const ext = (file.mimetype === 'image/png') ? '.png' :
                  (file.mimetype === 'image/jpeg') ? '.jpg' : '.bin';
      cb(null, name + ext);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg' || file.mimetype === 'image/webp') {
      cb(null, true);
    } else {
      cb(new Error('Только PNG, JPG или WebP'));
    }
  }
});

// Multer для медиа-файлов (фото + голосовые)
const uploadMedia = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const id = crypto.randomBytes(12).toString('hex');
      let ext = '.bin';
      if (file.mimetype.startsWith('image/')) {
        ext = file.mimetype === 'image/png' ? '.png' :
              file.mimetype === 'image/webp' ? '.webp' : '.jpg';
      } else if (file.mimetype.startsWith('audio/')) {
        ext = file.mimetype.includes('mp4') ? '.m4a' :
              file.mimetype.includes('ogg') ? '.ogg' :
              file.mimetype.includes('wav') ? '.wav' : '.webm';
      }
      cb(null, id + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 МБ
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Только изображения и аудио'));
    }
  }
});

// ==================== УТИЛИТЫ ====================
function hash(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}
function token() {
  return crypto.randomBytes(24).toString('hex');
}
function chatId(a, b) {
  if (String(a).startsWith('group:')) return a;
  if (String(b).startsWith('group:')) return b;
  return [a, b].sort().join('|');
}
function genGroupId() {
  return 'g_' + crypto.randomBytes(6).toString('hex');
}

// ==================== PUSH-УВЕДОМЛЕНИЯ ====================
async function sendPushToUser(name, payload) {
  const subs = pushSubs[name] || [];
  if (!subs.length) return;

  const body = JSON.stringify({
    title: payload.title || 'Новое сообщение',
    body: payload.body || '',
    from: payload.from || '',
    chatWith: payload.chatWith || '',
    tag: payload.tag || 'msg'
  });

  const dead = [];
  for (let i = 0; i < subs.length; i++) {
    try {
      await webpush.sendNotification(subs[i], body);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        dead.push(i);  // подписка устарела
      } else {
        console.error('Push error:', err.message);
      }
    }
  }

  if (dead.length) {
    pushSubs[name] = subs.filter((_, i) => !dead.includes(i));
    saveJSON(PUSH_SUBS_FILE, pushSubs);
  }
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
    createdAt: Date.now(),
    avatar: null          // ← новое поле
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
  const u = users[name];
  res.json({ name, avatar: (u && u.avatar) || null });
});


// Middleware для определения пользователя при загрузке
function requireAuth(req, res, next) {
  const t = req.headers['x-token'] || req.query.token;
  const name = sessions.get(t);
  if (!name) return res.status(401).json({ error: 'unauthorized' });
  req.username = name;
  next();
}

app.post('/api/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.json({ error: 'Файл не загружен' });

  const name = req.username;
  const ext = path.extname(req.file.filename);
  const url = `/avatars/${name}${ext}?v=${Date.now()}`;

  // Удалим старые аватарки с другим расширением
  ['png', 'jpg', 'bin'].forEach(e => {
    const oldPath = path.join(AVATARS_DIR, name + '.' + e);
    if (e !== ext.slice(1) && fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (_) {}
    }
  });

  users[name].avatar = url;
  saveJSON(USERS_FILE, users);

  res.json({ ok: true, avatar: url });
});

// ==================== ЗАГРУЗКА МЕДИА (фото/голос) ====================
app.post('/api/upload', requireAuth, uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: 'Файл не загружен' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url, size: req.file.size });
});

app.get('/api/users', (req, res) => {
  const t = req.headers['x-token'];
  const me = sessions.get(t);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  const list = Object.values(users)
    .filter(u => u.name !== me)
    .map(u => ({
      name: u.name,
      online: online.has(u.name),
      avatar: u.avatar || null
    }));

  res.json({ users: list });
});

app.get('/api/messages/:with', (req, res) => {
  const t = req.headers['x-token'];
  const me = sessions.get(t);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  const otherRaw = String(req.params.with);
  let id;

  if (otherRaw.startsWith('group:')) {
    const gid = otherRaw;
    const g = groups[gid];
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    if (!g.members.includes(me)) return res.status(403).json({ error: 'Нет доступа' });
    id = gid;
  } else {
    const other = otherRaw.toLowerCase();
    id = chatId(me, other);
  }

  res.json({ messages: messages[id] || [] });
});

// Список групп пользователя
app.get('/api/groups', (req, res) => {
  const t = req.headers['x-token'];
  const me = sessions.get(t);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  const list = Object.values(groups).filter(g => g.members.includes(me));
  res.json({ groups: list });
});

app.get('/api/vapid-public', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const name = req.username;
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });

  if (!pushSubs[name]) pushSubs[name] = [];

  // Не дублируем
  const exists = pushSubs[name].some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    pushSubs[name].push(sub);
    saveJSON(PUSH_SUBS_FILE, pushSubs);
  }

  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const name = req.username;
  const endpoint = req.body && req.body.endpoint;
  if (!name || !endpoint) return res.status(400).json({ error: 'bad request' });

  if (pushSubs[name]) {
    pushSubs[name] = pushSubs[name].filter(s => s.endpoint !== endpoint);
    saveJSON(PUSH_SUBS_FILE, pushSubs);
  }
  res.json({ ok: true });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  socket.on('auth', ({ token: t }) => {
    const name = sessions.get(t);
    if (!name) return socket.emit('authError');

    socket.username = name;
    online.set(name, socket.id);

    socket.emit('authed', { name, avatar: users[name]?.avatar || null });
    io.emit('presence', {
  users: Object.values(users).map(u => ({
    name: u.name,
    avatar: u.avatar || null,
    online: online.has(u.name)
  }))
});
  });

   socket.on('send', ({ to, text, type, url, duration, replyTo }) => {
    const from = socket.username;
    if (!from || !to) return;

    const msgType = type || 'text';
    let msg;

    if (msgType === 'text') {
      const clean = String(text || '').slice(0, 2000).trim();
      if (!clean) return;
      msg = { from, to, type: 'text', text: clean, at: Date.now() };
    } else if (msgType === 'image') {
      if (!url || !String(url).startsWith('/uploads/')) return;
      msg = { from, to, type: 'image', url, text: String(text || '').slice(0, 200), at: Date.now() };
    } else if (msgType === 'voice') {
      if (!url || !String(url).startsWith('/uploads/')) return;
      msg = { from, to, type: 'voice', url, duration: Number(duration) || 0, at: Date.now() };
    } else {
      return;
    }

       // новые поля
    msg.id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    msg.read = false;
    if (replyTo && replyTo.at) {
      msg.replyTo = {
        at: replyTo.at,
        from: replyTo.from || '',
        name: replyTo.name || '',
        text: String(replyTo.text || '').slice(0, 100),
        type: replyTo.type || 'text'
      };
    }

    const isGroup = String(to).startsWith('group:');
    const id = chatId(from, to);
    if (!messages[id]) messages[id] = [];
    messages[id].push(msg);
    if (messages[id].length > 2000) messages[id] = messages[id].slice(-2000);
    saveJSON(MSG_FILE, messages);

    const preview = msg.type === 'image' ? '📷 Фото'
                  : msg.type === 'voice' ? '🎤 Голосовое'
                  : String(msg.text || '').slice(0, 80);

    if (isGroup) {
      const g = groups[to];
      if (!g) return;
      const members = g.members.filter(m => m !== from);
      members.forEach(m => {
        const toSock = online.get(m);
        if (toSock) io.to(toSock).emit('message', msg);
        // push всем, кто не в этой группе открыт (упрощённо — всем)
        sendPushToUser(m, {
          title: `👥 ${g.name}`,
          body: `${from}: ${preview}`,
          from,
          chatWith: to,
          tag: 'msg-' + to
        });
      });
      socket.emit('message', msg);
    } else {
      msg.delivered = online.has(to);
      socket.emit('message', msg);
      const toSock = online.get(to);
      if (toSock) io.to(toSock).emit('message', msg);
      // push получателю
      sendPushToUser(to, {
        title: from,
        body: preview,
        from,
        chatWith: from,
        tag: 'msg-' + from
      });
    }
  });

  // Прочитано: пользователь открыл чат — все входящие от `with` помечаем прочитанными
  socket.on('read', ({ with: other }) => {
    const from = socket.username;
    if (!from || !other) return;
    const id = chatId(from, other);
    const arr = messages[id] || [];
    let changed = false;
    arr.forEach(m => {
      if (m.from === other && !m.read) { m.read = true; changed = true; }
    });
    if (changed) {
      saveJSON(MSG_FILE, messages);
      const toSock = online.get(other);
      if (toSock) io.to(toSock).emit('readReceipt', { with: from });
    }
  });

  // Реакция на сообщение
  socket.on('react', ({ to, msgAt, emoji }) => {
    const from = socket.username;
    if (!from || !to || !msgAt || !emoji) return;
    const id = chatId(from, to);
    const arr = messages[id] || [];
    const msg = arr.find(m => m.at === msgAt);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const list = msg.reactions[emoji];
    const i = list.indexOf(from);
    if (i >= 0) list.splice(i, 1);
    else list.push(from);
    if (list.length === 0) delete msg.reactions[emoji];
    if (Object.keys(msg.reactions).length === 0) delete msg.reactions;

    saveJSON(MSG_FILE, messages);

    const reactions = msg.reactions || {};
    socket.emit('reaction', { chatWith: to, msgAt, reactions });
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('reaction', { chatWith: from, msgAt, reactions });
  });

  // Удаление своего сообщения
  socket.on('delete', ({ to, msgAt }) => {
    const from = socket.username;
    if (!from || !to || !msgAt) return;
    const id = chatId(from, to);
    const arr = messages[id] || [];
    const i = arr.findIndex(m => m.at === msgAt && m.from === from);
    if (i === -1) return;
    arr.splice(i, 1);
    saveJSON(MSG_FILE, messages);
    socket.emit('deleted', { chatWith: to, msgAt });
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('deleted', { chatWith: from, msgAt });
  });

  // Закреп / открепление сообщения
  socket.on('pin', ({ to, msgAt }) => {
    const from = socket.username;
    if (!from || !to) return;
    const id = chatId(from, to);
    const arr = messages[id] || [];
    // Найдём целевое сообщение и снимем закрепы со всех
    arr.forEach(m => { m.pinned = false; });
    if (msgAt) {
      const target = arr.find(m => m.at === msgAt);
      if (target) target.pinned = true;
    }
    saveJSON(MSG_FILE, messages);
    const pinnedMsg = arr.find(m => m.pinned);
    socket.emit('pinned', { chatWith: to, msg: pinnedMsg || null });
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('pinned', { chatWith: from, msg: pinnedMsg || null });
  });

  // Поиск по сообщениям (от сервера)
  socket.on('search', ({ query }) => {
    const from = socket.username;
    if (!from || !query) return socket.emit('searchResults', { query: '', results: [] });
    const q = String(query).toLowerCase().slice(0, 100);

    const results = [];
    Object.entries(messages).forEach(([chatKey, arr]) => {
      if (!chatKey.includes(from)) return; // чат не наш
      const parts = chatKey.split('|');
      const other = parts[0] === from ? parts[1] : parts[0];
      arr.forEach(m => {
        if (m.type !== 'text') return;
        if (!m.text) return;
        if (m.text.toLowerCase().includes(q)) {
          results.push({
            chatWith: other,
            at: m.at,
            from: m.from,
            text: m.text.slice(0, 200)
          });
        }
      });
    });
    results.sort((a, b) => b.at - a.at);
    socket.emit('searchResults', { query: q, results: results.slice(0, 100) });
  });

  socket.on('typing', ({ to, typing }) => {
    const from = socket.username;
    if (!from || !to) return;
    const toSock = online.get(to);
    if (toSock) io.to(toSock).emit('typing', { from, typing: !!typing });
  });

  // Создание группы
  socket.on('createGroup', ({ name, members }) => {
    const me = socket.username;
    if (!me) return;
    const gname = String(name || '').trim().slice(0, 40);
    if (!gname) return socket.emit('errorMsg', 'Введи название группы');
    if (!Array.isArray(members) || members.length === 0) {
      return socket.emit('errorMsg', 'Выбери хотя бы одного участника');
    }
    const cleanMembers = Array.from(new Set([me, ...members]))
      .filter(n => users[n]);

    if (cleanMembers.length < 2) {
      return socket.emit('errorMsg', 'Нужен хотя бы один участник');
    }

    const gid = 'group:' + genGroupId();
    groups[gid] = {
      id: gid,
      name: gname,
      creator: me,
      members: cleanMembers,
      createdAt: Date.now()
    };
    saveJSON(GROUPS_FILE, groups);

    // Уведомить всех онлайн-участников
    cleanMembers.forEach(m => {
      const toSock = online.get(m);
      if (toSock) {
        io.to(toSock).emit('groupCreated', { group: groups[gid] });
      }
    });

    // Подтверждение создателю
    socket.emit('groupCreated', { group: groups[gid], isMine: true });
  });

  // Выход из группы
  socket.on('leaveGroup', ({ groupId }) => {
    const me = socket.username;
    if (!me || !groupId) return;
    const g = groups[groupId];
    if (!g) return;
    g.members = g.members.filter(m => m !== me);
    if (g.members.length === 0) {
      delete groups[groupId];
      saveJSON(GROUPS_FILE, groups);
    } else {
      saveJSON(GROUPS_FILE, groups);
    }

    // Уведомить оставшихся
    g.members.forEach(m => {
      const toSock = online.get(m);
      if (toSock) io.to(toSock).emit('groupUpdate', { group: g });
    });

    socket.emit('groupLeft', { groupId });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      online.delete(socket.username);
io.emit('presence', {
  users: Object.values(users).map(u => ({
    name: u.name,
    avatar: u.avatar || null,
    online: online.has(u.name)
  }))
});
    }
  });
});

// ==================== СТАРТ ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n💬 Мессенджер запущен!`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});