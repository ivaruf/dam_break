// OPUS C owns. F2 debug overlay: FPS, counts, stress numbers, blocked
// intervals, velocity vectors. Contract §9. Strictly read-only over the scene.
//
// render() is called every frame even when the overlay is off (that is where the
// FPS counter lives), so the disabled path must stay near-free: one timestamp
// and an early return.

import { CONFIG } from '../config.js';
import { on } from '../core/events.js';
import * as effects from '../rendering/effects.js';
import { FLUID } from '../physics/fluid.js';

const R = CONFIG.render;
const TAU = Math.PI * 2;

let enabled = CONFIG.debug.enabled;
let frames = 0, fps = 0, last = 0, worst = 0, frameStart = 0;
let hoverX = 0, hoverY = 0, haveHover = false;

let W = 0, H = 0, cx = 0, cy = 0;
let camX = 0, camY = 0, zoom = 1, shX = 0, shY = 0, dpr = 1;

const SX = (x) => (x - camX) * zoom + cx + shX;
const SY = (y) => cy - (y - camY) * zoom + shY;

// ---- water v2 debug layers: particles → particles+pressure → pressure → none,
// cycled with 'p'/'P' while the overlay is up (config.js render §"water v2
// debug layers"). Kept as small ints rather than strings so the hot draw
// functions below can gate with a plain integer compare.
const LAYER_PARTICLES = 0;
const LAYER_BOTH = 1;
const LAYER_PRESSURE = 2;
const LAYER_NONE = 3;
const LAYER_NAMES = ['particles', 'particles+pressure', 'pressure', 'none'];
const LAYER_COUNT = LAYER_NONE + 1;
let layer = LAYER_PARTICLES;
// Max |pressure| over the visible fluid this frame; 0 whenever the pressure
// layer is off. The panel line reads it.
let lastMaxP = 0;

// F2 itself is handled by game.js, which calls toggle() for us.
export function init() {
  on('input:move', (p) => { hoverX = p.x; hoverY = p.y; haveHover = true; });
  // P only means something while the overlay is up, so the key stays free for
  // anything else the rest of the time. The handler never swallows the event —
  // every other 'input:key' listener still runs.
  on('input:key', ({ key }) => {
    if (!enabled) return;
    if (key !== 'p' && key !== 'P') return;
    layer = (layer + 1) % LAYER_COUNT;
  });
}

export function toggle() {
  enabled = !enabled;
  worst = 0;
  if (enabled) layer = LAYER_PARTICLES;       // default view every time it comes up
  return enabled;
}

export function isEnabled() { return enabled; }

export function render(ctx, cam, S) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  frames++;
  if (frameStart > 0) {
    const ms = now - frameStart;
    if (ms > worst) worst = ms;
  }
  frameStart = now;
  if (now - last > 500) {
    fps = Math.round((frames * 1000) / (now - last));
    frames = 0; last = now;
  }
  if (!enabled || !S) return;

  W = ctx.canvas.width; H = ctx.canvas.height;
  cx = W * 0.5; cy = H * 0.5;
  camX = cam.x; camY = cam.y; zoom = cam.zoom;
  shX = cam.shakeX || 0; shY = cam.shakeY || 0;
  const cw = ctx.canvas.clientWidth;
  const d = cw > 0 ? W / cw : 1;
  dpr = d > 0.1 && d < 8 ? d : 1;

  ctx.save();
  ctx.font = Math.round(R.dbgFontPx * dpr) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';

  // pressure heat goes down FIRST: it is a filled background layer and must sit
  // under the blocked bars / velocity arrows / structure vectors / panel or
  // those stop being readable (see drawPressureLayer).
  drawPressureLayer(ctx, S.water);
  drawWaterDebug(ctx, S.water);
  drawStructureDebug(ctx, S.structure);
  drawParticleLayer(ctx, S.water);
  drawPanel(ctx, S);

  ctx.restore();
}

// ---- text panel ---------------------------------------------------------

