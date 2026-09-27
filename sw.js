/**
 * Roy's Digital Library — Service Worker v3.9.1
 * Network-first for JS/CSS so users are not stuck on old bundles.
 * Cache shell for offline. Never cache authenticated API responses
 * (Supabase requests are cross-origin and not matched here).
 */
const CACHE = 'roys-v391';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon.png',
  './logo.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only same-origin GET
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first for scripts and styles (avoid stale app logic)
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.includes('/src/');
  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for shell/static
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
