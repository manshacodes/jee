/* Service worker: delivers push alerts and focuses the app when one is tapped. */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'lurk :p', body: event.data?.text() || 'Something just dropped' };
  }

  const title = payload.title || 'lurk :p';
  const options = {
    body: payload.body || 'Something just dropped on the boards.',
    // One tag means a burst of notices collapses into a single alert rather
    // than stacking a dozen of them on the lock screen.
    tag: payload.tag || 'lurk',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge.png',
    data: { url: payload.url || '/', categories: payload.categories || [] },
    actions: [{ action: 'open', title: 'Open' }],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer an already-open tab of the app.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          client.postMessage({ type: 'refresh' });
          await client.focus();
          if (target.startsWith('http')) await self.clients.openWindow(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
