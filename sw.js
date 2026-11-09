/* Tourwetter Service Worker: App-Dateien offline, Wetterdaten immer frisch */
const CACHE = 'tourwetter-v36';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'version.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Open-Meteo direkt aus dem Netz

  // Erst Netz (max. 3 s), dann Cache: online immer der aktuelle Stand, offline der zuletzt geladene
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const network = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
      const timeout = new Promise(resolve => setTimeout(resolve, 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch (e) { /* offline */ }
      const cached = await cache.match(req, { ignoreSearch: true });
      return cached || network;
    })
  );
});
