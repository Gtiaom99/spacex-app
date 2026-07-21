const CACHE = 'spcx-v9';
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
  if (url.hostname.includes('finnhub.io') || url.hostname.includes('stooq.com') ||
      url.hostname.includes('alphavantage.co') || url.hostname.includes('thespacedevs.com')) {
    return; // default network handling
  }

  // App shell (our own files): network-first so code/date updates reach the
  // user, but only trust a genuinely OK response. If the site is ever taken
  // down (e.g. repo made private -> GitHub returns 404), we must NOT cache or
  // serve that error page — fall back to the good cached copy instead. This
  // lets an installed app keep working from cache even after the site is gone.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (!res || !res.ok) {
          // 404/5xx: prefer the cached copy; only surface the error if none.
          return caches.match(e.request).then((hit) => hit || res);
        }
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)) // true network failure -> cache
  );
});
