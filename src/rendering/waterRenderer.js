// OPUS C owns. Bulk water surface rendering. Contract §9.
//
// The water must read as one HEAVY BODY, never as a row of cell rectangles:
//   1. group the grid into contiguous wet spans;
//   2. smooth each span's surface (midpoint / [1 2 1] passes over the columns);
//   3. fill one polygon per span — smoothed surface on top, the BED underneath —
//      with a vertical depth gradient (shallow = light and translucent, deep =
//      saturated dark blue), so a 6 m reservoir looks heavier than a puddle;
//   4. a brighter surface line on top;
//   5. undulation ONLY where the water is actually moving, phased from
//      water.time (never Math.random — the sim is deterministic and so is this);
//   6. foam streaks where |velocity| is high.
//
// Under-terrain never shows water: the whole pass is clipped to the region ABOVE
// the terrain polyline, and the polygon bottom deliberately overshoots the bed
// so no seam can open between the water and the ground.

import { CONFIG } from '../config.js';
import { renderStressOverlay } from './renderer.js';

const R = CONFIG.render;
const TAU = Math.PI * 2;

let W = 0, H = 0, cx = 0, cy = 0;
let camX = 0, camY = 0, zoom = 1, shX = 0, shY = 0, dpr = 1;

const SX = (x) => (x - camX) * zoom + cx + shX;
const SY = (y) => cy - (y - camY) * zoom + shY;

function beginFrame(ctx, cam) {
  W = ctx.canvas.width; H = ctx.canvas.height;
  cx = W * 0.5; cy = H * 0.5;
  camX = cam.x; camY = cam.y; zoom = cam.zoom;
  shX = cam.shakeX || 0; shY = cam.shakeY || 0;
  const cw = ctx.canvas.clientWidth;
  const d = cw > 0 ? W / cw : 1;
  dpr = d > 0.1 && d < 8 ? d : 1;
}

// ---- colour ramps (built once; no string building in the hot path) --------

const RAMP_STEPS = 12;
let ramps = null;

