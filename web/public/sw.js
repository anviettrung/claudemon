// Service worker của SessionMon: cài PWA, nhận thông báo đẩy và hiện thông báo; không cache gì, luôn đi mạng.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Thông báo đẩy từ agent (src/push.ts): session xong lượt hoặc cần duyệt. iOS bắt buộc hiện thông báo cho mỗi lần đẩy.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'SessionMon', {
      body: d.body || '',
      tag: d.tag,
      renotify: !!d.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: d.url || '/' },
    }),
  );
});

// Bấm thông báo: đưa cửa sổ SessionMon đang có lên và mở đúng session, không có thì mở mới.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (!('focus' in c)) continue;
        c.postMessage({ type: 'open', url });
        return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
