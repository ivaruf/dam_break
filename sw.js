// DAM BREAK service worker: versioned precache for offline play + install.
// Same opt-in update model as maxgear: bump VERSION on every deploy; the new
// worker precaches in the background and WAITS until the player taps the
// "UPDATE READY" button on the title screen (main.js sends SKIP_WAITING).
// All paths RELATIVE so the app works from a GitHub Pages subpath.

const VERSION = 'v2.11.1'; // the exit-fullscreen glyph is symmetric again — its bottom-left arm pointed the wrong way
const CACHE = `dambreak-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  // Has to be IN the cache, not merely deployed: the players this rescues
  // are the ones whose browser has stopped asking this origin for anything.
  './moved.js',
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
  './src/physics/fluid.js',
  './src/build/builder.js',
  './src/build/snapping.js',
  './src/build/materials.js',
  './src/build/modes.js',
  './src/rendering/renderer.js',
  './src/rendering/waterRenderer.js',
  './src/rendering/effects.js',
  './src/ui/hud.js',
  './src/ui/titleScene.js',
  './src/ui/screens.js',
  './src/ui/sound.js',
  // Loaded by index.html as its OWN module script rather than imported by
  // main.js, so it has to be listed here in its own right — nothing else
  // would ever pull it into the cache.
  './src/ui/screen.js',
  './src/ui/debug.js',
  './src/levels/levels.js',
  './src/levels/levelLoader.js',
  './icons/icon-180.png',
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
        keys.filter((k) => (k.startsWith('dambreak-') || k.startsWith('dambuilder-')) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // `cacheName: CACHE` IS LOAD-BEARING AND WAS MISSING. A bare caches.match()
  // searches EVERY cache on the origin, and every game in this hub shares one —
  // so this was free to answer out of the arcade's cache or a sibling game's,
  // and it did: ../arcade/exit.js is precached by the ARCADE, so the copy this
  // game got came from a store no VERSION bump here could ever refresh. That is
  // the same mistake as a sloppy cleanup filter, from the other end: the slug is
  // on the cache name and then nothing asks for it. Scoped to our own cache, a
  // miss falls through to the network below and the answer is at worst fresh.
  event.respondWith(
    caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => (request.mode === 'navigate'
        // Scoped for the same reason: offline, the shell we fall back to must
        // be OUR shell and not whichever game on this origin happens to hold an
        // './index.html' of its own.
        ? caches.match('./index.html', { cacheName: CACHE })
        : undefined));
    })
  );
});
