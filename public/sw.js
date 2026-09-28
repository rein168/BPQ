/* eslint-env serviceworker */
// The page registers /sw.js?v=<version>. A new version per deploy means a new
// service worker, a new cache name, and old caches deleted on activate.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE_NAME = 'bbq-' + VERSION;
const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.socket.io/4.5.4/socket.io.min.js'
];
// Pinned third-party files that are safe to serve cache-first
const PINNED_CDN = STATIC_ASSETS.filter((u) => u.startsWith('https://'));

// Install: cache static assets. Same-origin files must succeed; CDN files are
// best-effort, since one unreachable CDN would otherwise fail the whole install
// and leave the app with no service worker at all.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all([
        cache.addAll(STATIC_ASSETS.filter((u) => !PINNED_CDN.includes(u))),
        ...PINNED_CDN.map((u) => cache.add(u).catch((err) => console.warn('SW precache skipped', u, err))),
      ]))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Cross-origin: only the pinned CDN files, cache-first. Everything else
  // (analytics pixels, Sentry, OneSignal) goes straight to the network and
  // never fills the cache.
  if (url.origin !== self.location.origin) {
    if (PINNED_CDN.includes(request.url)) {
      event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    }
    return;
  }

  // Live traffic and other service workers' files: never cache
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/push/')) return;

  // API requests: network-first, no cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => new Response(
          JSON.stringify({ error: 'You are offline' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // HTML pages: network-first with offline fallback
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate. Serve the cached copy
  // for speed, refresh it in the background so the next load is current.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
