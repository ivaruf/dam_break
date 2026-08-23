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
    top[i] = rgba(sh, R.waterShallowAlpha + (R.waterAlpha - R.waterShallowAlpha) * f * 0.45);
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

  ctx.restore();

  // failing members must stay readable through the water (see renderer.js)
  renderStressOverlay(ctx, cam, S);
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
  ctx.strokeStyle = R.waterSurfaceColor;
  ctx.lineWidth = Math.max(1, R.waterSurfacePx * dpr);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.85;
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
