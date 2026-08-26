// Touch loupe + aim cursor. FABLE owns.
//
// On phones the finger hides exactly the spot where a beam is about to land.
// Touch aiming v2 (see builder.js) answers that by moving the ACTIVE POINT off
// the fingertip: during a touch build gesture the "cursor" floats
// CONFIG.touch.cursorOffsetPx above the finger and everything snaps to it. This
// module draws the two things that make that legible:
//
//   1. the CURSOR itself — a crosshair plus a snap-kind ring, on the main
//      canvas, at builder.touchAim; and
//   2. the LOUPE — a small magnified circle showing the already-rendered frame
//      around the CURSOR (ghost, snap rings, members and all), offset so it
//      never sits under the hand.
//
// The loupe is a plain blit of the current canvas, not a re-render, so it is
// visually always consistent with the frame and costs one small drawImage.
// The cursor marker is drawn AFTER the region is grabbed, so the loupe shows
// the frame rather than a magnified picture of its own crosshair.
//
// When there is no aim cursor — the erase and box-delete tools deliberately
// stay on the raw fingertip — the loupe falls back to the finger position and
// no cursor marker is drawn. Mouse and pen never see any of it (the pointer
// occludes nothing), and it only exists in the build phase. Placement prefers
// above the cursor, falls back to beside it near the top edge, and always
// stays fully on screen.

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

  // the builder's offset aim cursor when there is one, else the fingertip
  const B = getBuilder();
  const aim = (B && B.touchAim) || null;
  const fx = aim ? aim.px : L.px;
  const fy = aim ? aim.py : L.py;

  const rad = R.radiusPx * dpr;
  const srcR = rad / R.zoom;

  // source region, clamped fully onto the canvas so the blit never samples void
  const sx = clamp(fx, srcR, canvas.width - srcR);
  const sy = clamp(fy, srcR, canvas.height - srcR);

  // loupe placement: above the cursor; beside it when the top is too close
  const off = R.offsetPx * dpr;
  const margin = 4 * dpr;
  let cx = fx;
  let cy = fy - off;
  if (cy - rad < R.topClearancePx * dpr) {
    cy = fy;
    cx = fx - off;
    if (cx - rad < margin) cx = fx + off;
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

  // ring color tells validity at a glance: ghost ok/bad, neutral otherwise —
  // and while the gesture is still AIMING there is no ghost yet, so the cursor
  // and the loupe both read neutral until the beam has a direction
  const ring = B && B.ghost ? (B.ghost.ok ? R.ringOk : R.ringBad)
    : (B && (B.tool === 'erase' || B.tool === 'boxdelete')) ? R.ringBad : R.ringNeutral;

  // the aim cursor, on the frame itself (after the grab: see the header)
  if (aim) drawCursor(ctx, aim, dpr, ring);

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

  // crosshair at the cursor's true position inside the magnified region
  const tx = cx + (fx - sx) * R.zoom;
  const ty = cy + (fy - sy) * R.zoom;
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

// The aim cursor: a gapped crosshair on the exact point, inside a ring whose
// RADIUS is the snap kind (node > anchor > grid dot) and whose COLOUR is the
// loupe's validity family. Small on purpose — the loupe is the magnifier, this
// is just the truthful marker of where the beam lands.
function drawCursor(ctx, aim, dpr, color) {
  const R = CONFIG.loupe;
  const rings = R.cursorRingPx;
  const r = ((rings && rings[aim.kind]) || (rings && rings.grid) || 6) * dpr;
  const arm = R.cursorCrossPx * dpr;
  const gap = R.cursorGapPx * dpr;

  ctx.save();
  ctx.globalAlpha = R.cursorAlpha;

  ctx.beginPath();
  ctx.arc(aim.px, aim.py, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, R.cursorRingLinePx * dpr);
  ctx.stroke();

  ctx.strokeStyle = R.cross;
  ctx.lineWidth = Math.max(1, R.cursorLinePx * dpr);
  ctx.beginPath();
  ctx.moveTo(aim.px - arm, aim.py); ctx.lineTo(aim.px - gap, aim.py);
  ctx.moveTo(aim.px + gap, aim.py); ctx.lineTo(aim.px + arm, aim.py);
  ctx.moveTo(aim.px, aim.py - arm); ctx.lineTo(aim.px, aim.py - gap);
  ctx.moveTo(aim.px, aim.py + gap); ctx.lineTo(aim.px, aim.py + arm);
  ctx.stroke();
  ctx.restore();
}
