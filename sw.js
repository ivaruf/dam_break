// DAM BUILDER service worker: versioned precache for offline play + install.
// Same opt-in update model as maxgear: bump VERSION on every deploy; the new
// worker precaches in the background and WAITS until the player taps the
// "UPDATE READY" button on the title screen (main.js sends SKIP_WAITING).
// All paths RELATIVE so the app works from a GitHub Pages subpath.

const VERSION = 'v1.1.0'; // water realism: nappe sheets, breach jets, readable submerged dam
const CACHE = `dambuilder-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './src/main.js',
  './src/config.js',
  './src/core/game.js',
  './src/core/state.js',
  './src/core/events.js',
  './src/core/terrain.js',
  './src/core/camera.js',
  './src/core/input.js',
  './src/physics/structures.js',
  './src/physics/constraints.js',
  './src/physics/stress.js',
  './src/physics/water.js',
  './src/physics/coupling.js',
  './src/build/builder.js',
  './src/build/snapping.js',
  './src/build/materials.js',
  './src/build/modes.js',
  './src/rendering/renderer.js',
  './src/rendering/waterRenderer.js',
  './src/rendering/effects.js',
  './src/ui/hud.js',
  './src/ui/screens.js',
  './src/ui/debug.js',
  './src/levels/levels.js',
  './src/levels/levelLoader.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('dambuilder-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
    })
  );
});