function drawPanel(ctx, S) {
  const lines = [];
  lines.push('fps ' + fps + '  worst ' + worst.toFixed(1) + 'ms  phase ' + S.phase +
    '  t ' + (S.simTime || 0).toFixed(2) + '  x' + S.simSpeed);

  const st = S.structure;
  if (st) {
    lines.push('struct  nodes ' + st.nodes.length + '  members ' + st.members.length +
      '  broken ' + st.brokenCount + '  debris ' + (st.debris ? st.debris.length : 0) +
      '  maxLoad ' + (st.maxLoad || 0).toFixed(3));
    if (st.firstFailure) {
      const f = st.firstFailure;
      lines.push('firstFail ' + f.memberId + ' ' + f.mode + ' @' + f.time.toFixed(2) +
        's (' + f.x.toFixed(1) + ',' + f.y.toFixed(1) + ')');
    }
  } else {
    lines.push('struct  (design: ' + (S.design ? S.design.nodes.length : 0) + ' nodes / ' +
      (S.design ? S.design.members.length : 0) + ' members)');
  }

  const w = S.water;
  if (w) {
    let vol = 0, maxV = 0, sealedCount = 0, wetCells = 0;
    for (let i = 0; i < w.n; i++) {
      vol += w.depth[i];
      if (w.depth[i] > w.cfg.minDepth) wetCells++;
    }
    for (let b = 0; b <= w.n; b++) {
      const v = Math.abs(w.vel[b]);
      if (v > maxV) maxV = v;
      if (w.blocked[b] && w.blocked[b].length) sealedCount++;
    }
    lines.push('water   cells ' + w.n + '  wet ' + wetCells + '  vol ' + (vol * w.cellW).toFixed(2) +
      'm2  in ' + (w.stats.totalIn || 0).toFixed(2) + '  maxVel ' + maxV.toFixed(2) +
      '  sealedB ' + sealedCount);
    if (haveHover) lines.push(hoverLine(w));
    if (R.dbgLayerLabel) lines.push(layerLine(w));
  }

  const pc = typeof effects.count === 'function' ? effects.count() : -1;
  lines.push('fx      particles ' + (pc >= 0 ? pc + '/' + R.maxParticles : 'n/a') +
    '  shake ' + (Math.abs(shX) + Math.abs(shY)).toFixed(2) +
    '  cam ' + camX.toFixed(1) + ',' + camY.toFixed(1) + ' z' + zoom.toFixed(1) + ' dpr' + dpr.toFixed(1));

  const size = Math.round(R.dbgFontPx * dpr);
  const lh = size + 4 * dpr;
  let wide = 0;
  for (const l of lines) { const m = ctx.measureText(l).width; if (m > wide) wide = m; }
  const pad = 6 * dpr;
  // Below the HUD's level title block: at 6 px the first line (the one with the
  // FPS on it) sat underneath "Sandbox / SURVIVE 120s" and was the one number
  // you could not read.
  const top = R.dbgPanelTopPx * dpr;
  ctx.fillStyle = R.dbgBg;
  ctx.fillRect(pad, top, wide + pad * 2, lines.length * lh + pad * 2);
  ctx.fillStyle = R.dbgColor;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], pad * 2, top + pad + i * lh);
}

function hoverLine(w) {
  const i = Math.max(0, Math.min(w.n - 1, Math.floor((hoverX - w.x0) / w.cellW)));
  const b = Math.max(0, Math.min(w.n, Math.round((hoverX - w.x0) / w.cellW)));
  const blk = w.blocked[b];
  let bTxt = 'open';
  if (blk && blk.length) {
    bTxt = '';
    for (let k = 0; k < blk.length && k < 3; k++) {
      bTxt += '[' + blk[k][0].toFixed(2) + '..' + blk[k][1].toFixed(2) + ']';
    }
    if (blk.length > 3) bTxt += '+' + (blk.length - 3);
  }
  return 'hover   x ' + hoverX.toFixed(2) + ' y ' + hoverY.toFixed(2) +
    '  cell ' + i + ' d ' + w.depth[i].toFixed(3) + ' bed ' + w.bed[i].toFixed(2) +
    ' surf ' + (w.bed[i] + w.depth[i]).toFixed(2) +
    '  b' + b + ' vel ' + w.vel[b].toFixed(2) +
    ' flow ' + (w.flow ? w.flow[b].toFixed(3) : '?') +
    ' crest ' + (w.crest ? w.crest[b].toFixed(2) : '?') + ' ' + bTxt;
}

