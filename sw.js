/* TF2 Voice Emulator — service worker.
 * The app shell is precached so the tool still loads offline / as an installed
 * PWA. Cache strategy is split by request type:
 *
 *   - Code & markup (document / script / style): NETWORK-FIRST, cache fallback.
 *     These change on every edit, so a normal reload always fetches the latest
 *     when online — no hard refresh needed. The cache is used only when the
 *     network fails (offline), and each successful fetch refreshes that copy.
 *
 *   - Everything else (icons, manifest, favicon): CACHE-FIRST for speed. These
 *     rarely change; when they do, bump CACHE below to evict the old generation.
 */

const CACHE_PREFIX = 'tf2ve-';
const CACHE = `${CACHE_PREFIX}v9`;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './constants.js',
  './audio.js',
  './audio-worker.js',
  './opus-codec.mjs',
  './vendor/libopus/index.mjs',
  './vendor/libopus/generated/libopus.generated.mjs',
  './mic-capture.js',
  './script.js',
  './favicon.ico',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Best-effort: stash a fresh same-origin response so the offline copy stays current.
function cachePut(request, response) {
  try {
    if (response && response.ok && new URL(request.url).origin === location.origin) {
      const copy = response.clone();
      return caches.open(CACHE).then((c) => c.put(request, copy));
    }
  } catch (err) { /* opaque / cross-origin — skip caching */ }
  return Promise.resolve();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Code & markup: try the network first so plain reloads reflect the latest
  // edit; fall back to the cached copy (or the app shell) only when offline.
  const isLive = req.mode === 'navigate' ||
                 req.destination === 'document' ||
                 req.destination === 'script' ||
                 req.destination === 'style';

  if (isLive) {
    e.respondWith(
      fetch(req)
        .then(async (resp) => { await cachePut(req, resp); return resp; })
        .catch(() => caches.match(req).then((hit) => {
          if (hit) return hit;
          return req.mode === 'navigate' ? caches.match('./index.html') : Response.error();
        }))
    );
    return;
  }

  // Static assets: cache-first for speed, populate the cache on first miss.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then(async (resp) => {
      await cachePut(req, resp);
      return resp;
    }))
  );
});
