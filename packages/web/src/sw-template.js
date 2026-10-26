// The offline app shell. The build fills in the version and the file list.
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `chess-coach-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chess-coach-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The desktop's API is never cached: offline it fails and the app says so.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/__verify')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/', { cacheName: CACHE })));
    return;
  }
  const response = caches.match(event.request, { cacheName: CACHE }).then((hit) => hit ?? fetch(event.request));
  // A worker takes its location from the response's URL. Stockfish's thread workers load the
  // Engine script with a fragment that tells them they are threads, and a cached or fetched
  // response's URL has lost it: each thread would then start a whole new Engine, without end.
  // A fresh Response has no URL, so the worker keeps the one it asked for, fragment included.
  if (event.request.destination === 'worker' || url.pathname.startsWith('/engine/')) {
    event.respondWith(response.then((r) => new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers })));
    return;
  }
  event.respondWith(response);
});