function hexToRgb(hex) {
  const h = typeof hex === 'string' && hex.charAt(0) === '#' ? hex.slice(1) : hex;
  if (typeof h !== 'string' || h.length < 6) return { r: 40, g: 120, b: 190 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgba(c, a) {
  return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' +
    (Math.round(a * 1000) / 1000) + ')';
}

function mix(a, b, f) {
  return { r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f };
}

function buildRamps() {
  if (ramps) return ramps;
  const sh = hexToRgb(R.waterShallow);
  const md = hexToRgb(R.waterMid);
  const dp = hexToRgb(R.waterDeep);
  const top = new Array(RAMP_STEPS + 1);
  const mid = new Array(RAMP_STEPS + 1);
  const bot = new Array(RAMP_STEPS + 1);
  for (let i = 0; i <= RAMP_STEPS; i++) {
    const f = i / RAMP_STEPS;                       // 0 = puddle, 1 = deep water
    const a = R.waterShallowAlpha + (R.waterAlpha - R.waterShallowAlpha) * f;
    // The very surface stays translucent even in deep water: that is what lets
    // the bed show through the shallows and the dam show through the reservoir.
    top[i] = rgba(sh, R.waterShoreAlpha + (R.waterAlpha - R.waterShoreAlpha) * f * 0.35);
    mid[i] = rgba(mix(sh, md, f), a);
    bot[i] = rgba(mix(sh, dp, f), a);
  }
  ramps = { top, mid, bot };
  return ramps;
}

// ---- reusable buffers ----------------------------------------------------

let surf = new Float32Array(0);
let smooth = new Float32Array(0);
let wet = new Uint8Array(0);

function ensure(n) {
  if (surf.length >= n) return;
  surf = new Float32Array(n);
  smooth = new Float32Array(n);
  wet = new Uint8Array(n);
}

// ---- deterministic noise ------------------------------------------------

function frac(seed) {
  let h = seed >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519);
  h ^= h >>> 13; h = Math.imul(h, 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 0 at rest, 1 in a torrent — gates the undulation so still water is glassy.
function motion(v) {
  const a = Math.abs(v);
  if (a <= R.waveVelMin) return 0;
  return clamp01((a - R.waveVelMin) / Math.max(0.001, R.waveVelFull - R.waveVelMin));
}

// ---- entry point --------------------------------------------------------

export function render(ctx, cam, water, S) {
  if (!water) return;
  beginFrame(ctx, cam);

  const n = water.n;
  ensure(n);
  const minD = (water.cfg && water.cfg.minDepth) || 0.005;
  const depth = water.depth, bed = water.bed;

  // visible cell range (+2 cells of margin so spans close off-screen)
  const xLeft = camX - (cx + Math.abs(shX)) / zoom;
  const xRight = camX + (cx + Math.abs(shX)) / zoom;
  let i0 = Math.floor((xLeft - water.x0) / water.cellW) - 2;
  let i1 = Math.ceil((xRight - water.x0) / water.cellW) + 2;
  if (i0 < 0) i0 = 0;
  if (i1 > n) i1 = n;
  if (i1 <= i0) { renderStressOverlay(ctx, cam, S); return; }

  for (let i = i0; i < i1; i++) {
    wet[i] = depth[i] > minD ? 1 : 0;
    surf[i] = bed[i] + depth[i];
    smooth[i] = surf[i];
  }

  // midpoint smoothing, wet neighbours only: a [1 2 1] kernel per pass
  for (let pass = 0; pass < R.smoothPasses; pass++) {
    for (let i = i0; i < i1; i++) {
      if (!wet[i]) continue;
      const l = i > i0 && wet[i - 1] ? smooth[i - 1] : smooth[i];
      const r = i + 1 < i1 && wet[i + 1] ? smooth[i + 1] : smooth[i];
      surf[i] = (l + 2 * smooth[i] + r) * 0.25;
    }
    for (let i = i0; i < i1; i++) if (wet[i]) smooth[i] = surf[i];
  }

  ctx.save();
  clipAboveTerrain(ctx, S && S.terrain);

  // walk the spans
  let s = -1;
  for (let i = i0; i <= i1; i++) {
    const isWet = i < i1 && wet[i] === 1;
    if (isWet && s < 0) s = i;
    else if (!isWet && s >= 0) {
      if (i - s >= R.minSpanCells) drawSpan(ctx, water, s, i);
      s = -1;
    }
  }

  // Pouring water is drawn INSIDE the terrain clip (it must not spill into the
  // ground) but BEFORE the structure overlay, so the dam always ends up on top
  // of its own waterfall rather than behind a cloud.
  drawOvertop(ctx, water, S);
  drawJets(ctx, water, S);

  ctx.restore();

  // failing members must stay readable through the water (see renderer.js)
  renderStressOverlay(ctx, cam, S);
}

// ---- pouring water: shared ballistic sheet -------------------------------

// Reused point buffers: a sheet is rebuilt every frame, so it must not allocate.
const MAXPT = 40;
const px_ = new Float64Array(MAXPT);
const py_ = new Float64Array(MAXPT);
const qx_ = new Float64Array(MAXPT);
const qy_ = new Float64Array(MAXPT);

// Where a falling sheet is stopped: the ground, or standing water on it.
function landingY(water, S, x) {
  const g = S && S.terrain ? S.terrain.heightAt(x) : -Infinity;
  const i = Math.floor((x - water.x0) / water.cellW);
  const w = i >= 0 && i < water.n ? water.bed[i] + water.depth[i] : -Infinity;
  return Math.max(g, w);
}

// Traces y = y0 − ½g t², x = x0 + vx t into px_/py_ (upper edge) and qx_/qy_
// (lower edge, offset by `th` perpendicular to the velocity). Returns the
// number of samples, or 0 if there is nothing to draw.
function traceSheet(water, S, x0, y0, vx, th, steps, maxRun) {
  const g = CONFIG.water.g;
  const n = Math.min(steps, MAXPT - 1);
  // how long until it lands, and how far it may run
  let lowest = y0;
  for (let k = 0; k <= 6; k++) {
    const y = landingY(water, S, x0 + (vx >= 0 ? 1 : -1) * (maxRun * k) / 6);
    if (y < lowest) lowest = y;
  }
  const fall = Math.max(0.4, y0 - lowest);
  const tFall = Math.sqrt((2 * fall) / g) * 1.25;
  const tRun = Math.abs(vx) > 0.25 ? maxRun / Math.abs(vx) : tFall;
  const tEnd = Math.min(tFall, tRun);
  if (!(tEnd > 0)) return 0;

  let count = 0;
  for (let i = 0; i <= n; i++) {
    const t = (tEnd * i) / n;
    const x = x0 + vx * t;
    const y = y0 - 0.5 * g * t * t;
    // velocity direction, for the perpendicular offset
    const vy = -g * t;
    const sp = Math.hypot(vx, vy) || 1;
    const nx = -vy / sp, ny = vx / sp;
    px_[count] = x; py_[count] = y;
    qx_[count] = x + nx * th; qy_[count] = y + ny * th;
    count++;
    if (i > 0 && y <= landingY(water, S, x)) break;
  }
  return count;
}

// Fills the traced sheet with a top→toe alpha ramp. Returns nothing; callers
// read px_/py_ for the landing point.
function fillSheet(ctx, count, color, aTop, aToe) {
  if (count < 2) return;
  const x0s = SX(px_[0]), y0s = SY(py_[0]);
  const x1s = SX(px_[count - 1]), y1s = SY(py_[count - 1]);
  ctx.beginPath();
  ctx.moveTo(x0s, y0s);
  for (let i = 1; i < count; i++) ctx.lineTo(SX(px_[i]), SY(py_[i]));
  for (let i = count - 1; i >= 0; i--) ctx.lineTo(SX(qx_[i]), SY(qy_[i]));
  ctx.closePath();
  const grad = ctx.createLinearGradient(x0s, y0s, x1s, y1s);
  const c = hexToRgb(color);
  grad.addColorStop(0, rgba(c, aTop));
  grad.addColorStop(1, rgba(c, aToe));
  ctx.fillStyle = grad;
  ctx.fill();
}

// ---- overtopping ---------------------------------------------------------

// One sheet per contiguous overtopping run. Merging matters: a separate sprite
// or sheet per boundary would stack alpha into the opaque white blob this
// replaces.
function drawOvertop(ctx, water, S) {
  const n = water.n;
  if (!water.weirFlow) return;
  const minF = R.nappeMinFlow;

  let b = 1;
  while (b < n) {
    if (Math.abs(water.weirFlow[b]) <= minF) { b++; continue; }
    // Find the CONTROLLING weir in this run (most flow) and use ITS crest. Using
    // the run's lowest crest instead put the sheet halfway down the dam, because
    // a lattice's blockage profile dips wherever a bay has no member in it.
    let e = b, best = b, bestF = 0, signSum = 0;
    while (e < n && Math.abs(water.weirFlow[e]) > minF) {
      const f = water.weirFlow[e];
      if (Math.abs(f) > bestF) { bestF = Math.abs(f); best = e; }
      signSum += f;
      e++;
    }
    const dir = signSum >= 0 ? 1 : -1;
    const crest = water.crest[best];
    const iUp = Math.max(0, Math.min(n - 1, (dir > 0 ? b - 1 : e)));
    const upSurf = water.bed[iUp] + water.depth[iUp];
    const H = Math.max(0, upSurf - crest);
    if (H <= 0.01) { b = e; continue; }
    const q = bestF;
    const xLip = water.x0 + (dir > 0 ? e : b) * water.cellW;

    // Thickness comes from the HEAD, not the flow: the depth of water riding
    // over a broad crest is ~2/3 H, and that is what gives a pour its bulk.
    const v0 = Math.min(R.nappeMaxVel, Math.sqrt(2 * CONFIG.water.g * H) * R.nappeVelCoeff) * dir;
    const thFloor = Math.max(R.nappeMinTh, (R.nappeMinPx * dpr) / zoom);
    const th = Math.max(thFloor, Math.min(R.nappeMaxTh, 0.6 * H));
    const count = traceSheet(water, S, xLip, crest, v0, -th, R.nappeSteps, R.nappeMaxRun);

    if (count >= 2) {
      fillSheet(ctx, count, R.nappeColor, R.nappeAlphaTop, R.nappeAlphaToe);
      // bright lip riding the crest, so the crest line stays legible
      ctx.beginPath();
      ctx.moveTo(SX(px_[0]), SY(py_[0]));
      for (let i = 1; i < Math.min(count, 5); i++) ctx.lineTo(SX(px_[i]), SY(py_[i]));
      ctx.strokeStyle = R.nappeEdge;
      ctx.lineWidth = Math.max(1, 1.6 * dpr);
      ctx.stroke();
      // foam where it lands
      const fr = Math.max(0.15, Math.min(2.2, R.toeFoamR * (0.6 + q)));
      ctx.beginPath();
      ctx.ellipse(SX(px_[count - 1]), SY(py_[count - 1]),
        fr * zoom, fr * 0.5 * zoom, 0, 0, TAU);
      ctx.fillStyle = R.toeFoamColor;
      ctx.fill();
    }
    b = e;
  }
}

// ---- leak / breach jets --------------------------------------------------

const gapY0 = new Float64Array(8);
const gapY1 = new Float64Array(8);
const jetQ = new Float64Array(8);
const jetOrder = new Int32Array(8);

// Open y-intervals at a boundary: the complement of water.blocked[b] between
// the sill and the crest. Mirrors the gap walk in physics/water.js.
function gapsAt(water, b, upSurf) {
  const blk = water.blocked[b];
  const sill = water.bedB[b];
  const top = Math.min(water.crest[b], upSurf);
  let cursor = sill;
  let n = 0;
  if (blk) {
    for (let k = 0; k < blk.length && n < gapY0.length; k++) {
      const y0 = Math.max(blk[k][0], sill);
      const y1 = Math.max(blk[k][1], sill);
      if (y1 <= sill) continue;
      if (y0 > cursor + 1e-3 && cursor < top) {
        gapY0[n] = cursor; gapY1[n] = Math.min(y0, top); n++;
      }
      if (y1 > cursor) cursor = y1;
    }
  }
  if (cursor < top - 1e-3 && n < gapY0.length) { gapY0[n] = cursor; gapY1[n] = top; n++; }
  return n;
}

// One set of jets per sealed run — the CONTROLLING boundary (most orifice flow)
// drawn at the downstream face. A jet per boundary would stack a dozen
// overlapping arcs through the thickness of the same dam.
function drawJets(ctx, water, S) {
  const n = water.n;
  if (!water.gapFlow || !water.sealed) return;

  let b = 1;
  while (b < n) {
    if (!water.sealed[b]) { b++; continue; }
    let e = b, best = b, bestF = 0;
    while (e < n && water.sealed[e]) {
      const f = Math.abs(water.gapFlow[e]);
      if (f > bestF) { bestF = f; best = e; }
      e++;
    }
    if (bestF > R.jetMinFlow) drawJetsAt(ctx, water, S, best, b, e);
    b = e;
  }
}

function drawJetsAt(ctx, water, S, b, runStart, runEnd) {
  const flow = water.gapFlow[b];
  const dir = flow >= 0 ? 1 : -1;
  const iUp = Math.max(0, Math.min(water.n - 1, dir > 0 ? runStart - 1 : runEnd));
  const upSurf = water.bed[iUp] + water.depth[iUp];
  const count = gapsAt(water, b, upSurf);
  if (!count) return;

  // the jet emerges from the downstream face of the dam, not mid-thickness
  const xFace = water.x0 + (dir > 0 ? runEnd : runStart) * water.cellW;
  const total = Math.abs(flow);

  // share the measured flow across the gaps by their own orifice capacity
  let cap = 0;
  for (let k = 0; k < count; k++) {
    const h = Math.max(0, upSurf - (gapY0[k] + gapY1[k]) * 0.5);
    cap += (gapY1[k] - gapY0[k]) * Math.sqrt(h);
  }
  if (!(cap > 0)) return;

  // rank the gaps and keep only the biggest few
  const order = jetOrder;
  let m = 0;
  for (let k = 0; k < count; k++) {
    const mid = (gapY0[k] + gapY1[k]) * 0.5;
    const head = Math.max(0, upSurf - mid);
    if (head <= 0.02) continue;
    jetQ[k] = total * (((gapY1[k] - gapY0[k]) * Math.sqrt(head)) / cap);
    order[m++] = k;
  }
  for (let a = 1; a < m; a++) {          // insertion sort, m is tiny
    const v = order[a];
    let j = a - 1;
    while (j >= 0 && jetQ[order[j]] < jetQ[v]) { order[j + 1] = order[j]; j--; }
    order[j + 1] = v;
  }
  const draw = Math.min(m, R.jetMaxDraw);

  for (let oi = 0; oi < draw; oi++) {
    const k = order[oi];
    const y0 = gapY0[k], y1 = gapY1[k];
    const mid = (y0 + y1) * 0.5;
    const head = Math.max(0, upSurf - mid);
    const q = jetQ[k];
    if (q < R.jetMinFlow) continue;

    const v0 = Math.sqrt(2 * CONFIG.water.g * head) * R.jetVelCoeff * dir;
    const thFloor = Math.max(R.jetMinTh, (R.jetMinPx * dpr) / zoom);
    const th = Math.max(thFloor, Math.min(R.jetMaxTh, q / Math.max(0.5, Math.abs(v0))));
    const cnt = traceSheet(water, S, xFace, mid, v0, -th, R.jetSteps, R.jetMaxRun);
    if (cnt < 2) continue;

    fillSheet(ctx, cnt, R.jetColor, R.jetAlphaNear, R.jetAlphaFar);

    // a hard jet gets a bright centreline so "deep leak" reads as violent
    if (q > R.jetHardFlow) {
      ctx.beginPath();
      ctx.moveTo(SX(px_[0]), SY(py_[0]));
      for (let i = 1; i < cnt; i++) ctx.lineTo(SX(px_[i]), SY(py_[i]));
      ctx.strokeStyle = R.jetCore;
      ctx.lineWidth = Math.max(1, th * 0.35 * zoom);
      ctx.stroke();
    }

    // splash where it lands
    const sr = Math.max(0.12, Math.min(2, R.jetSplashR * (0.5 + q)));
    ctx.beginPath();
    ctx.ellipse(SX(px_[cnt - 1]), SY(py_[cnt - 1]), sr * zoom, sr * 0.45 * zoom, 0, 0, TAU);
    ctx.fillStyle = rgba(hexToRgb(R.jetColor), R.jetSplashAlpha);
    ctx.fill();
  }
}

// Clip to everything ABOVE the ground so water can never bleed into the earth.
function clipAboveTerrain(ctx, terrain) {
  if (!terrain || !terrain.points || terrain.points.length < 2) return;
  const pts = terrain.points;
  ctx.beginPath();
  ctx.moveTo(SX(pts[0][0]) - W, -H);
  ctx.lineTo(SX(pts[0][0]) - W, SY(pts[0][1]));
  for (let i = 0; i < pts.length; i++) ctx.lineTo(SX(pts[i][0]), SY(pts[i][1]));
  const last = pts[pts.length - 1];
  ctx.lineTo(SX(last[0]) + W, SY(last[1]));
  ctx.lineTo(SX(last[0]) + W, -H);
  ctx.closePath();
  ctx.clip();
}

// One contiguous wet run, cells [a, b).
function drawSpan(ctx, water, a, b) {
  const cw = water.cellW;
  const depth = water.depth, bed = water.bed, vel = water.vel;
  const time = water.time || 0;

  // sample stride: never finer than a couple of device pixels
  const pxPerCell = cw * zoom;
  const stride = Math.max(1, Math.floor((R.waterSamplePx * dpr) / Math.max(0.001, pxPerCell)));

  let maxDepth = 0;
  let topY = Infinity, botY = -Infinity;
  for (let i = a; i < b; i++) {
    if (depth[i] > maxDepth) maxDepth = depth[i];
    if (smooth[i] > botY) botY = smooth[i];
    if (bed[i] < topY) topY = bed[i];
  }
  const surfaceTop = botY;                      // highest surface elevation
  const bedBottom = topY - R.waterBedOvershoot; // lowest bed, pushed under

  const sTop = SY(surfaceTop);
  const sBot = SY(bedBottom);
  if (sBot < -H || sTop > H * 2) return;

  const step = R.waveLen > 0 ? TAU / R.waveLen : 0;
  const phase = -time * R.waveSpeed * step;
  const edge = Math.max(1, Math.min(4, Math.floor((b - a) * 0.25)));

  // ---- body ------------------------------------------------------------
  ctx.beginPath();
  let first = true;
  for (let i = a; i < b; i += stride) {
    const x = water.x0 + (i + 0.5) * cw;
    const y = surfaceElevation(water, i, a, b, x, step, phase, edge);
    const px = SX(x), py = SY(y);
    if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
  }
  // always finish exactly on the last cell so the span closes on the bank
  {
    const iLast = b - 1;
    const x = water.x0 + (iLast + 0.5) * cw;
    const y = surfaceElevation(water, iLast, a, b, x, step, phase, edge);
    ctx.lineTo(SX(x), SY(y));
  }
  // right wall down to the bed, then back along the bed
  ctx.lineTo(SX(water.x0 + b * cw), SY(bed[b - 1] - R.waterBedOvershoot));
  for (let i = b - 1; i >= a; i -= stride) {
    ctx.lineTo(SX(water.x0 + (i + 0.5) * cw), SY(bed[i] - R.waterBedOvershoot));
  }
  ctx.lineTo(SX(water.x0 + a * cw), SY(bed[a] - R.waterBedOvershoot));
  ctx.closePath();

  const rp = buildRamps();
  const dStep = Math.round(clamp01(maxDepth / Math.max(0.001, R.waterDeepRef)) * RAMP_STEPS);
  const grad = ctx.createLinearGradient(0, sTop, 0, sBot);
  grad.addColorStop(0, rp.top[dStep]);
  grad.addColorStop(0.4, rp.mid[dStep]);
  grad.addColorStop(1, rp.bot[dStep]);
  ctx.fillStyle = grad;
  ctx.fill();

  // Contact shading along the bed: the ground darkens where water sits on it,
  // which is what stops a filled polygon from looking like flat blue paint.
  ctx.beginPath();
  for (let i = a; i < b; i += stride) {
    const x = water.x0 + (i + 0.5) * cw;
    const py = SY(bed[i]);
    const px = SX(x);
    if (i === a) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.lineTo(SX(water.x0 + (b - 1 + 0.5) * cw), SY(bed[b - 1]));
  ctx.strokeStyle = R.bedShadow;
  ctx.lineWidth = Math.max(1, R.bedShadowPx * dpr);
  ctx.lineCap = 'round';
  ctx.stroke();

  // ---- surface line ----------------------------------------------------
  ctx.beginPath();
  first = true;
  for (let i = a; i < b; i += stride) {
    const x = water.x0 + (i + 0.5) * cw;
    const y = surfaceElevation(water, i, a, b, x, step, phase, edge);
    const px = SX(x), py = SY(y);
    if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
  }
  {
    const iLast = b - 1;
    const x = water.x0 + (iLast + 0.5) * cw;
    ctx.lineTo(SX(x), SY(surfaceElevation(water, iLast, a, b, x, step, phase, edge)));
  }
  // sky sheen first: a soft wide band just under the line, then the crisp line
  ctx.strokeStyle = R.waterSheen;
  ctx.lineWidth = Math.max(1, R.waterSheenPx * dpr);
  ctx.lineCap = 'round';
  ctx.globalAlpha = R.waterSheenAlpha;
  ctx.stroke();
  ctx.strokeStyle = R.waterSurfaceColor;
  ctx.lineWidth = Math.max(1, R.waterSurfacePx * dpr);
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;

  drawFoam(ctx, water, a, b, step, phase, edge, stride);
}

// Smoothed surface + deterministic undulation, tapered to zero at the banks so
// the water always meets the ground cleanly.
function surfaceElevation(water, i, a, b, x, step, phase, edge) {
  const m = motion((water.vel[i] + water.vel[i + 1]) * 0.5);
  if (m <= 0) return smooth[i];
  const dEdge = Math.min(i - a, b - 1 - i);
  const taper = dEdge >= edge ? 1 : dEdge / edge;
  const amp = R.waveAmp * m * taper *
    Math.min(1, water.depth[i] / Math.max(0.001, R.waveDepthRef));
  return smooth[i] + Math.sin(x * step + phase) * amp;
}

// Short bright streaks riding the fast water. Positions are hashed from the cell
// index and a slow time bucket, so they drift without any randomness.
function drawFoam(ctx, water, a, b, step, phase, edge, stride) {
  const cw = water.cellW;
  const bucket = Math.floor((water.time || 0) * R.foamDriftHz);
  const len = Math.max(4 * dpr, 0.6 * zoom);
  let any = false;
  ctx.beginPath();
  for (let i = a; i < b; i += stride) {
    const v = (water.vel[i] + water.vel[i + 1]) * 0.5;
    if (Math.abs(v) < R.foamVelMin) continue;
    if (frac(i * 2654435761 + bucket) > R.foamChance) continue;
    const x = water.x0 + (i + 0.5) * cw;
    const y = surfaceElevation(water, i, a, b, x, step, phase, edge);
    const px = SX(x), py = SY(y);
    if (px < 0 || px > W) continue;
    const l = len * (0.5 + Math.min(1, Math.abs(v) / R.waveVelFull));
    const dir = v >= 0 ? 1 : -1;
    ctx.moveTo(px, py + R.foamPx * dpr);
    ctx.lineTo(px + l * dir, py + R.foamPx * dpr * 1.6);
    any = true;
  }
  if (!any) return;
  ctx.strokeStyle = R.foamColor;
  ctx.lineWidth = Math.max(1, R.foamPx * dpr);
  ctx.stroke();
}
