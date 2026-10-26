// Service worker: cache the app shell so it opens from the home screen even
// with a poor signal. Never caches API calls or anything with client data —
// those go straight to the network.
const CACHE = 'bookings-shell-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/book.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase etc.: always live

  // Pages: network first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only a good, same-site page becomes the offline copy — never an error page.
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('/index.html', copy)));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Built files have content hashes in their names, so cached copies never go stale.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })),
    );
  }
});
