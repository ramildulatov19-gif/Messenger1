const CACHE = 'messenger-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ==================== PUSH-УВЕДОМЛЕНИЯ ====================
self.addEventListener('push', (event) => {
  let data = { title: 'Новое сообщение', body: '' };
  try {
    data = event.data ? event.data.json() : data;
  } catch (_) {}

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'msg',
    data: {
      from: data.from || '',
      chatWith: data.chatWith || ''
    },
    vibrate: [100, 50, 100],
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Мессенджер', options)
  );
});

// Клик по уведомлению — открыть приложение и нужный чат
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatWith = event.notification.data && event.notification.data.chatWith;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Если уже открыто — фокус и перейти в чат
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.focus();
          c.postMessage({ type: 'open-chat', chatWith });
          return;
        }
      }
      // Иначе открыть новое окно
      if (clients.openWindow) {
        return clients.openWindow('/?openChat=' + encodeURIComponent(chatWith || ''));
      }
    })
  );
});