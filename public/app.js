(() => {
  // ===== СОСТОЯНИЕ =====
  const state = {
    token: localStorage.getItem('token') || null,
    me: null,
    users: [],
    online: [],
    currentChat: null,        // имя собеседника
    messages: {},             // chatName -> [msg]
    socket: null,
    typingTimer: null,
    otherTypingTimer: null
  };

  // ===== DOM =====
  const $ = id => document.getElementById(id);
  const authScreen = $('auth');
  const mainScreen = $('main');
  const chatScreen = $('chatScreen');
  const authForm = $('authForm');
  const usernameInput = $('username');
  const passwordInput = $('password');
  const authSubmit = $('authSubmit');
  const authError = $('authError');
  const tabLogin = $('tabLogin');
  const tabRegister = $('tabRegister');
  const chatList = $('chatList');
  const messagesEl = $('messages');
  const messageInput = $('messageInput');
  const sendBtn = $('sendBtn');
  const chatTitle = $('chatTitle');
  const chatAvatar = $('chatAvatar');
  const typingIndicator = $('typingIndicator');

  let authMode = 'login'; // or 'register'

  // ===== API =====
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers['x-token'] = state.token;
    const res = await fetch(path, { ...opts, headers });
    return res.json();
  }

  // ===== UI: переключение экранов =====
  function showScreen(name) {
    [authScreen, mainScreen].forEach(s => s.classList.remove('active'));
    if (name === 'auth') authScreen.classList.add('active');
    if (name === 'main') mainScreen.classList.add('active');
    chatScreen.classList.remove('active');
  }

  function showChatScreen(on) {
    chatScreen.classList.toggle('active', !!on);
  }

  // ===== АВТОРИЗАЦИЯ =====
  tabLogin.onclick = () => setAuthMode('login');
  tabRegister.onclick = () => setAuthMode('register');

  function setAuthMode(mode) {
    authMode = mode;
    tabLogin.classList.toggle('active', mode === 'login');
    tabRegister.classList.toggle('active', mode === 'register');
    authSubmit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authError.textContent = '';
  }

  authForm.onsubmit = async (e) => {
    e.preventDefault();
    authError.textContent = '';
    authSubmit.disabled = true;
    authSubmit.textContent = '...';

    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    try {
      const path = authMode === 'login' ? '/api/login' : '/api/register';
      const data = await api(path, {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      if (data.error) {
        authError.textContent = data.error;
        return;
      }

      state.token = data.token;
      state.me = data.name;
      localStorage.setItem('token', data.token);
      localStorage.setItem('me', data.name);
      passwordInput.value = '';

      await enterMain();
    } catch (err) {
      authError.textContent = 'Ошибка сети. Попробуй ещё раз.';
      console.error(err);
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  };

  // ===== ВХОД В ГЛАВНЫЙ ЭКРАН =====
  async function enterMain() {
    showScreen('main');
    await loadUsers();
    connectSocket();
  }

  async function loadUsers() {
    const data = await api('/api/users');
    if (data.error) {
      if (data.error === 'unauthorized') return logout();
      return;
    }
    state.users = data.users || [];
    renderChatList();
  }

  function renderChatList() {
    chatList.innerHTML = '';
    if (!state.users.length) {
      chatList.innerHTML = '<div class="empty">Нет других пользователей.<br>Позови друзей!</div>';
      return;
    }

    // Сортировка: онлайн сначала, потом по алфавиту
    const sorted = [...state.users].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach(u => {
      const item = document.createElement('div');
      item.className = 'chat-item';
      item.dataset.name = u.name;

      const initial = u.name[0].toUpperCase();
      const last = getLastMessage(u.name);

      item.innerHTML = `
        <div class="avatar">${initial}${u.online ? '<span class="online-dot"></span>' : ''}</div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(u.name)}</div>
          <div class="chat-last">${last ? escapeHtml(last.text.slice(0, 40)) : (u.online ? 'в сети' : 'не в сети')}</div>
        </div>
      `;
      item.onclick = () => openChat(u.name);
      chatList.appendChild(item);
    });
  }

  function getLastMessage(withName) {
    const arr = state.messages[withName];
    if (!arr || !arr.length) return null;
    return arr[arr.length - 1];
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== ЧАТ =====
  async function openChat(name) {
    state.currentChat = name;
    chatTitle.textContent = name;
    chatAvatar.textContent = name[0].toUpperCase();
    chatAvatar.style.background = 'linear-gradient(135deg, #3a6ea5, #2b5278)';

    // Подсветка в списке
    document.querySelectorAll('.chat-item').forEach(el => {
      el.classList.toggle('active', el.dataset.name === name);
    });

    showChatScreen(true);
    messagesEl.innerHTML = '<div class="empty" style="padding:20px;">Загрузка…</div>';

    const data = await api(`/api/messages/${encodeURIComponent(name)}`);
    if (data.error) return;
    state.messages[name] = data.messages || [];
    renderMessages();
    scrollToBottom();
    messageInput.focus();
  }

  function renderMessages() {
    const list = state.messages[state.currentChat] || [];
    messagesEl.innerHTML = '';

    if (!list.length) {
      messagesEl.innerHTML = '<div class="empty" style="padding:20px;">Пока нет сообщений.<br>Напиши первым!</div>';
      return;
    }

    let lastDay = '';
    list.forEach(m => {
      const day = dayKey(m.at);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.textContent = dayLabel(m.at);
        messagesEl.appendChild(divider);
        lastDay = day;
      }

      const bubble = document.createElement('div');
      const isOut = m.from === state.me;
      bubble.className = 'msg ' + (isOut ? 'out' : 'in');
      bubble.innerHTML = `${escapeHtml(m.text)}<span class="msg-time">${timeLabel(m.at)}</span>`;
      messagesEl.appendChild(bubble);
    });
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function timeLabel(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Назад из чата
  $('backBtn').onclick = () => {
    showChatScreen(false);
    state.currentChat = null;
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    loadUsers();
  };

  $('refreshBtn').onclick = async () => {
    if (state.currentChat) await openChat(state.currentChat);
  };

  // ===== ОТПРАВКА =====
  messageInput.addEventListener('input', () => {
    const has = messageInput.value.trim().length > 0;
    sendBtn.disabled = !has;
    autoResize();

    // Отправим «печатает…»
    if (state.currentChat && state.socket) {
      state.socket.emit('typing', { to: state.currentChat, typing: true });
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        state.socket.emit('typing', { to: state.currentChat, typing: false });
      }, 1500);
    }
  });

  function autoResize() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  }

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.onclick = sendMessage;

  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !state.currentChat || !state.socket) return;

    state.socket.emit('send', { to: state.currentChat, text });
    messageInput.value = '';
    sendBtn.disabled = true;
    autoResize();
    messageInput.focus();
  }

  // ===== SOCKET.IO =====
  function connectSocket() {
    if (state.socket) state.socket.disconnect();

    state.socket = io();

    state.socket.on('connect', () => {
      state.socket.emit('auth', { token: state.token });
    });

    state.socket.on('authError', () => {
      logout();
    });

    state.socket.on('authed', ({ name }) => {
      state.me = name;
      console.log('✅ Подключено как', name);
    });

    state.socket.on('presence', ({ users }) => {
      state.online = users || [];
      state.users.forEach(u => u.online = state.online.includes(u.name));
      renderChatList();
    });

    state.socket.on('message', (msg) => {
      const other = msg.from === state.me ? msg.to : msg.from;
      if (!state.messages[other]) state.messages[other] = [];

      // Защита от дублей
      const last = state.messages[other][state.messages[other].length - 1];
      if (!last || last.at !== msg.at || last.text !== msg.text) {
        state.messages[other].push(msg);
      }

      if (state.currentChat === other) {
        renderMessages();
        scrollToBottom();
        typingIndicator.textContent = '';
      } else {
        // Обновим превью в списке
        renderChatList();
      }
    });

    state.socket.on('typing', ({ from, typing }) => {
      if (state.currentChat === from) {
        typingIndicator.textContent = typing ? `${from} печатает…` : '';
      }
    });
  }

  // ===== ВЫХОД =====
  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('me');
    state.token = null;
    state.me = null;
    state.messages = {};
    state.users = [];
    state.currentChat = null;
    if (state.socket) state.socket.disconnect();
    showScreen('auth');
    usernameInput.value = '';
    passwordInput.value = '';
    authError.textContent = '';
  }

  $('logoutBtn').onclick = logout;

  // ===== СТАРТ =====
  async function start() {
    if (state.token) {
      // Проверим, валиден ли токен
      const data = await api('/api/me');
      if (data.name) {
        state.me = data.name;
        await enterMain();
        return;
      }
      // Токен просрочен
      logout();
    } else {
      showScreen('auth');
    }
  }

  start();
})();