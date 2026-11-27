/* POS System service worker — enables install + offline use.
   Navigation (index.html) is network-first so updates appear on the next
   open when online, with the cached copy as the offline fallback.
   Static assets are cache-first. Only same-origin GETs are handled;
   Supabase API calls pass through untouched. Bump CACHE on SW changes.
   Split build (1.0.6): caches every file of the multi-file project, so an
   offline open still gets the whole app, not just the shell. */
const CACHE = 'pos-system-v2';
const ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'database.js',
  'auth.js',
  'sync.js',
  'sales.js',
  'inventory.js',
  'reports.js',
  'settings.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('index.html', copy));
          return response;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
    )
  );
});