function layerLine(w) {
  const maxN = w.fluid ? w.fluid.max : CONFIG.fluid.maxParticles;
  return 'layer   ' + LAYER_NAMES[layer] + '  p ' + (w.pcount | 0) + '/' + maxN +
    '  pmax ' + lastMaxP.toFixed(1);
}

// ---- water overlays ----------------------------------------------------

function drawWaterDebug(ctx, w) {
  if (!w) return;
  const cwm = w.cellW;

  // visible boundary range
  const xLeft = camX - cx / zoom, xRight = camX + cx / zoom;
  let b0 = Math.floor((xLeft - w.x0) / cwm) - 1;
  let b1 = Math.ceil((xRight - w.x0) / cwm) + 1;
  if (b0 < 0) b0 = 0;
  if (b1 > w.n) b1 = w.n;

  // blocked intervals: red vertical bars exactly where the dam seals the flow
  ctx.fillStyle = R.dbgBad;
  for (let b = b0; b <= b1; b++) {
    const blk = w.blocked[b];
    if (!blk || !blk.length) continue;
    const px = SX(w.x0 + b * cwm);
    for (let k = 0; k < blk.length; k++) {
      const y0 = blk[k][0], y1 = blk[k][1];
      const top = SY(y1), bot = SY(y0);
      ctx.fillRect(px - R.dbgBlockedPx * dpr * 0.5, top, R.dbgBlockedPx * dpr, Math.max(1, bot - top));
    }
  }

  // velocity arrows along the surface
  ctx.strokeStyle = R.dbgWarn;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  const every = Math.max(1, R.dbgArrowEvery);
  for (let b = b0; b <= b1; b += every) {
    const v = w.vel[b];
    if (Math.abs(v) < 0.05) continue;
    const iL = Math.max(0, Math.min(w.n - 1, b - 1));
    const iR = Math.max(0, Math.min(w.n - 1, b));
    const surf = Math.max(w.bed[iL] + w.depth[iL], w.bed[iR] + w.depth[iR]);
    const x = w.x0 + b * cwm;
    const px = SX(x), py = SY(surf);
    const len = v * R.dbgVecScale * zoom;
    ctx.moveTo(px, py);
    ctx.lineTo(px + len, py);
    const head = Math.min(6 * dpr, Math.abs(len) * 0.4) * (len >= 0 ? 1 : -1);
    ctx.lineTo(px + len - head, py - head * 0.5);
    ctx.moveTo(px + len, py);
    ctx.lineTo(px + len - head, py + head * 0.5);
  }
  ctx.stroke();
}

// ---- water v2: particle layer ------------------------------------------
// Dots straight from the particle arrays, coloured by speed. bucketBuf holds
// one speed-ramp index (or 255 for "culled") per particle, written ONCE per
// frame; the draw pass below then makes ramp.length sweeps over that buffer
// so fillStyle only changes ramp.length times a frame instead of once per dot.
let bucketBuf = new Uint8Array(0);

function ensureBucketBuf(n) {
  if (bucketBuf.length < n) bucketBuf = new Uint8Array(Math.max(n, bucketBuf.length * 2, 1024));
}

