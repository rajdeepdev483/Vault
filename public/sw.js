// Vault service worker
// Caches only the static app shell so the app opens instantly and can show
// a friendly offline screen. It NEVER caches anything under /api — money
// data must always come fresh from the server.
const CACHE_NAME = 'vault-shell-v6';
const SHELL_FILES = [
  '/',
  '/css/styles.css',
  '/js/api.js',
  '/js/ui.js',
  '/js/modal.js',
  '/js/auth.js',
  '/js/dashboard.js',
  '/js/loan.js',
  '/js/borrowers.js',
  '/js/loans.js',
  '/js/reminders.js',
  '/js/settings.js',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch API calls — always go to the network, never cache.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET') return;

  // Network-first: always try the server so design/code updates show up
  // immediately; fall back to the saved copy only when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});