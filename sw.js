// Network first, cache fallback: the app keeps opening in the field without reception.
const CACHE = 'field-reports-v28';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'i18n.js', 'app.js', 'icon.svg', 'login.jpg', 'manifest.webmanifest', 'breeding/', 'breeding/breeding.js', 'breeding/icon-192.png', 'breeding/icon-512.png', 'breeding/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