function drawParticleLayer(ctx, w) {
  if (layer !== LAYER_PARTICLES && layer !== LAYER_BOTH) return;
  if (!w) return;
  const count = w.pcount | 0;
  if (count <= 0) return;
  const ppx = w.ppx, ppy = w.ppy, pvx = w.pvx, pvy = w.pvy;
  if (!ppx || !ppy || !pvx || !pvy) return;

  const ramp = R.dbgSpeedRamp;
  const nb = ramp.length;
  if (nb <= 0) return;
  const speedScale = (nb - 1) / Math.max(1e-6, R.dbgSpeedRef);
  const px = R.dbgParticlePx * dpr;
  const half = px * 0.5;
  const maxDots = R.dbgParticleMax | 0;

  ensureBucketBuf(count);

  // pass 1: bucket by speed + cull off-screen in one sweep over the raw
  // particle arrays, so the draw sweeps below never touch hypot() again.
  for (let i = 0; i < count; i++) {
    const sx = SX(ppx[i]), sy = SY(ppy[i]);
    if (sx < -px || sx > W + px || sy < -px || sy > H + px) { bucketBuf[i] = 255; continue; }
    const speed = Math.hypot(pvx[i], pvy[i]);
    let idx = (speed * speedScale) | 0;
    if (idx >= nb) idx = nb - 1;
    bucketBuf[i] = idx;
  }

  // pass 2: one fillStyle set per bucket, then every dot in that bucket.
  let drawn = 0;
  for (let b = 0; b < nb && drawn < maxDots; b++) {
    let styleSet = false;
    for (let i = 0; i < count && drawn < maxDots; i++) {
      if (bucketBuf[i] !== b) continue;
      if (!styleSet) { ctx.fillStyle = ramp[b]; styleSet = true; }
      ctx.fillRect(SX(ppx[i]) - half, SY(ppy[i]) - half, px, px);
      drawn++;
    }
  }
}

// ---- water v2: pressure heat layer --------------------------------------
// The MAC-grid pressure field, colour-lerped cold→hot and normalised against
// the max |p| over the VISIBLE fluid cells this frame (pressure has no fixed
// scale — a 2 m puddle and a 20 m reservoir would otherwise render identically
// washed-out or identically saturated). Drawn under every other overlay: it is
// an opaque-ish filled background, and the blocked bars / arrows / member
// labels / panel all need to stay legible on top of it.
const PRESS_STEPS = 8;
let pressRamp = new Array(PRESS_STEPS).fill('rgba(0,0,0,0)');

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Small precomputed ramp instead of building an rgba() string per cell —
// same "no string building in the hot path" rule waterRenderer.js follows
// for its own per-particle sprite passes. Built once: it depends only on
// config, so rebuilding it every frame would be eight throwaway strings a
// frame for nothing.
let pressRampBuilt = false;

function buildPressureRamp() {
  if (pressRampBuilt) return;
  pressRampBuilt = true;
  const cold = hexToRgb(R.dbgPressCold);
  const hot = hexToRgb(R.dbgPressColor);
  for (let i = 0; i < PRESS_STEPS; i++) {
    const t = i / (PRESS_STEPS - 1);
    const r = Math.round(cold[0] + (hot[0] - cold[0]) * t);
    const g = Math.round(cold[1] + (hot[1] - cold[1]) * t);
    const b = Math.round(cold[2] + (hot[2] - cold[2]) * t);
    const a = R.dbgPressAlpha * t;
    pressRamp[i] = 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
  }
}

function drawPressureLayer(ctx, w) {
  if (layer !== LAYER_PRESSURE && layer !== LAYER_BOTH) { lastMaxP = 0; return; }
  lastMaxP = 0;
  if (!w) return;
  const f = w.fluid;
  if (!f || !f.p || !f.cellType) return;
  if (f.h * zoom < R.dbgPressMinPx * dpr) return;   // too small to read — skip it

  const nx = f.nx, ny = f.ny, h = f.h, x0 = f.x0, y0 = f.y0;

  // visible ix/iy range, derived the same way drawWaterDebug derives its
  // boundary range, just against the fluid grid's own origin/cell size.
  const xLeft = camX - cx / zoom, xRight = camX + cx / zoom;
  const yBot = camY - cy / zoom, yTop = camY + cy / zoom;
  let ix0 = Math.floor((xLeft - x0) / h) - 1;
  let ix1 = Math.ceil((xRight - x0) / h) + 1;
  let iy0 = Math.floor((yBot - y0) / h) - 1;
  let iy1 = Math.ceil((yTop - y0) / h) + 1;
  if (ix0 < 0) ix0 = 0;
  if (iy0 < 0) iy0 = 0;
  if (ix1 > nx - 1) ix1 = nx - 1;
  if (iy1 > ny - 1) iy1 = ny - 1;
  if (ix0 > ix1 || iy0 > iy1) return;

  const p = f.p, cellType = f.cellType;
  let maxP = 0;
  for (let ix = ix0; ix <= ix1; ix++) {
    const base = ix * ny;
    for (let iy = iy0; iy <= iy1; iy++) {
      const c = base + iy;
      if (cellType[c] !== FLUID) continue;
      const ap = p[c] < 0 ? -p[c] : p[c];
      if (ap > maxP) maxP = ap;
    }
  }
  if (maxP <= 1e-6) return;   // no pressure yet (e.g. still in build phase)
  lastMaxP = maxP;

  buildPressureRamp();
  const invMax = (PRESS_STEPS - 1) / maxP;
  const cellPx = h * zoom;

  // same bucket-sweep trick as the particle layer: one fillStyle per ramp
  // step instead of one per cell.
  for (let bIdx = 0; bIdx < PRESS_STEPS; bIdx++) {
    let styleSet = false;
    for (let ix = ix0; ix <= ix1; ix++) {
      const base = ix * ny;
      const wx = x0 + ix * h;
      for (let iy = iy0; iy <= iy1; iy++) {
        const c = base + iy;
        if (cellType[c] !== FLUID) continue;
        const ap = p[c] < 0 ? -p[c] : p[c];
        let idx = (ap * invMax) | 0;
        if (idx >= PRESS_STEPS) idx = PRESS_STEPS - 1;
        if (idx !== bIdx) continue;
        if (!styleSet) { ctx.fillStyle = pressRamp[bIdx]; styleSet = true; }
        const wy = y0 + iy * h;
        ctx.fillRect(SX(wx), SY(wy + h), cellPx, cellPx);
      }
    }
  }
}

