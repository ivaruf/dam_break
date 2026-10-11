// Boot: canvas sizing, RAF loop, service-worker registration. FABLE owns.

import * as game from './core/game.js';
import { emit } from './core/events.js';
import { t } from './i18n.js';
import * as audio from './ui/audio.js';

const canvas = document.getElementById('game');

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener('resize', resize);
resize();

game.boot(canvas);
// After boot, so the mixer's listeners sit behind the game's own. It builds
// nothing until the first gesture; see src/ui/audio.js.
audio.init();

function loop(now) {
  resize();
  game.frame(now);
  audio.frame();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Console debugging handle (not a public API).
window.DAM = { game, emit, audio };

// ---- service worker: versioned precache with opt-in updates (maxgear model)

function swVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && e.data.version); };
    try { worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]); } catch { resolve(null); }
  });
}

let swReg = null;
let waitingVersion = undefined;   // undefined: nothing offered yet
let updateAccepted = false;       // the player tapped NY VERSJON KLAR

// The button's words in the current language, with the waiting build's tag.
// Called again on every language switch, so an offer already on screen follows.
function paintUpdate() {
  const btn = document.getElementById('btn-update');
  if (!btn || waitingVersion === undefined) return;
  btn.textContent = t('update.ready') + (waitingVersion ? ' — ' + waitingVersion : '');
}
document.addEventListener('arcade:lang', paintUpdate);

function offerIfWaiting() {
  if (!swReg || !swReg.waiting || !navigator.serviceWorker.controller) return;
  swVersion(swReg.waiting).then((v) => {
    const btn = document.getElementById('btn-update');
    if (!btn) return;
    btn.classList.remove('hidden');
    waitingVersion = v || null;
    paintUpdate();
    btn.onclick = () => {
      if (!swReg.waiting) { location.reload(); return; }
      updateAccepted = true;
      swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // controllerchange is the normal way in, but it never comes after a hard
      // refresh (the page is uncontrolled) or if the waiting worker has gone
      // redundant, and then the button would sit there doing nothing — read
      // as "the update is broken". maxgear/js/main.js does the same.
      setTimeout(() => location.reload(), 3000);
    };
  });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        swReg = reg;
        reg.update().catch(() => {});
        offerIfWaiting();
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offerIfWaiting(); });
        });
      })
      .catch(() => { /* offline or unsupported: game runs fine without it */ });

    swVersion(navigator.serviceWorker.controller).then((v) => {
      const tag = document.getElementById('game-version');
      if (v && tag) { tag.textContent = v; return; }
      fetch('sw.js').then((r) => r.text()).then((t) => {
        const m = t.match(/VERSION = '([^']+)'/);
        if (m && tag) tag.textContent = m[1];
      }).catch(() => {});
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A tap on the update button is a request to reload whatever screen it
    // was tapped on; otherwise only reload on the title, never mid-run (§1).
    if (updateAccepted || (hadController && game.getScene().phase === 'title')) location.reload();
  });
}
