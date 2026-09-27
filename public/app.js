(() => {
  // ===== СОСТОЯНИЕ =====
    const state = {
    token: localStorage.getItem('token') || null,
    me: null,
    myAvatar: null,
    users: [],
    online: [],
    groups: [],              // ← новое
    currentChat: null,
    currentChatType: 'user', // ← 'user' или 'group'
    messages: {},
    socket: null,
    typingTimer: null,
    otherTypingTimer: null,
    replyTo: null,
    menuMsgAt: null
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
  const replyBar = $('replyBar');
  const replyBarName = $('replyBarName');
  const replyBarText = $('replyBarText');
  const msgMenu = $('msgMenu');
  const themePicker = $('themePicker');
  const pinnedBar = $('pinnedBar');
  const pinnedBarName = $('pinnedBarName');
  const pinnedBarText = $('pinnedBarText');
  const searchOverlay = $('searchOverlay');
  const searchInput = $('searchInput');
  const searchResults = $('searchResults');
  const newGroupModal = $('newGroupModal');
  const groupNameInput = $('groupNameInput');
  const membersPicker = $('membersPicker');
  const leaveGroupBtn = $('leaveGroupBtn');
  const notifBtn = $('notifBtn');

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
    // Подгрузим свою аватарку
    const meData = await api('/api/me');
    state.myAvatar = meData.avatar || null;
    renderMyAvatar();
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

    // Загрузим группы
    const gr = await api('/api/groups');
    if (!gr.error) state.groups = gr.groups || [];

    renderChatList();
  }

  function lastPreview(m, isOnline) {
    if (!m) return isOnline ? 'в сети' : 'не в сети';
    if (m.type === 'image') return '📷 Фото';
    if (m.type === 'voice') return '🎤 Голосовое';
    return escapeHtml(String(m.text || '').slice(0, 40));
  }

      function renderChatList() {
    chatList.innerHTML = '';
    if (!state.users.length && !state.groups.length) {
      chatList.innerHTML = '<div class="empty">Нет чатов.<br>Позови друзей!</div>';
      return;
    }

    // Группы
    state.groups.forEach(g => {
      const item = document.createElement('div');
      item.className = 'chat-item';
      item.dataset.groupId = g.id;

      const last = getLastMessage(g.id);
      const others = g.members.filter(m => m !== state.me);
      const memCount = g.members.length;

      item.innerHTML = `
        <div class="avatar group-icon">👥</div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(g.name)}</div>
          <div class="chat-last">${lastPreviewGroup(last, memCount)}</div>
        </div>
      `;
      item.onclick = () => openChat(g.id);
      chatList.appendChild(item);
    });

    // Личные чаты
    const sorted = [...state.users].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach(u => {
      const item = document.createElement('div');
      item.className = 'chat-item';
      item.dataset.name = u.name;

      const last = getLastMessage(u.name);
      const initial = u.name[0].toUpperCase();
      const avatarHtml = u.avatar
        ? `<img src="${u.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
        : initial;

      item.innerHTML = `
        <div class="avatar">${avatarHtml}${u.online ? '<span class="online-dot"></span>' : ''}</div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(u.name)}</div>
          <div class="chat-last">${lastPreview(last, u.online)}</div>
        </div>
      `;
      item.onclick = () => openChat(u.name);
      chatList.appendChild(item);
    });
  }

  function lastPreviewGroup(m, memCount) {
    if (!m) return `${memCount} участников`;
    const prefix = m.from === state.me ? 'Ты: ' :
      (state.users.find(u => u.name === m.from)?.name || m.from) + ': ';
    if (m.type === 'image') return prefix + '📷 Фото';
    if (m.type === 'voice') return prefix + '🎤 Голосовое';
    return prefix + String(m.text || '').slice(0, 40);
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
   async function openChat(nameOrGid) {
    const isGroup = String(nameOrGid).startsWith('group:');
    state.currentChat = nameOrGid;
    state.currentChatType = isGroup ? 'group' : 'user';

    if (isGroup) {
      const g = state.groups.find(x => x.id === nameOrGid);
      chatTitle.textContent = g ? g.name : 'Группа';
      chatAvatar.textContent = '👥';
      chatAvatar.classList.add('group-icon');
      leaveGroupBtn.style.display = 'flex';
    } else {
      chatTitle.textContent = nameOrGid;
      const user = state.users.find(u => u.name === nameOrGid);
      if (user && user.avatar) {
        chatAvatar.innerHTML = `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        chatAvatar.style.background = 'transparent';
      } else {
        chatAvatar.textContent = nameOrGid[0].toUpperCase();
        chatAvatar.style.background = 'linear-gradient(135deg, var(--accent), var(--accent-dark))';
      }
      chatAvatar.classList.remove('group-icon');
      leaveGroupBtn.style.display = 'none';
    }

    // Подсветка в списке
    document.querySelectorAll('.chat-item').forEach(el => {
      const match = isGroup
        ? el.dataset.groupId === nameOrGid
        : el.dataset.name === nameOrGid;
      el.classList.toggle('active', match);
    });

    showChatScreen(true);
    messagesEl.innerHTML = '<div class="empty" style="padding:20px;">Загрузка…</div>';

    const data = await api(`/api/messages/${encodeURIComponent(nameOrGid)}`);
    if (data.error) {
      messagesEl.innerHTML = '<div class="empty" style="padding:20px;">Нет доступа</div>';
      return;
    }
    state.messages[nameOrGid] = data.messages || [];
    const pinned = (data.messages || []).find(m => m.pinned);
    renderPinned(pinned || null);
    renderMessages();
    scrollToBottom();
    messageInput.focus();

    if (state.socket && !isGroup) {
      state.socket.emit('read', { with: nameOrGid });
    }
  }

  function renderMessages() {
    const list = state.messages[state.currentChat] || [];
    messagesEl.innerHTML = '';

    if (!list.length) {
      messagesEl.innerHTML = '<div class="empty" style="padding:20px;">Пока нет сообщений.<br>Напиши первым!</div>';
      return;
    }

    let lastDay = '';
        list.forEach((m, idx) => {
      if (m.deleted) return;
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
      if (state.currentChatType === 'group') bubble.classList.add('msg-group');
      bubble.dataset.idx = idx;
      bubble.dataset.at = m.at;

      // --- Reply preview ---
      let replyHtml = '';
      if (m.replyTo) {
        replyHtml = `
          <div class="msg-reply" data-reply-at="${m.replyTo.at}">
            <div class="msg-reply-name">${escapeHtml(m.replyTo.name || '')}</div>
            <div class="msg-reply-text">${escapeHtml(m.replyTo.text || '')}</div>
          </div>
        `;
      }

      // --- Основной контент ---
      let contentHtml = '';
      if (m.type === 'image') {
        bubble.classList.add('msg-image');
        contentHtml = `<img src="${escapeHtml(m.url)}" loading="lazy" alt="">`;
      } else if (m.type === 'voice') {
        bubble.classList.add('msg-voice');
        const bars = renderWaveBars();
        contentHtml = `
          <button class="voice-play" data-play="${idx}">▶</button>
          <div class="voice-wave" data-seek="${idx}">
            <div class="voice-wave-bars">${bars}</div>
          </div>
          <div class="voice-time" data-dur="${idx}">${formatDur(m.duration)}</div>
        `;
      } else {
        contentHtml = escapeHtml(m.text || '');
      }

      // --- Время + галочки ---
      let checksHtml = '';
      if (isOut) {
        const read = m.read === true;
        checksHtml = `<span class="msg-checks ${read ? 'read' : ''}">${m.delivered ? '✓✓' : '✓'}</span>`;
      }
      const timeHtml = `<span class="msg-time">${timeLabel(m.at)}${checksHtml}</span>`;

               let senderHtml = '';
      if (state.currentChatType === 'group' && !isOut) {
        const senderName = state.users.find(u => u.name === m.from)?.name || m.from;
        senderHtml = `<div class="msg-sender">${escapeHtml(senderName)}</div>`;
      }
      bubble.innerHTML = replyHtml + senderHtml + `<div>${contentHtml}${timeHtml}</div>`;
      if (m.pinned) {
        const pin = document.createElement('div');
        pin.style.cssText = 'font-size:11px;color:var(--accent);margin-top:4px;opacity:.8;';
        pin.textContent = '📌 Закреплено';
        bubble.appendChild(pin);
      }

      // Реакции
      if (m.reactions && Object.keys(m.reactions).length) {
        const reactions = document.createElement('div');
        reactions.className = 'msg-reactions';
        Object.entries(m.reactions).forEach(([emoji, names]) => {
          const chip = document.createElement('div');
          const mine = Array.isArray(names) && names.includes(state.me);
          chip.className = 'reaction-chip' + (mine ? ' mine' : '');
          chip.innerHTML = `<span>${emoji}</span><span>${(names || []).length}</span>`;
          chip.onclick = (e) => {
            e.stopPropagation();
            if (state.socket && state.currentChat) {
              state.socket.emit('react', { to: state.currentChat, msgAt: m.at, emoji });
            }
          };
          reactions.appendChild(chip);
        });
        bubble.appendChild(reactions);
      }

      // Клики
      if (m.type === 'image') {
        bubble.querySelector('img').onclick = () => openLightbox(m.url);
      } else if (m.type === 'voice') {
        bubble.querySelector('.voice-play').onclick = () => toggleVoice(m, idx, bubble);
      }

      // Reply click → перейти к оригинальному сообщению
      const replyEl = bubble.querySelector('.msg-reply');
      if (replyEl) {
        replyEl.onclick = () => scrollToMsg(m.replyTo.at);
      }

      // Долгое нажатие / правый клик → меню
      attachMsgContextHandlers(bubble, m);

      messagesEl.appendChild(bubble);
    });
  }

  // Прокрутка к сообщению по at
  function scrollToMsg(at) {
    const el = messagesEl.querySelector(`.msg[data-at="${at}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 1200);
  }

  // Контекст-меню сообщения
  let longPressTimer = null;
  function attachMsgContextHandlers(bubble, msg) {
    // Правый клик (ПК)
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMsgMenu(e.clientX, e.clientY, msg);
    });
    // Долгое нажатие (тач)
    bubble.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      longPressTimer = setTimeout(() => {
        openMsgMenu(t.clientX, t.clientY, msg);
        // вибро, если есть
        if (navigator.vibrate) navigator.vibrate(20);
      }, 450);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => {
      bubble.addEventListener(ev, () => {
        clearTimeout(longPressTimer);
      }, { passive: true });
    });
  }

  function openMsgMenu(x, y, msg) {
    state.menuMsgAt = msg.at;
    msgMenu.classList.add('active');

    // Позиционирование
    const menuW = msgMenu.offsetWidth || 240;
    const menuH = msgMenu.offsetHeight || 100;
    let px = Math.min(x, window.innerWidth - menuW - 8);
    let py = Math.min(y, window.innerHeight - menuH - 8);
    px = Math.max(8, px);
    py = Math.max(8, py);
    msgMenu.style.left = px + 'px';
    msgMenu.style.top = py + 'px';
  }

  function closeMsgMenu() {
    msgMenu.classList.remove('active');
    state.menuMsgAt = null;
  }

  // Клик мимо меню — закрыть
  document.addEventListener('click', (e) => {
    if (!msgMenu.classList.contains('active')) return;
    if (msgMenu.contains(e.target)) return;
    closeMsgMenu();
  });

  // Обработчики эмодзи и reply в меню
  msgMenu.querySelectorAll('[data-emoji]').forEach(btn => {
    btn.onclick = () => {
      const emoji = btn.dataset.emoji;
      if (state.socket && state.currentChat && state.menuMsgAt) {
        state.socket.emit('react', {
          to: state.currentChat,
          msgAt: state.menuMsgAt,
          emoji
        });
      }
      closeMsgMenu();
    };
  });

  $('msgMenuReply').onclick = () => {
    if (!state.menuMsgAt) { closeMsgMenu(); return; }
    const list = state.messages[state.currentChat] || [];
    const m = list.find(x => x.at === state.menuMsgAt);
    if (m) {
      state.replyTo = m;
      showReplyBar(m);
      messageInput.focus();
    }
    closeMsgMenu();
  };

  function showReplyBar(m) {
    replyBar.style.display = 'flex';
    replyBarName.textContent = m.from === state.me ? 'Ты' : (state.users.find(u => u.name === m.from)?.name || m.from);
    replyBarText.textContent =
      m.type === 'image' ? '📷 Фото' :
      m.type === 'voice' ? '🎤 Голосовое' :
      (m.text || '');
  }

  function hideReplyBar() {
    replyBar.style.display = 'none';
    state.replyTo = null;
  }

  document.getElementById('replyBarClose').onclick = hideReplyBar;

  function renderWaveBars() {
    let s = '';
    for (let i = 0; i < 28; i++) {
      const h = 20 + Math.random() * 80;
      s += `<span style="height:${h}%"></span>`;
    }
    return s;
  }

  function formatDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
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
    renderPinned(null);
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

    const payload = { to: state.currentChat, text };
    if (state.replyTo) {
      payload.replyTo = {
        at: state.replyTo.at,
        from: state.replyTo.from,
        name: (state.users.find(u => u.name === state.replyTo.from)?.name) || state.replyTo.from,
        text: state.replyTo.type === 'image' ? '📷 Фото' :
              state.replyTo.type === 'voice' ? '🎤 Голосовое' :
              (state.replyTo.text || ''),
        type: state.replyTo.type || 'text'
      };
    }

    state.socket.emit('send', payload);
    messageInput.value = '';
    sendBtn.disabled = true;
    autoResize();
    hideReplyBar();
    messageInput.focus();
  }

  // ===== ФОТО =====
  const photoInput = document.getElementById('photoInput');
  const attachBtn = document.getElementById('attachBtn');

  if (attachBtn) attachBtn.onclick = () => photoInput.click();

  if (photoInput) {
    photoInput.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      photoInput.value = '';
      if (!file) return;
      if (!state.currentChat) { alert('Открой чат'); return; }

      // 1) Сожмём до 1600px
      const compressed = await compressImage(file, 1600, 0.82);

      // 2) Загрузим
      const form = new FormData();
      form.append('file', compressed, 'photo.jpg');

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'x-token': state.token },
          body: form
        });
        const data = await res.json();
        if (data.error) { alert(data.error); return; }

        // 3) Отправим сообщение с url
        state.socket.emit('send', {
          to: state.currentChat,
          type: 'image',
          url: data.url,
          text: ''
        });
      } catch (err) {
        console.error(err);
        alert('Не удалось загрузить фото');
      }
    };
  }

  function compressImage(file, maxSize, quality) {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) return resolve(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => resolve(blob || file),
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }

  // ===== ГОЛОСОВЫЕ =====
  const micBtn = document.getElementById('micBtn');
  const recordingOverlay = document.getElementById('recordingOverlay');
  const recordingTimeEl = document.getElementById('recordingTime');

  let mediaRecorder = null;
  let audioChunks = [];
  let recordStart = 0;
  let recordTimer = null;
  let recordCancelled = false;

  function pickAudioMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function startRecording() {
    if (!state.currentChat) { alert('Открой чат'); return; }
    if (mediaRecorder) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      recordCancelled = false;

      const mime = pickAudioMime();
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const dur = (Date.now() - recordStart) / 1000;
        mediaRecorder = null;

        if (recordCancelled || dur < 0.5) {
          audioChunks = [];
          return;
        }
        await sendVoice(dur);
      };

      mediaRecorder.start();
      recordStart = Date.now();
      micBtn.classList.add('recording');
      recordingOverlay.classList.add('active');
      recordingTimeEl.textContent = '0:00';

      recordTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recordStart) / 1000);
        recordingTimeEl.textContent = formatDur(s);
        if (s >= 60) stopRecording(false); // макс 60 сек
      }, 200);

    } catch (err) {
      console.error(err);
      alert('Нет доступа к микрофону');
    }
  }

  function stopRecording(cancel) {
    if (!mediaRecorder) return;
    recordCancelled = !!cancel;
    try { mediaRecorder.stop(); } catch (_) {}
    clearInterval(recordTimer);
    recordTimer = null;
    micBtn.classList.remove('recording');
    recordingOverlay.classList.remove('active');
  }

  async function sendVoice(duration) {
    const mime = audioChunks[0] && audioChunks[0].type ? audioChunks[0].type : 'audio/webm';
    const blob = new Blob(audioChunks, { type: mime });

    let ext = 'webm';
    if (mime.includes('mp4')) ext = 'm4a';
    else if (mime.includes('ogg')) ext = 'ogg';
    else if (mime.includes('wav')) ext = 'wav';

    const form = new FormData();
    form.append('file', blob, 'voice.' + ext);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-token': state.token },
        body: form
      });
      const data = await res.json();
      if (data.error) { alert(data.error); return; }

      state.socket.emit('send', {
        to: state.currentChat,
        type: 'voice',
        url: data.url,
        duration: Math.round(duration)
      });
    } catch (err) {
      console.error(err);
      alert('Не удалось отправить голосовое');
    }
  }

  // Обработка кнопки-микрофона (pointer events, чтобы работало на тач и мыши)
  if (micBtn) {
    micBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startRecording();
    });
    micBtn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      stopRecording(false);
    });
    micBtn.addEventListener('pointerleave', () => {
      if (mediaRecorder) stopRecording(true); // ушёл с кнопки — отмена
    });
    micBtn.addEventListener('pointercancel', () => {
      if (mediaRecorder) stopRecording(true);
    });
  }

  // ===== ПЛЕЕР ГОЛОСОВЫХ =====
  const voiceAudio = new Audio();
  let currentVoiceBtn = null;
  let currentVoiceWave = null;
  let currentVoiceTimeEl = null;

  function toggleVoice(msg, idx, bubbleEl) {
    const playBtn = bubbleEl.querySelector('.voice-play');

    if (voiceAudio.src && voiceAudio.dataset.idx === String(idx) && !voiceAudio.paused) {
      voiceAudio.pause();
      playBtn.textContent = '▶';
      return;
    }

    // Сменим трек, если нужно
    if (voiceAudio.dataset.idx !== String(idx)) {
      voiceAudio.pause();
      voiceAudio.src = msg.url;
      voiceAudio.dataset.idx = idx;
      voiceAudio.load();

      // Сбросим старое
      if (currentVoiceBtn) currentVoiceBtn.textContent = '▶';
      document.querySelectorAll('.voice-wave-bars span.played').forEach(s => s.classList.remove('played'));

      currentVoiceBtn = playBtn;
      currentVoiceWave = bubbleEl.querySelector('.voice-wave');
      currentVoiceTimeEl = bubbleEl.querySelector('.voice-time');

      // Клик по волне = перемотка
      currentVoiceWave.onclick = (e) => {
        const rect = currentVoiceWave.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (voiceAudio.duration) voiceAudio.currentTime = pct * voiceAudio.duration;
      };
    }

    voiceAudio.play().then(() => {
      playBtn.textContent = '⏸';
    }).catch((e) => {
      console.error(e);
      playBtn.textContent = '▶';
    });
  }

  voiceAudio.addEventListener('timeupdate', () => {
    if (!currentVoiceWave) return;
    const bars = currentVoiceWave.querySelectorAll('.voice-wave-bars span');
    const pct = voiceAudio.duration ? voiceAudio.currentTime / voiceAudio.duration : 0;
    const played = Math.floor(pct * bars.length);
    bars.forEach((b, i) => b.classList.toggle('played', i < played));

    if (currentVoiceTimeEl) {
      const left = Math.max(0, (voiceAudio.duration || 0) - voiceAudio.currentTime);
      currentVoiceTimeEl.textContent = formatDur(left);
    }
  });

  voiceAudio.addEventListener('ended', () => {
    if (currentVoiceBtn) currentVoiceBtn.textContent = '▶';
    if (currentVoiceTimeEl && voiceAudio.duration) {
      currentVoiceTimeEl.textContent = formatDur(voiceAudio.duration);
    }
    document.querySelectorAll('.voice-wave-bars span.played').forEach(s => s.classList.remove('played'));
    currentVoiceWave = null;
    currentVoiceBtn = null;
  });

  // ===== ЛАЙТБОКС =====
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxClose = document.getElementById('lightboxClose');

  function openLightbox(url) {
    lightboxImg.src = url;
    lightbox.classList.add('active');
  }
  function closeLightbox() {
    lightbox.classList.remove('active');
    lightboxImg.src = '';
  }
  if (lightboxClose) lightboxClose.onclick = closeLightbox;
  if (lightbox) lightbox.onclick = (e) => {
    if (e.target === lightbox) closeLightbox();
  };

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
      const same = last &&
        last.at === msg.at &&
        last.from === msg.from &&
        (last.text || '') === (msg.text || '') &&
        (last.url || '') === (msg.url || '');
      if (!same) {
        state.messages[other].push(msg);
      }

      const isFromOther = msg.from !== state.me;

      if (state.currentChat === other) {
        renderMessages();
        scrollToBottom();
        typingIndicator.textContent = '';
        // если входящее — сразу прочитано
        if (isFromOther) {
          state.socket.emit('read', { with: other });
        }
      } else {
        renderChatList();
        // звук, если чат не открыт
        if (isFromOther) playNotifySound();
      }
    });

    // Прочитано (от собеседника)
    state.socket.on('readReceipt', ({ with: other }) => {
      const arr = state.messages[other] || [];
      let changed = false;
      arr.forEach(m => {
        if (m.from === state.me && !m.read) { m.read = true; changed = true; }
      });
      if (changed && state.currentChat === other) {
        renderMessages();
      }
    });

    // Реакция
    state.socket.on('reaction', ({ chatWith, msgAt, reactions }) => {
      const arr = state.messages[chatWith] || [];
      const msg = arr.find(m => m.at === msgAt);
      if (!msg) return;
      if (reactions && Object.keys(reactions).length) msg.reactions = reactions;
      else delete msg.reactions;
      if (state.currentChat === chatWith) renderMessages();
    });

    state.socket.on('typing', ({ from, typing }) => {
      if (state.currentChat === from) {
        typingIndicator.textContent = typing ? `${from} печатает…` : '';
      }
    });

    // Удалено
    state.socket.on('deleted', ({ chatWith, msgAt }) => {
      const arr = state.messages[chatWith] || [];
      const i = arr.findIndex(m => m.at === msgAt);
      if (i >= 0) arr.splice(i, 1);
      if (state.currentChat === chatWith) renderMessages();
      else renderChatList();
    });

    // Закреплено
    state.socket.on('pinned', ({ chatWith, msg }) => {
      const arr = state.messages[chatWith] || [];
      arr.forEach(m => { m.pinned = false; });
      if (msg) {
        const target = arr.find(m => m.at === msg.at);
        if (target) target.pinned = true;
      }
      if (state.currentChat === chatWith) {
        renderPinned(msg);
        renderMessages();
      }
    });

    // Результаты поиска
    state.socket.on('searchResults', ({ results }) => {
      renderSearchResults(results || []);
    });

    // Группа создана
    state.socket.on('groupCreated', ({ group, isMine }) => {
      if (!state.groups.find(g => g.id === group.id)) {
        state.groups.push(group);
      }
      renderChatList();
      if (isMine) {
        // Автору — открыть чат сразу
        openChat(group.id);
      } else {
        // Остальным — системное уведомление
        playNotifySound();
      }
    });

    // Группа обновилась (участники)
    state.socket.on('groupUpdate', ({ group }) => {
      const i = state.groups.findIndex(g => g.id === group.id);
      if (i >= 0) state.groups[i] = group;
      renderChatList();
    });

    // Вышел из группы
    state.socket.on('groupLeft', ({ groupId }) => {
      state.groups = state.groups.filter(g => g.id !== groupId);
      delete state.messages[groupId];
      if (state.currentChat === groupId) {
        showChatScreen(false);
        state.currentChat = null;
      }
      renderChatList();
    });

    state.socket.on('errorMsg', (msg) => {
      alert(msg);
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

  // ===== АВАТАРКИ =====
  function renderMyAvatar() {
    const el = document.getElementById('myAvatarBtn');
    if (!el) return;
    if (state.myAvatar) {
      el.innerHTML = `<img src="${state.myAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      el.style.background = 'transparent';
    } else {
      el.textContent = (state.me || '?')[0].toUpperCase();
      el.style.background = 'linear-gradient(135deg, #3a6ea5, #2b5278)';
    }
  }

  function uploadAvatar(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('Файл больше 2 МБ');
      return;
    }

    const form = new FormData();
    form.append('avatar', file);

    fetch('/api/avatar', {
      method: 'POST',
      headers: { 'x-token': state.token },
      body: form
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
          return;
        }
        state.myAvatar = data.avatar;
        renderMyAvatar();
        loadUsers();
      })
      .catch(err => {
        console.error(err);
        alert('Не удалось загрузить аватарку');
      });
  }

  // Кнопка смены аватарки
  const avatarBtn = document.getElementById('myAvatarBtn');
  const avatarFile = document.getElementById('avatarFile');
  if (avatarBtn && avatarFile) {
    avatarBtn.onclick = () => avatarFile.click();
    avatarFile.onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      uploadAvatar(f);
      e.target.value = '';
    };
  }

  // ===== ЗВУК УВЕДОМЛЕНИЯ =====
  let audioCtxNotify = null;
  function playNotifySound() {
    try {
      if (!audioCtxNotify) {
        audioCtxNotify = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxNotify.state === 'suspended') audioCtxNotify.resume();

      const now = audioCtxNotify.currentTime;
      const osc = audioCtxNotify.createOscillator();
      const gain = audioCtxNotify.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1200, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain).connect(audioCtxNotify.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch (_) {}
  }

  // Разблокировка аудио по первому клику (нужно для Chrome/Safari)
  window.addEventListener('click', () => {
    try {
      if (!audioCtxNotify) {
        audioCtxNotify = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxNotify.state === 'suspended') audioCtxNotify.resume();
    } catch (_) {}
  }, { once: true });

  // ==================== ТЕМЫ ====================
  const THEMES = ['theme-light-red', 'theme-light-green', 'theme-light-orange', 'theme-dark-gray'];
  const THEME_KEY = 'theme';

  function applyTheme(name) {
    const cls = 'theme-' + name;
    if (!THEMES.includes(cls)) return;
    document.body.classList.remove(...THEMES);
    document.body.classList.add(cls);
    localStorage.setItem(THEME_KEY, name);
  }

  // Восстановим тему при загрузке
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark-gray');

  // Кнопка темы
  $('themeBtn').onclick = (e) => {
    e.stopPropagation();
    themePicker.classList.toggle('active');
  };

  document.querySelectorAll('.theme-picker button').forEach(btn => {
    btn.onclick = () => {
      applyTheme(btn.dataset.theme);
      themePicker.classList.remove('active');
    };
  });

  document.addEventListener('click', (e) => {
    if (themePicker.classList.contains('active') && !themePicker.contains(e.target) && e.target.id !== 'themeBtn') {
      themePicker.classList.remove('active');
    }
  });

  // ==================== УДАЛЕНИЕ / ЗАКРЕП ====================
  const msgMenuDelete = $('msgMenuDelete');
  if (msgMenuDelete) {
    msgMenuDelete.onclick = () => {
      if (!state.menuMsgAt || !state.currentChat || !state.socket) return closeMsgMenu();
      const list = state.messages[state.currentChat] || [];
      const m = list.find(x => x.at === state.menuMsgAt);
      if (!m || m.from !== state.me) return closeMsgMenu();
      if (!confirm('Удалить это сообщение?')) return closeMsgMenu();
      state.socket.emit('delete', { to: state.currentChat, msgAt: state.menuMsgAt });
      closeMsgMenu();
    };
  }

  const msgMenuPin = $('msgMenuPin');
  if (msgMenuPin) {
    msgMenuPin.onclick = () => {
      if (!state.menuMsgAt || !state.currentChat || !state.socket) return closeMsgMenu();
      state.socket.emit('pin', { to: state.currentChat, msgAt: state.menuMsgAt });
      closeMsgMenu();
    };
  }

  // Обработчики socket-событий
  // Вставляй их в connectSocket — сделай это отдельно (см. 3.4)

  // ==================== ПАНЕЛЬ ЗАКРЕПА ====================
  function renderPinned(msg) {
    if (!msg) {
      pinnedBar.style.display = 'none';
      return;
    }
    pinnedBar.style.display = 'flex';
    pinnedBarName.textContent = msg.from === state.me
      ? 'Ты'
      : (state.users.find(u => u.name === msg.from)?.name || msg.from);
    pinnedBarText.textContent =
      msg.type === 'image' ? '📷 Фото' :
      msg.type === 'voice' ? '🎤 Голосовое' :
      (msg.text || '');
    pinnedBar.onclick = (e) => {
      if (e.target.id === 'pinnedBarClose') return;
      scrollToMsg(msg.at);
    };
  }

  $('pinnedBarClose').onclick = (e) => {
    e.stopPropagation();
    if (state.currentChat && state.socket) {
      state.socket.emit('pin', { to: state.currentChat, msgAt: null });
    }
  };

  // ==================== ПОИСК ====================
  $('searchBtn').onclick = () => {
    searchOverlay.classList.add('active');
    searchInput.value = '';
    searchResults.innerHTML = '<div class="search-empty">Введи запрос…</div>';
    searchInput.focus();
  };

  searchOverlay.onclick = (e) => {
    if (e.target === searchOverlay) searchOverlay.classList.remove('active');
  };

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.innerHTML = '<div class="search-empty">Введи запрос…</div>';
      return;
    }
    searchResults.innerHTML = '<div class="search-empty">Поиск…</div>';
    searchDebounce = setTimeout(() => {
      if (state.socket) state.socket.emit('search', { query: q });
    }, 300);
  });

  function renderSearchResults(results) {
    searchResults.innerHTML = '';
    if (!results.length) {
      searchResults.innerHTML = '<div class="search-empty">Ничего не найдено</div>';
      return;
    }
    results.forEach(r => {
      const el = document.createElement('div');
      el.className = 'search-result';
      const who = r.from === state.me ? 'Ты' : (state.users.find(u => u.name === r.from)?.name || r.from);
      el.innerHTML = `
        <div class="search-result-who">${escapeHtml(who)} · ${timeLabel(r.at)} · ${dayLabel(r.at)}</div>
        <div class="search-result-text">${escapeHtml(r.text)}</div>
      `;
      el.onclick = async () => {
        searchOverlay.classList.remove('active');
        await openChat(r.chatWith);
        setTimeout(() => scrollToMsg(r.at), 300);
      };
      searchResults.appendChild(el);
    });
  }

  // ==================== СОЗДАНИЕ ГРУППЫ ====================
  const selectedMembers = new Set();

  function openNewGroupModal() {
    selectedMembers.clear();
    groupNameInput.value = '';
    renderMembersPicker();
    newGroupModal.classList.add('active');
    setTimeout(() => groupNameInput.focus(), 100);
  }

  function closeNewGroupModal() {
    newGroupModal.classList.remove('active');
  }

  function renderMembersPicker() {
    membersPicker.innerHTML = '';
    if (!state.users.length) {
      membersPicker.innerHTML = '<div class="empty" style="padding:20px;font-size:13px;">Нет других пользователей</div>';
      return;
    }
    state.users.forEach(u => {
      const el = document.createElement('div');
      el.className = 'member-item';
      el.dataset.name = u.name;
      if (selectedMembers.has(u.name)) el.classList.add('selected');

      const avatar = u.avatar
        ? `<img src="${u.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
        : u.name[0].toUpperCase();

      el.innerHTML = `
        <div class="member-check"></div>
        <div class="member-avatar">${avatar}</div>
        <div class="member-name">${escapeHtml(u.name)}</div>
      `;
      el.onclick = () => {
        if (selectedMembers.has(u.name)) selectedMembers.delete(u.name);
        else selectedMembers.add(u.name);
        el.classList.toggle('selected');
      };
      membersPicker.appendChild(el);
    });
  }

  $('newGroupBtn').onclick = openNewGroupModal;
  $('groupCancelBtn').onclick = closeNewGroupModal;

  newGroupModal.onclick = (e) => {
    if (e.target === newGroupModal) closeNewGroupModal();
  };

  $('groupCreateBtn').onclick = () => {
    const name = groupNameInput.value.trim();
    if (!name) { alert('Введи название группы'); return; }
    if (selectedMembers.size === 0) { alert('Выбери хотя бы одного участника'); return; }
    if (!state.socket) return;

    state.socket.emit('createGroup', {
      name,
      members: Array.from(selectedMembers)
    });
    closeNewGroupModal();
  };

  // Выход из группы
  leaveGroupBtn.onclick = () => {
    if (state.currentChatType !== 'group') return;
    if (!confirm('Выйти из группы?')) return;
    if (state.socket) state.socket.emit('leaveGroup', { groupId: state.currentChat });
  };

  // ==================== PUSH-УВЕДОМЛЕНИЯ ====================
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function getVapidKey() {
    const r = await api('/api/vapid-public');
    return r.key;
  }

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('Уведомления не поддерживаются этим браузером');
      return false;
    }

    // Разрешение
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Разрешение на уведомления не выдано');
      return false;
    }

    // Ждём регистрации SW
    const reg = await navigator.serviceWorker.ready;

    // Получим VAPID
    const vapidKey = await getVapidKey();
    if (!vapidKey) { alert('Ошибка: сервер не отдал VAPID'); return false; }

    // Проверим, нет ли уже подписки
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      });
    }

    // Отправим на сервер
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': state.token },
      body: JSON.stringify(sub)
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return false; }

    localStorage.setItem('pushEnabled', '1');
    updateNotifBtn(true);
    return true;
  }

  async function unsubscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { updateNotifBtn(false); return; }

    // Отпишемся на сервере
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': state.token },
      body: JSON.stringify({ endpoint: sub.endpoint })
    });

    // И локально
    await sub.unsubscribe();
    localStorage.removeItem('pushEnabled');
    updateNotifBtn(false);
  }

  function updateNotifBtn(enabled) {
    if (!notifBtn) return;
    notifBtn.textContent = enabled ? '🔕' : '🔔';
    notifBtn.title = enabled ? 'Отключить уведомления' : 'Включить уведомления';
  }

  if (notifBtn) {
    notifBtn.onclick = async () => {
      const enabled = localStorage.getItem('pushEnabled') === '1';
      if (enabled) {
        await unsubscribePush();
        alert('Уведомления отключены');
      } else {
        const ok = await subscribePush();
        if (ok) alert('Уведомления включены! Теперь ты будешь получать push, когда приложение закрыто.');
      }
    };

    // Показать текущее состояние
    updateNotifBtn(localStorage.getItem('pushEnabled') === '1');

    // Если разрешение уже granted и SW готов — переподпишемся на всякий случай
    if (Notification.permission === 'granted' && localStorage.getItem('pushEnabled') === '1') {
      navigator.serviceWorker.ready.then(() => {
        subscribePush().catch(() => {});
      });
    }
  }

  // Клик по push → переход в чат
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat' && e.data.chatWith) {
        if (state.me) openChat(e.data.chatWith);
      }
    });
  }

  // Обработка ?openChat=... в URL
  const urlParams = new URLSearchParams(location.search);
  const openChatParam = urlParams.get('openChat');
  if (openChatParam) {
    // Отложим до авторизации
    const tryOpen = setInterval(() => {
      if (state.me && state.socket) {
        clearInterval(tryOpen);
        openChat(openChatParam);
        history.replaceState({}, '', '/');
      }
    }, 500);
    setTimeout(() => clearInterval(tryOpen), 15000);
  }

  start();
})();