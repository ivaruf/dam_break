// OPUS C owns. F2 debug overlay: FPS, counts, stress numbers, blocked
// intervals, velocity vectors. Contract §9. Strictly read-only over the scene.
//
// render() is called every frame even when the overlay is off (that is where the
// FPS counter lives), so the disabled path must stay near-free: one timestamp
// and an early return.

import { CONFIG } from '../config.js';
import { on } from '../core/events.js';
import * as effects from '../rendering/effects.js';

const R = CONFIG.render;
const TAU = Math.PI * 2;

let enabled = CONFIG.debug.enabled;
let frames = 0, fps = 0, last = 0, worst = 0, frameStart = 0;
let hoverX = 0, hoverY = 0, haveHover = false;

let W = 0, H = 0, cx = 0, cy = 0;
let camX = 0, camY = 0, zoom = 1, shX = 0, shY = 0, dpr = 1;

const SX = (x) => (x - camX) * zoom + cx + shX;
const SY = (y) => cy - (y - camY) * zoom + shY;

// F2 itself is handled by game.js, which calls toggle() for us.
export function init() {
  on('input:move', (p) => { hoverX = p.x; hoverY = p.y; haveHover = true; });
}

export function toggle() {
  enabled = !enabled;
  worst = 0;
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

  drawWaterDebug(ctx, S.water);
  drawStructureDebug(ctx, S.structure);
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
  const top = 6 * dpr;
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