// ---- structure overlays -------------------------------------------------

function drawStructureDebug(ctx, st) {
  if (!st) return;

  // node vectors: dim lines are velocity, red lines are the true external
  // force on the node (water pressure + impact + drag + buoyancy)
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = R.dbgDim;
  ctx.beginPath();
  for (let i = 0; i < st.nodes.length; i++) {
    const n = st.nodes[i];
    const px = SX(n.x), py = SY(n.y);
    if (px < 0 || px > W) continue;
    const vx = n.vx || 0, vy = n.vy || 0;
    if (Math.abs(vx) + Math.abs(vy) > 0.02) {
      ctx.moveTo(px, py);
      ctx.lineTo(px + vx * R.dbgVecScale * zoom, py - vy * R.dbgVecScale * zoom);
    }
    ctx.moveTo(px + 3 * dpr, py);
    ctx.arc(px, py, 3 * dpr, 0, TAU);
  }
  ctx.stroke();

  // lfx/lfy are the external force accumulators snapshotted BEFORE the solver
  // consumes them (constraints.js) — n.fx/n.fy read zero by draw time.
  ctx.strokeStyle = R.dbgBad;
  ctx.beginPath();
  let anyF = false;
  for (let i = 0; i < st.nodes.length; i++) {
    const n = st.nodes[i];
    const fx = n.lfx || 0, fy = n.lfy || 0;
    if (Math.abs(fx) + Math.abs(fy) < 1) continue;
    const px = SX(n.x), py = SY(n.y);
    ctx.moveTo(px, py);
    ctx.lineTo(px + fx * 0.02 * zoom, py - fy * 0.02 * zoom);
    anyF = true;
  }
  if (anyF) ctx.stroke();

  // per-member load %, zoom-gated so the numbers never turn into mush
  const minPx = R.dbgMinMemberPx * dpr;
  for (let i = 0; i < st.members.length; i++) {
    const m = st.members[i];
    if (m.broken) continue;
    const x0 = SX(m.a.x), y0 = SY(m.a.y), x1 = SX(m.b.x), y1 = SY(m.b.y);
    if (Math.hypot(x1 - x0, y1 - y0) < minPx) continue;
    const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5;
    if (mx < 0 || mx > W || my < 0 || my > H) continue;
    const load = m.load || 0;
    ctx.fillStyle = load >= 1 ? R.dbgBad : load >= CONFIG.damage.safe ? R.dbgWarn : R.dbgColor;
    const txt = Math.round(load * 100) + (m.loadSign > 0 ? 'T' : 'C') +
      (m.damage > 0.01 ? ' d' + m.damage.toFixed(2) : '');
    ctx.fillText(txt, mx + 3 * dpr, my - R.dbgFontPx * dpr - 2 * dpr);
  }
}
