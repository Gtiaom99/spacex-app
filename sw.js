const CACHE = 'spcx-v5';
const ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'chart.js',
  'manifest.json',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Live data APIs: always network, never cache.
  if (url.hostname.includes('finnhub.io') || url.hostname.includes('stooq.com') || url.hostname.includes('thespacedevs.com')) {
    return; // default network handling
  }

  // App shell (our own files): network-first so code/date updates always
  // reach the user, with cache fallback for offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
