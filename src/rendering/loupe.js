// Touch loupe. FABLE owns.
//
// On phones the finger hides exactly the spot where a beam is about to land.
// While a single-touch build gesture is active, this draws a small magnified
// circle OFFSET from the finger, showing the already-rendered frame around the
// (snapped) pointer — ghost, snap rings, members and all. It is a plain blit
// of the current canvas, not a re-render, so it is visually always consistent
// with the frame and costs one small drawImage.
//
// Mouse and pen never see it (the cursor doesn't occlude anything), and it
// only exists in the build phase. Placement prefers above the finger, falls
// back to beside it near the top edge, and always stays fully on screen.

import { CONFIG } from '../config.js';
import { on } from '../core/events.js';
import { getBuilder } from '../build/builder.js';

const L = { active: false, px: 0, py: 0 };
let cache = null, cacheSize = 0;

export function stats() { return L; }

export function init() {
  on('input:down', (p) => {
    if (p.ptype === 'touch' && p.button === 0) { L.active = true; L.px = p.px; L.py = p.py; }
  });
  on('input:move', (p) => {
    if (!L.active || p.hover) return;
    L.px = p.px; L.py = p.py;
  });
  on('input:up', () => { L.active = false; });
  on('phase:change', () => { L.active = false; });
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function render(ctx, S) {
  if (!L.active || S.phase !== 'build') return;
  const R = CONFIG.loupe;
  const canvas = ctx.canvas;
  const cw = canvas.clientWidth;
  const d = cw > 0 ? canvas.width / cw : 1;
  const dpr = d > 0.1 && d < 8 ? d : 1;

  const rad = R.radiusPx * dpr;
  const srcR = rad / R.zoom;

  // source region, clamped fully onto the canvas so the blit never samples void
  const sx = clamp(L.px, srcR, canvas.width - srcR);
  const sy = clamp(L.py, srcR, canvas.height - srcR);

  // loupe placement: above the finger; beside it when the top is too close
  const off = R.offsetPx * dpr;
  const margin = 4 * dpr;
  let cx = L.px;
  let cy = L.py - off;
  if (cy - rad < R.topClearancePx * dpr) {
    cy = L.py;
    cx = L.px - off;
    if (cx - rad < margin) cx = L.px + off;
  }
  cx = clamp(cx, rad + margin, canvas.width - rad - margin);
  cy = clamp(cy, rad + margin, canvas.height - rad - margin);

  // grab the region BEFORE drawing the loupe (never sample our own circle)
  const need = Math.ceil(srcR * 2);
  if (!cache || cacheSize < need) {
    cache = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(need, need)
      : Object.assign(document.createElement('canvas'), { width: need, height: need });
    cache.width = need; cache.height = need;
    cacheSize = need;
  }
  const g = cache.getContext('2d');
  g.clearRect(0, 0, need, need);
  g.drawImage(canvas, sx - srcR, sy - srcR, srcR * 2, srcR * 2, 0, 0, need, need);

  // ring color tells validity at a glance: ghost ok/bad, neutral otherwise
  const B = getBuilder();
  const ring = B.ghost ? (B.ghost.ok ? R.ringOk : R.ringBad)
    : (B.tool === 'erase' || B.tool === 'boxdelete') ? R.ringBad : R.ringNeutral;

  ctx.save();
  // drop ring for contrast against any backdrop
  ctx.beginPath();
  ctx.arc(cx, cy, rad + R.ringPx * dpr, 0, Math.PI * 2);
  ctx.fillStyle = R.backing;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cache, 0, 0, need, need, cx - rad, cy - rad, rad * 2, rad * 2);

  // crosshair at the pointer's true position inside the magnified region
  const tx = cx + (L.px - sx) * R.zoom;
  const ty = cy + (L.py - sy) * R.zoom;
  const ch = R.crossPx * dpr;
  ctx.strokeStyle = R.cross;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(tx - ch, ty); ctx.lineTo(tx - ch * 0.35, ty);
  ctx.moveTo(tx + ch * 0.35, ty); ctx.lineTo(tx + ch, ty);
  ctx.moveTo(tx, ty - ch); ctx.lineTo(tx, ty - ch * 0.35);
  ctx.moveTo(tx, ty + ch * 0.35); ctx.lineTo(tx, ty + ch);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.strokeStyle = ring;
  ctx.lineWidth = R.ringPx * dpr;
  ctx.stroke();
}
