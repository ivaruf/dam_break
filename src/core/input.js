// Unified mouse/touch/keyboard input. FABLE owns.
// Emits (see ARCHITECTURE.md §6):
//   input:down/move/up {x, y, px, py, id, button, cancel}
//   input:pan {dx, dy}   (screen px)
//   input:zoom {px, py, factor}
//   input:key {key, code}
// Single pointer → down/move/up (builder decides meaning).
// Two-finger touch → pan + pinch zoom. Middle-mouse drag → pan. Wheel → zoom.

import { emit } from './events.js';

export function initInput(canvas, camera) {
  const pointers = new Map(); // pointerId -> {px, py, button}
  let gesture = null;         // 'single' | 'pinch' | 'midpan'

  function world(px, py) {
    const [x, y] = camera.screenToWorld(px, py);
    return { x, y, px, py };
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (canvas.width / r.width),
      (e.clientY - r.top) * (canvas.height / r.height),
    ];
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = pos(e);
    pointers.set(e.pointerId, { px, py, button: e.button });

    if (pointers.size === 2) {
      // second finger: cancel any in-progress build gesture, start pinch
      if (gesture === 'single') {
        const p = world(px, py);
        emit('input:up', { ...p, id: e.pointerId, button: 0, cancel: true });
      }
      gesture = 'pinch';
    } else if (pointers.size === 1) {
      if (e.button === 1) {
        gesture = 'midpan';
      } else {
        gesture = 'single';
        emit('input:down', { ...world(px, py), id: e.pointerId, button: e.button, cancel: false });
      }
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const rec = pointers.get(e.pointerId);
    const [px, py] = pos(e);

    if (!rec) { // hover
      emit('input:move', { ...world(px, py), id: e.pointerId, button: -1, cancel: false, hover: true });
      return;
    }

    if (gesture === 'pinch' && pointers.size === 2) {
      const ids = [...pointers.keys()];
      const other = pointers.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
      const beforeMidX = (rec.px + other.px) / 2, beforeMidY = (rec.py + other.py) / 2;
      const beforeDist = Math.hypot(rec.px - other.px, rec.py - other.py) || 1;
      rec.px = px; rec.py = py;
      const midX = (rec.px + other.px) / 2, midY = (rec.py + other.py) / 2;
      const dist = Math.hypot(rec.px - other.px, rec.py - other.py) || 1;
      emit('input:pan', { dx: midX - beforeMidX, dy: midY - beforeMidY });
      const f = dist / beforeDist;
      if (Math.abs(f - 1) > 0.002) emit('input:zoom', { px: midX, py: midY, factor: f });
      return;
    }

    if (gesture === 'midpan') {
      emit('input:pan', { dx: px - rec.px, dy: py - rec.py });
      rec.px = px; rec.py = py;
      return;
    }

    rec.px = px; rec.py = py;
    if (gesture === 'single') {
      emit('input:move', { ...world(px, py), id: e.pointerId, button: rec.button, cancel: false, hover: false });
    }
  });

  function release(e, cancel) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    pointers.delete(e.pointerId);
    const [px, py] = pos(e);
    if (gesture === 'single') {
      emit('input:up', { ...world(px, py), id: e.pointerId, button: rec.button, cancel });
    }
    gesture = pointers.size >= 2 ? 'pinch' : pointers.size === 1 ? gesture : null;
    if (pointers.size === 0) gesture = null;
  }

  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));

  canvas.addEventListener('wheel', (e) => {
    const [px, py] = pos(e);
    emit('input:zoom', { px, py, factor: Math.exp(-e.deltaY * 0.0012) });
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    emit('input:key', { key: e.key, code: e.code });
    if (e.key === ' ') e.preventDefault();
  });
}
