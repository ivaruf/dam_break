// Boot: canvas sizing, RAF loop, service-worker registration. FABLE owns.

import * as game from './core/game.js';
import { emit } from './core/events.js';

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

function loop(now) {
  resize();
  game.frame(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Console debugging handle (not a public API).
window.DAM = { game, emit };

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

function offerIfWaiting() {
  if (!swReg || !swReg.waiting || !navigator.serviceWorker.controller) return;
  swVersion(swReg.waiting).then((v) => {
    const btn = document.getElementById('btn-update');
    if (!btn) return;
    btn.classList.remove('hidden');
    btn.textContent = `⬆ UPDATE READY${v ? ' — ' + v : ''}`;
    btn.onclick = () => swReg.waiting && swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
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
    if (hadController && game.getScene().phase === 'title') location.reload();
  });
}
