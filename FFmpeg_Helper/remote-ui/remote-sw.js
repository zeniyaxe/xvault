const CACHE = 'xvault-remote-shell-v8';
const SHELL = [
  '/',
  '/index.html',
  '/remote.css',
  '/remote-font.woff2',
  '/remote.js',
  '/remote-drafts.js',
  '/remote-capture.js',
  '/remote-sw.js',
  '/manifest.webmanifest',
  '/app-icon.svg',
  '/app-icon-192.png',
  '/app-icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys.filter(key => key.startsWith('xvault-remote-') && key !== CACHE).map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Never cache searches, device sessions, grants, or media bytes.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // The share target (/share?url=…) is the app shell too; offline it still opens so the link waits in the outbox.
  const shared = request.mode === 'navigate' && /^\/share\/?$/.test(url.pathname);
  if (!SHELL.includes(url.pathname) && !shared) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && !shared) caches.open(CACHE).then(cache => cache.put('/', response.clone()));
          return response;
        })
        .catch(async () => (await caches.match('/')) || Response.error())
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(cached => {
      const update = fetch(request).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        return response;
      });
      if (cached) {
        event.waitUntil(update.catch(() => {}));
        return cached;
      }
      return update;
    })
  );
});
