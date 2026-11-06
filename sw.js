// Application disponible hors connexion, et derniers articles lus consultables sans réseau.
const VERSION = 'wikitel-v1';
const ARTICLES = 'wikitel-articles-v1';
const ARTICLE_LIMIT = 30;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css', 'data/types.json', 'assets/vt323.woff2', 'assets/icon.svg', 'assets/icon-192.png',
  'js/app.js', 'js/api.js', 'js/article.js', 'js/hikes.js', 'js/places.js', 'js/speech.js', 'js/store.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![VERSION, ARTICLES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Réseau d'abord, en revalidant auprès du serveur : sans `no-cache`, le navigateur garderait
    // l'ancienne version jusqu'à 10 minutes (durée imposée par GitHub Pages).
    event.respondWith(fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) { const copy = response.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })));
    return;
  }

  if (url.hostname.endsWith('.wikipedia.org') && url.pathname.includes('/rest_v1/page/html/')) {
    event.respondWith(fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(ARTICLES);
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - ARTICLE_LIMIT)).map((k) => cache.delete(k)));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? Response.error())));
  }
});
