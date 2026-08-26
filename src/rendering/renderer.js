// OPUS C owns. Backdrop, terrain, anchors, build zone, structure + stress viz.
// Contract: ARCHITECTURE.md §9.
//
// Everything here is DETERMINISTIC: the parallax hills and the crack ticks are
// hashed from the level id / member id, never from Math.random, so a replay of
// the same level looks identical (decorative randomness lives in effects.js).
//
// The camera transform is inlined (SX/SY) instead of calling
// camera.worldToScreen, which allocates a two-element array per call — with a
// few hundred members that is thousands of throwaway arrays per frame.
// SX/SY mirror core/camera.js exactly, shake included.
//
// NOTE ON DRAW ORDER: game.js draws the water AFTER us, so the submerged part
// of the dam is tinted by the water (which is what you want — you can see the
// waterline on the face). To keep an overloaded member readable even when it is
// 4 m under, waterRenderer.js calls renderStressOverlay() at the very end of
// its own pass. That is the only cross-file coupling in the render stack.

import { CONFIG } from '../config.js';
import { getBuilder } from '../build/builder.js';
import { MATERIALS } from '../build/materials.js';

const R = CONFIG.render;
const TAU = Math.PI * 2;

// ---- frame transform state (module-level to avoid per-call allocation) ----

let W = 0, H = 0, cx = 0, cy = 0;
let camX = 0, camY = 0, zoom = 1, shX = 0, shY = 0, dpr = 1;

// Frames drawn, monotonic. The build phase has no simTime to breathe against
// (it is 0 until the water is released) and Date.now()/Math.random() would make
// two runs of the same level draw different frames — this file's whole rule. So
// the chain-head pulse is a function of the frame COUNT: deterministic, and
// still smooth on any display that is actually painting.
let frames = 0;

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
  frames++;
}

export function init() {
  skyGrad = null; hazeGrad = null; soilGrad = null;
  hillId = null; terrainId = null;
  resetCreep();
}

// ---- small deterministic helpers -----------------------------------------

function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// integer -> [0,1), no state, no allocation
function frac(seed, salt) {
  let h = (seed ^ Math.imul(salt + 1, 2654435761)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519);
  h ^= h >>> 13; h = Math.imul(h, 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- colour ---------------------------------------------------------------

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  if (h.length < 6) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function mixRgb(a, b, f) {
  return {
    r: a.r + (b.r - a.r) * f,
    g: a.g + (b.g - a.g) * f,
    b: a.b + (b.b - a.b) * f,
  };
}

function lift(c, f) {   // toward white
  return mixRgb(c, { r: 255, g: 255, b: 255 }, f);
}

function rgbStr(c) {
  return 'rgb(' + Math.round(clamp01(c.r / 255) * 255) + ',' +
    Math.round(clamp01(c.g / 255) * 255) + ',' +
    Math.round(clamp01(c.b / 255) * 255) + ')';
}

// Stress ramps are precomputed per material so the hot loop only ever indexes
// an array — building an 'rgb(...)' string per member per frame would allocate.
const PAL_STEPS = 16;
const palettes = Object.create(null);

function paletteFor(mat) {
  const id = mat && mat.id ? mat.id : 'default';
  const found = palettes[id];
  if (found) return found;
  const base = hexToRgb(mat && mat.color) || { r: 200, g: 200, b: 200 };
  const ten = hexToRgb(R.tensionColor) || { r: 127, g: 220, b: 255 };
  const com = hexToRgb(R.compressionColor) || { r: 255, g: 131, b: 72 };
  const t = new Array(PAL_STEPS + 1);
  const c = new Array(PAL_STEPS + 1);
  for (let i = 0; i <= PAL_STEPS; i++) {
    const f = i / PAL_STEPS;
    t[i] = rgbStr(lift(mixRgb(base, ten, f * 0.9), f * 0.28));   // cooler + brighter
    c[i] = rgbStr(lift(mixRgb(base, com, f * 0.9), f * 0.10));   // warmer
  }
  const wetT = hexToRgb(R.wetTint) || { r: 143, g: 214, b: 255 };
  const pal = { t, c, wet: rgbStr(mixRgb(base, wetT, R.wetTintMix)) };
  palettes[id] = pal;
  return pal;
}

// Load -> palette index. Below stressFrom a member keeps its material colour.
function stressStep(load) {
  const f = (load - R.stressFrom) / (1 - R.stressFrom);
  return Math.round(clamp01(f) * PAL_STEPS);
}

// ---- cached gradients (canvas-size keyed, not per frame) ------------------

let skyGrad = null, skyH = -1;
let hazeGrad = null, hazeH = -1;
let soilGrad = null, soilH = -1;

function sky(ctx) {
  if (!skyGrad || skyH !== H) {
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, R.skyTop);
    skyGrad.addColorStop(0.55, R.skyMid);
    skyGrad.addColorStop(1, R.skyLow);
    skyH = H;
  }
  return skyGrad;
}

function haze(ctx) {
  if (!hazeGrad || hazeH !== H) {
    hazeGrad = ctx.createLinearGradient(0, H * 0.35, 0, H);
    hazeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    hazeGrad.addColorStop(1, R.hazeColor);
    hazeH = H;
  }
  return hazeGrad;
}

function soil(ctx) {
  if (!soilGrad || soilH !== H) {
    soilGrad = ctx.createLinearGradient(0, 0, 0, H);
    soilGrad.addColorStop(0, R.terrainFill);
    soilGrad.addColorStop(1, R.terrainDeep);
    soilH = H;
  }
  return soilGrad;
}

// ---- per-level caches ----------------------------------------------------

let hillId = null;
const hills = [];        // [layer] = [{amp, freq, phase} x hillWaves]

function buildHills(levelId) {
  if (hillId === levelId) return;
  hillId = levelId;
  hills.length = 0;
  const seed = hashStr(levelId);
  const layers = R.hillColors.length;
  for (let k = 0; k < layers; k++) {
    const waves = [];
    let norm = 0;
    for (let w = 0; w < R.hillWaves; w++) {
      const a = 0.25 + 0.75 * frac(seed, k * 31 + w * 7);
      norm += a;
      waves.push({
        amp: a,
        // wavelengths 60 m down to 9 m, longest on the farthest layer
        freq: TAU / (9 + (50 - k * 12) * (0.4 + 0.6 * frac(seed, k * 53 + w * 11))),
        phase: frac(seed, k * 97 + w * 17) * TAU,
      });
    }
    for (const w of waves) w.amp /= norm;
    hills.push(waves);
  }
}

let terrainId = null;
let tLow = 0, tHigh = 0;

function measureTerrain(levelId, terrain) {
  if (terrainId === levelId) return;
  terrainId = levelId;
  tLow = Infinity; tHigh = -Infinity;
  for (const p of terrain.points) {
    if (p[1] < tLow) tLow = p[1];
    if (p[1] > tHigh) tHigh = p[1];
  }
  if (!isFinite(tLow)) { tLow = 0; tHigh = 10; }
}

// ---- entry point ---------------------------------------------------------

export function render(ctx, cam, S) {
  if (!S || !S.terrain) return;
  beginFrame(ctx, cam);

  const levelId = (S.level && S.level.id) || 'none';
  buildHills(levelId);
  measureTerrain(levelId, S.terrain);

  const build = S.phase === 'build';

  ctx.save();
  ctx.lineJoin = 'round';

  drawSky(ctx);
  drawHills(ctx);
  if (build) drawGrid(ctx);
  drawTerrain(ctx, S.terrain);
  drawProps(ctx, S.level, S.terrain);
  drawProtectZone(ctx, S.level);
  if (build) drawBuildZone(ctx, S.level);
  drawAnchors(ctx, S.terrain, build);

  if (S.structure) {
    drawDebris(ctx, S.structure);
    drawStructure(ctx, S.structure, S.simTime || 0);
  } else {
    drawDesign(ctx, S.design);
  }

  if (build) { drawGhost(ctx); drawMarquee(ctx); drawChainHead(ctx); drawLiftedNode(ctx); }

  ctx.restore();
}

// Re-drawn on top of the water. Two jobs:
//   1. a member under stress is never hidden by 4 m of blue (or by a waterfall);
//   2. the SUBMERGED structure stays readable at all — material identity and
//      stress colour both — instead of dissolving into the reservoir.
// Called from waterRenderer.js at the end of its pass. `wetTest(x,y) => bool` is
// the water v2 particle probe: the derived depth columns cannot answer "is this
// member under water" any more, because a waterfall plume bins into them as
// metres of depth over dry downstream ground.
export function renderStressOverlay(ctx, cam, S, wetTest) {
  if (!S || !S.structure) return;
  beginFrame(ctx, cam);
  const t = S.simTime || 0;
  const w = S.water;
  const members = S.structure.members;
  ctx.save();
  ctx.lineCap = 'butt';
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (m.broken || !m.mat) continue;
    const wet = wetTest ? isWetMember(wetTest, m) : (w ? isSubmerged(w, m) : false);
    // A creeping member can be sitting at 0.75 — under the flash threshold, but
    // actively dying, and if it is underwater the reservoir would hide the one
    // cue that says so. Only when WET: a dry one is already fully drawn in the
    // base pass, with its material detail, and this pass would flatten it.
    const stressed = m.load > R.stressWarn || (wet && isCreeping(m, t));
    if (!stressed && !wet) continue;      // dry and calm: the base pass has it
    if (stressed) drawMember(ctx, m, t, false);
    else drawWetMember(ctx, m);
  }
  drawStubs(ctx, S.structure);
  ctx.restore();
}

// Three probes (both ends + midpoint) so a column standing half out of the
// reservoir still counts as wet and gets redrawn above the water.
function isWetMember(wetTest, m) {
  return wetTest((m.a.x + m.b.x) * 0.5, (m.a.y + m.b.y) * 0.5) ||
    wetTest(m.a.x, m.a.y) || wetTest(m.b.x, m.b.y);
}

// midpoint below the local water surface (fallback when no particle probe)
function isSubmerged(w, m) {
  const mx = (m.a.x + m.b.x) * 0.5;
  const i = Math.floor((mx - w.x0) / w.cellW);
  if (i < 0 || i >= w.n) return false;
  if (w.depth[i] <= 0.02) return false;
  return (m.a.y + m.b.y) * 0.5 < w.bed[i] + w.depth[i];
}

// The material, pulled slightly toward a cool "wet" tint and drawn at high
// alpha over the water fill: reads as underwater without losing which material
// it is. Stress colour is unaffected because a stressed member takes the full
// drawMember path instead.
function drawWetMember(ctx, m) {
  const mat = m.mat;
  const width = Math.max(R.memberMinPx * dpr, (mat.thickness || 0.3) * zoom);
  const sag = bowFor(m);
  ctx.globalAlpha = R.wetAlpha;
  if (width >= 5 * dpr) {
    memberPath(ctx, m.a.x, m.a.y, m.b.x, m.b.y, sag);
    ctx.strokeStyle = R.memberOutline;
    ctx.lineWidth = width + R.memberOutlinePx * dpr * 2;
    ctx.stroke();
  }
  memberPath(ctx, m.a.x, m.a.y, m.b.x, m.b.y, sag);
  ctx.strokeStyle = paletteFor(mat).wet;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Torn ends. A member that broke leaves the run as debris, so without this the
// failure point just becomes empty space — and underwater that is invisible.
// Short dark jagged stubs on the surviving nodes say "this snapped here".
function drawStubs(ctx, structure) {
  const members = structure.members;
  let any = false;
  ctx.beginPath();
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m.broken || !m.mat) continue;
    const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ux = dx / len, uy = dy / len;
    const stub = Math.min(R.stubLen, len * 0.4);
    const seed = hashStr(m.id);
    for (let end = 0; end < 2; end++) {
      const ox = end ? m.b.x : m.a.x;
      const oy = end ? m.b.y : m.a.y;
      const sx = end ? -ux : ux;
      const sy = end ? -uy : uy;
      ctx.moveTo(SX(ox), SY(oy));
      for (let k = 1; k <= R.stubJag; k++) {
        const f = k / R.stubJag;
        const jag = (frac(seed, end * 17 + k) - 0.5) * stub * 0.5;
        ctx.lineTo(SX(ox + sx * stub * f - sy * jag), SY(oy + sy * stub * f + sx * jag));
      }
      any = true;
    }
  }
  if (!any) return;
  ctx.strokeStyle = R.stubColor;
  ctx.lineWidth = Math.max(1.5, 2.4 * dpr);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

// ---- backdrop -----------------------------------------------------------

function drawSky(ctx) {
  ctx.fillStyle = sky(ctx);
  ctx.fillRect(0, 0, W, H);
}

function drawHills(ctx) {
  const viewH = H / zoom;              // metres of world visible vertically
  const step = Math.max(6 * dpr, W / 160);
  for (let k = 0; k < hills.length; k++) {
    const waves = hills[k];
    const p = R.hillParallax[k] !== undefined ? R.hillParallax[k] : 0.5;
    const base = tLow + (R.hillBaseY[k] !== undefined ? R.hillBaseY[k] : 0.2) * viewH;
    const amp = (R.hillAmp[k] !== undefined ? R.hillAmp[k] : 0.08) * viewH;
    // vertical parallax: p=0 pins the ridge to a fixed screen height, p=1 locks
    // it to the world, matching the horizontal rate so panning feels coherent
    const refY = camY * p + tLow * (1 - p);

    ctx.beginPath();
    ctx.moveTo(-2, H + 2);
    for (let px = -2; px <= W + step; px += step) {
      const u = (px - cx - shX) / zoom + camX * p;
      let s = 0;
      for (let w = 0; w < waves.length; w++) {
        s += Math.sin(u * waves[w].freq + waves[w].phase) * waves[w].amp;
      }
      const wy = base + s * amp;
      ctx.lineTo(px, cy - (wy - refY) * zoom + shY);
    }
    ctx.lineTo(W + 2, H + 2);
    ctx.closePath();
    ctx.fillStyle = R.hillColors[k];
    ctx.fill();
  }
  ctx.fillStyle = haze(ctx);
  ctx.fillRect(0, 0, W, H);
}

function drawGrid(ctx) {
  const g = R.gridStep;
  if (!(g > 0) || g * zoom < 12 * dpr) return;
  const x0 = Math.floor(((camX - cx / zoom) / g)) * g;
  const x1 = camX + cx / zoom + g;
  const y0 = Math.floor(((camY - cy / zoom) / g)) * g;
  const y1 = camY + cy / zoom + g;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += g) {
    const px = SX(x);
    ctx.moveTo(px, 0); ctx.lineTo(px, H);
  }
  for (let y = y0; y <= y1; y += g) {
    const py = SY(y);
    ctx.moveTo(0, py); ctx.lineTo(W, py);
  }
  ctx.strokeStyle = R.gridColor;
  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.stroke();
}

// ---- terrain ------------------------------------------------------------

function terrainPath(ctx, t) {
  const pts = t.points;
  ctx.beginPath();
  ctx.moveTo(SX(pts[0][0]) - W, SY(pts[0][1]));       // extend past the left edge
  for (let i = 0; i < pts.length; i++) ctx.lineTo(SX(pts[i][0]), SY(pts[i][1]));
  const last = pts[pts.length - 1];
  ctx.lineTo(SX(last[0]) + W, SY(last[1]));
  ctx.lineTo(SX(last[0]) + W, H + 2);
  ctx.lineTo(SX(pts[0][0]) - W, H + 2);
  ctx.closePath();
}

function drawTerrain(ctx, t) {
  terrainPath(ctx, t);
  ctx.fillStyle = soil(ctx);
  ctx.fill();

  // subsurface strata, clipped to the landform: cheap sense of depth/geology
  const stepM = R.stratumStep;
  if (stepM > 0 && stepM * zoom > 8 * dpr) {
    ctx.save();
    terrainPath(ctx, t);
    ctx.clip();
    ctx.beginPath();
    const yTop = Math.floor((tHigh) / stepM) * stepM;
    const yBot = camY - cy / zoom - stepM;
    for (let y = yTop; y >= yBot; y -= stepM) {
      const py = SY(y);
      if (py < -2 || py > H + 2) continue;
      ctx.moveTo(0, py); ctx.lineTo(W, py);
    }
    ctx.strokeStyle = R.stratumColor;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.stroke();
    ctx.restore();
  }

  drawTerrainEdge(ctx, t);
}

// The surface line reads as grass on gentle ground and rock on steep ground,
// so a valley wall is legible as a valley wall.
function drawTerrainEdge(ctx, t) {
  const pts = t.points;
  const lw = Math.max(1.5, R.terrainEdgePx * dpr);
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';

  for (let pass = 0; pass < 2; pass++) {
    const wantRock = pass === 1;
    ctx.beginPath();
    let any = false;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1];
      const bx = pts[i][0], by = pts[i][1];
      const dx = bx - ax;
      const slope = dx !== 0 ? Math.abs((by - ay) / dx) : Infinity;
      const rock = slope >= R.terrainSteepSlope;
      if (rock !== wantRock) continue;
      ctx.moveTo(SX(ax), SY(ay));
      ctx.lineTo(SX(bx), SY(by));
      any = true;
    }
    if (any) {
      ctx.strokeStyle = wantRock ? R.terrainRock : R.terrainEdge;
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
}

// ---- decorative props (level.props, resolved by levelLoader) -------------

function drawProps(ctx, level, terrain) {
  const props = level && level.props;
  if (!props || !props.length) return;
  if (zoom < R.propMinZoom) return;                // too far out to read
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (!p || !isFinite(p.x)) continue;
    const px = SX(p.x);
    if (px < -80 * dpr || px > W + 80 * dpr) continue;
    // levelLoader resolves y from the terrain, but never trust it: a prop with
    // no y must stand on the ground, not at world zero
    const py = SY(isFinite(p.y) ? p.y : terrain.heightAt(p.x));
    const s = (p.scale || 1) * zoom;
    switch (p.type) {
      case 'pine': drawPine(ctx, px, py, s); break;
      case 'tree': drawTree(ctx, px, py, s); break;
      case 'rock': drawRock(ctx, px, py, s, i); break;
      case 'house': drawHouse(ctx, px, py, s); break;
      case 'sign': drawSign(ctx, px, py, s); break;
      default: break;
    }
  }
}

function drawPine(ctx, px, py, s) {
  const h = R.propPineH * s, w = h * 0.34;
  ctx.fillStyle = R.propTrunk;
  ctx.fillRect(px - w * 0.09, py - h * 0.22, Math.max(1, w * 0.18), h * 0.24);
  ctx.fillStyle = R.propTree;
  for (let k = 0; k < 3; k++) {
    const top = py - h * (0.45 + k * 0.24);
    const halfW = w * (0.5 - k * 0.12);
    const bot = py - h * (0.18 + k * 0.24);
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px + halfW, bot);
    ctx.lineTo(px - halfW, bot);
    ctx.closePath();
    ctx.fill();
  }
}

function drawTree(ctx, px, py, s) {
  const h = R.propTreeH * s;
  ctx.fillStyle = R.propTrunk;
  ctx.fillRect(px - Math.max(0.5, h * 0.035), py - h * 0.42, Math.max(1, h * 0.07), h * 0.44);
  ctx.fillStyle = R.propTree;
  ctx.beginPath();
  ctx.arc(px, py - h * 0.62, h * 0.3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = R.propTreeDark;
  ctx.beginPath();
  ctx.arc(px - h * 0.12, py - h * 0.52, h * 0.18, 0, TAU);
  ctx.fill();
}

function drawRock(ctx, px, py, s, i) {
  const r = R.propRockR * s;
  ctx.fillStyle = R.propRock;
  ctx.beginPath();
  const n = 6;
  for (let k = 0; k < n; k++) {
    const a = Math.PI + (k / (n - 1)) * Math.PI;
    const rr = r * (0.72 + 0.38 * frac(i * 131 + k, 5));
    const x = px + Math.cos(a) * rr;
    const y = py + Math.min(0, Math.sin(a) * rr);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawHouse(ctx, px, py, s) {
  const h = R.propHouseH * s, w = h * 1.15;
  ctx.fillStyle = R.propHouse;
  ctx.fillRect(px - w * 0.5, py - h * 0.72, w, h * 0.72);
  ctx.fillStyle = R.propRoof;
  ctx.beginPath();
  ctx.moveTo(px - w * 0.6, py - h * 0.7);
  ctx.lineTo(px, py - h * 1.12);
  ctx.lineTo(px + w * 0.6, py - h * 0.7);
  ctx.closePath();
  ctx.fill();
  if (h > 26 * dpr) {
    ctx.fillStyle = R.propWindow;
    ctx.fillRect(px - w * 0.16, py - h * 0.52, w * 0.3, h * 0.24);
  }
}

function drawSign(ctx, px, py, s) {
  const h = R.propSignH * s;
  ctx.fillStyle = R.propTrunk;
  ctx.fillRect(px - Math.max(0.5, h * 0.05), py - h, Math.max(1, h * 0.1), h);
  ctx.fillStyle = R.propSign;
  ctx.fillRect(px - h * 0.34, py - h * 1.02, h * 0.68, h * 0.3);
}

// ---- objective geometry -------------------------------------------------

// Zone captions are drawn ON the canvas but have to live with the DOM HUD on top
// of it, so their baseline is measured in CSS px from the top edge and converted
// once. R.zoneLabelTopPx clears the HUD's top row (name/objective/timer/budget).
function zoneLabelY() { return R.zoneLabelTopPx * dpr; }


function drawProtectZone(ctx, level) {
  const o = level && level.objective;
  if (!o || o.type !== 'protect' || o.x0 === undefined) return;
  const a = SX(o.x0), b = SX(o.x1);
  if (b < 0 || a > W) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(a, 0, b - a, H);
  ctx.fillStyle = R.protectFill;
  ctx.fill();
  ctx.clip();
  // diagonal hatch: "this ground must stay dry"
  ctx.beginPath();
  const gap = 18 * dpr;
  for (let x = a - H; x < b + H; x += gap) {
    ctx.moveTo(x, H); ctx.lineTo(x + H, 0);
  }
  ctx.strokeStyle = R.protectHatch;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.setLineDash(R.dash);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.moveTo(a, 0); ctx.lineTo(a, H);
  ctx.moveTo(b, 0); ctx.lineTo(b, H);
  ctx.strokeStyle = R.protectLine;
  ctx.lineWidth = Math.max(1, 1.5 * dpr);
  ctx.stroke();
  ctx.restore();

  labelAt(ctx, 'PROTECT', (a + b) * 0.5, zoneLabelY(), R.protectLine, true);
}

function drawBuildZone(ctx, level) {
  const bz = level && level.buildZone;
  if (!bz) return;
  const a = SX(bz.x0), b = SX(bz.x1);
  if (b < 0 || a > W) return;
  ctx.save();
  ctx.fillStyle = R.buildZoneFill;
  ctx.fillRect(a, 0, b - a, H);
  ctx.setLineDash(R.dash);
  ctx.beginPath();
  ctx.moveTo(a, 0); ctx.lineTo(a, H);
  ctx.moveTo(b, 0); ctx.lineTo(b, H);
  ctx.strokeStyle = R.buildZoneLine;
  ctx.lineWidth = Math.max(1, 1.5 * dpr);
  ctx.stroke();
  ctx.restore();
  const mid = (Math.max(a, 0) + Math.min(b, W)) * 0.5;
  labelAt(ctx, 'BUILD ZONE', mid, zoneLabelY(), R.buildZoneLine, true);
}

// ---- anchors ------------------------------------------------------------

function drawAnchors(ctx, terrain, build) {
  const list = terrain.anchors;
  if (!list || !list.length) return;
  const B = getBuilder();
  const dragging = build && !!(B && B.ghost);

  if (build) {                                   // snap-radius hint rings
    ctx.save();
    ctx.setLineDash(R.dash);
    ctx.lineWidth = Math.max(1, dpr);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const r = (a.r || CONFIG.build.anchorSnap) * zoom;
      if (r < 6 * dpr) continue;
      const px = SX(a.x), py = SY(a.y);
      if (px < -r || px > W + r) continue;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fillStyle = R.anchorHint;
      if (dragging) ctx.fill();
      ctx.strokeStyle = R.anchorHintLine;
      ctx.stroke();
    }
    ctx.restore();
  }

  const s = Math.max(R.anchorPx * dpr, Math.min(R.anchorPx * dpr * 2, 0.32 * zoom));
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const px = SX(a.x), py = SY(a.y);
    if (px < -20 * dpr || px > W + 20 * dpr) continue;
    // foundation pad
    ctx.fillStyle = R.anchorDark;
    ctx.beginPath();
    ctx.moveTo(px - s * 1.5, py + s * 0.9);
    ctx.lineTo(px + s * 1.5, py + s * 0.9);
    ctx.lineTo(px + s * 0.9, py - s * 0.5);
    ctx.lineTo(px - s * 0.9, py - s * 0.5);
    ctx.closePath();
    ctx.fill();
    // bolt head
    ctx.fillStyle = R.anchorColor;
    ctx.beginPath();
    ctx.arc(px, py, s * 0.72, 0, TAU);
    ctx.fill();
    ctx.fillStyle = R.anchorDark;
    ctx.fillRect(px - s * 0.42, py - s * 0.11, s * 0.84, Math.max(1, s * 0.22));
  }
}

// ---- members ------------------------------------------------------------

// One shared path builder: straight for most members, a cheap quadratic when a
// member is bowing under compression or a cable is hanging slack.
function memberPath(ctx, ax, ay, bx, by, sag) {
  const x0 = SX(ax), y0 = SY(ay), x1 = SX(bx), y1 = SY(by);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (sag === 0) { ctx.lineTo(x1, y1); return; }
  // Bow PERPENDICULAR to the member (in screen space), not along x — otherwise a
  // horizontal beam would show no bow at all. The perpendicular is flipped to
  // always point screen-downwards so a positive sag reads as sagging under load
  // whichever way round the member's endpoints happen to be stored.
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  // control point at twice the sagitta so the curve's midpoint lands on it
  ctx.quadraticCurveTo((x0 + x1) * 0.5 + nx * sag * 2, (y0 + y1) * 0.5 + ny * sag * 2, x1, y1);
}

// Perpendicular-offset restroke (highlight / grain), approximate on curves.
function offsetStroke(ctx, ax, ay, bx, by, sag, off, color, width, alpha) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const ox = nx * off, oy = ny * off;
  memberPath(ctx, ax + ox, ay + oy, bx + ox, by + oy, sag);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---- damage v2.1: bending + creep ---------------------------------------
//
// Contract fields (ARCHITECTURE §5): m.bendLoad, m.waterFx/waterFy,
// m.waterFperp. Every read here is guarded, because until stress.js lands they
// are all undefined — and with them undefined this file must draw EXACTLY what
// it drew before (no bow, no midspan clustering, no pulse).

// Bending is the mechanism that will break this member: bendLoad IS m.load.
function bendGoverns(m) {
  const bl = m.bendLoad;
  return bl > 0 && bl >= (m.load || 0) - 1e-6;
}

// Lateral bending bow, in SCREEN px, sign matching memberPath's sagitta.
//
// A long sealing member does not get crushed end-to-end — it gets pushed OUT OF
// LINE by the water standing behind it, and snaps in the middle. So the bow
// direction is taken from the water force itself (whose sign says which side the
// water is on) and the member visibly leans DOWNSTREAM. That is the whole tell:
// an axial buckle picks a hash-chosen side and means "shorten me", a bending bow
// always points away from the reservoir and means "brace my face".
function bendBow(m) {
  const bl = m.bendLoad;
  if (!(bl > R.bendBowFrom)) return 0;              // undefined, 0, or below cue
  const wfx = m.waterFx, wfy = m.waterFy;
  if (!isFinite(wfx) || !isFinite(wfy)) return 0;   // no side information: no bow
  const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return 0;
  const ux = dx / len, uy = dy / len;
  // memberPath's positive sagitta direction, written in WORLD axes: it builds
  // the screen perpendicular then flips it screen-downwards, which comes out as
  // (uy, −ux) for a left-to-right member and (−uy, ux) for a right-to-left one.
  const s = ux < 0 ? -1 : 1;
  const perp = (wfx * uy - wfy * ux) * s;
  if (perp === 0) return 0;
  // Longer spans bow more for the same utilisation (sagitta ~ w·L⁴/EI against a
  // capacity ~ 1/L², so the *look* has to grow with length or every member
  // bends by the same 3 px and length stops reading).
  const lenF = Math.min(R.bendBowLenMax, len / R.bendBowRefLen);
  let sag = R.bendBowMax * Math.min(R.bendBowCap, bl) * lenF;
  const cap = len * R.bendBowLenFrac;               // never a banana
  if (sag > cap) sag = cap;
  return sag * zoom * (perp > 0 ? 1 : -1);
}

// Sagitta in SCREEN px, applied perpendicular to the member by memberPath.
// A slack cable hangs (positive = downwards); a compressed beam buckles to one
// deterministic side, so it never flickers between sides frame to frame; a
// member bent by water pressure leans downstream, and that bow WINS — two bows
// on one member fight each other and read as noise.
function bowFor(m) {
  if (m.mat && m.mat.tensionOnly) {
    const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    if (m.restLength - len <= R.cableSlackMin) return 0;
    return Math.sqrt(Math.max(0, m.restLength * m.restLength - len * len)) * R.cableSagScale * zoom;
  }
  const bend = bendBow(m);
  if (bend !== 0) return bend;
  // m.load is max(axial, bending) in v2.1, so a bending-governed member must not
  // be allowed to inflate the AXIAL bow with a number that is not axial.
  // (bendLoad undefined ⇒ comparison false ⇒ exactly the v1 behaviour.)
  const axial = m.bendLoad >= m.load ? 0 : m.load;
  if (m.loadSign > 0 || axial < R.stressFrom) return 0;
  const dir = frac(hashStr(m.id), 3) < 0.5 ? -1 : 1;
  return R.bowMax * Math.min(1.2, axial) * zoom * dir;
}

// ---- creep tracking -----------------------------------------------------
//
// "This member is degrading RIGHT NOW" is not readable from one frame: damage is
// a level, not a rate. So sample it once per frame and remember who grew, for
// creepHold seconds of sim time (quantised deltas would otherwise strobe).
//
// This has to be its OWN pass rather than a side effect of drawMember, because
// drawMember runs twice a frame for a stressed member (base pass, then
// renderStressOverlay over the water) and the second call would compare the
// damage against its own sample and conclude that nothing is happening.
const creepD = new Map();       // member id -> damage as of the last sample
const creepUntil = new Map();   // member id -> sim time the cue expires
let creepT = -1;

function resetCreep() { creepD.clear(); creepUntil.clear(); creepT = -1; }

function sampleCreep(structure, time) {
  if (time === creepT) return;                          // already sampled
  if (time < creepT) resetCreep();                      // retry rewound the clock
  const ms = structure.members;
  if (creepD.size > ms.length * 4 + 64) resetCreep();   // ids churned (level change)
  creepT = time;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const d = m.damage > 0 ? m.damage : 0;
    const prev = creepD.get(m.id);
    creepD.set(m.id, d);
    if (prev !== undefined && d > prev + R.creepEps) creepUntil.set(m.id, time + R.creepHold);
  }
}

function isCreeping(m, time) {
  const until = creepUntil.get(m.id);
  return until !== undefined && until >= time;
}

function drawMember(ctx, m, time, withDetail) {
  const mat = m.mat;
  const ax = m.a.x, ay = m.a.y, bx = m.b.x, by = m.b.y;
  const px0 = SX(ax), px1 = SX(bx);
  if ((px0 < 0 && px1 < 0) || (px0 > W && px1 > W)) return;

  const width = Math.max(R.memberMinPx * dpr, (mat.thickness || 0.3) * zoom);
  const sag = bowFor(m);
  const detail = withDetail && width >= 5 * dpr;
  const load = m.load || 0;
  const step = stressStep(load);
  const pal = paletteFor(mat);
  const color = m.loadSign > 0 ? pal.t[step] : pal.c[step];

  ctx.lineCap = 'butt';

  // ---- creep: a SLOW amber halo under the member ------------------------
  // Deliberately unlike the fast white flash below: "this is being eaten right
  // now, and it will go even if the load never rises" is a different warning
  // from "this is overloaded right now", and the two must be tellable apart
  // without reading a number. Phase is hashed per member off the SIM clock, so
  // a wall of creeping timber shimmers instead of blinking in lockstep — and a
  // replay of the same run looks identical.
  if (isCreeping(m, time)) {
    const p = 0.5 + 0.5 * Math.sin(time * R.creepPulseHz * TAU + frac(hashStr(m.id), 11) * TAU);
    memberPath(ctx, ax, ay, bx, by, sag);
    ctx.globalAlpha = R.creepPulseAlpha * (0.3 + 0.7 * p);
    ctx.strokeStyle = R.creepPulseColor;
    // The halo BREATHES — width as well as alpha. On a thin member at desktop
    // dpr an alpha-only pulse is a few faint pixels nobody catches out of the
    // corner of an eye; a moving edge is seen without being looked at.
    ctx.lineWidth = width + R.creepPulsePx * dpr * 2 * (0.55 + 0.45 * p);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  if (detail) {                                   // dark outline for crispness
    memberPath(ctx, ax, ay, bx, by, sag);
    ctx.strokeStyle = R.memberOutline;
    ctx.lineWidth = width + R.memberOutlinePx * dpr * 2;
    ctx.stroke();
  }

  memberPath(ctx, ax, ay, bx, by, sag);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();

  if (detail) {
    if (mat.id === 'timber') {
      offsetStroke(ctx, ax, ay, bx, by, sag, 0, mat.darkColor, width * 0.16, R.grainAlpha);
      offsetStroke(ctx, ax, ay, bx, by, sag, (width * 0.3) / zoom, mat.darkColor, width * 0.1, R.grainAlpha * 0.8);
    } else if (mat.id === 'steel') {
      offsetStroke(ctx, ax, ay, bx, by, sag, (-width * 0.3) / zoom, '#ffffff', width * 0.22, R.highlightAlpha);
    } else if (mat.id === 'concrete') {
      offsetStroke(ctx, ax, ay, bx, by, sag, (width * 0.34) / zoom, mat.darkColor, width * 0.28, 0.5);
    }
  }

  // ---- non-colour stress channels -------------------------------------
  if (load > R.stressWarn) {
    const flash = 0.5 + 0.5 * Math.sin(time * R.flashHz * TAU);
    memberPath(ctx, ax, ay, bx, by, sag);
    ctx.globalAlpha = 0.18 + 0.5 * flash;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, width * 0.34);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (m.damage > 0.02) drawCracks(ctx, m, ax, ay, bx, by, width);
}

// Small perpendicular ticks whose count grows with accumulated damage: a
// colour-blind-safe read of "this is about to go".
//
// WHERE they sit is information too. Axial damage is spread along the member, so
// the ticks are spread. Bending damage is a moment that peaks at MIDSPAN — that
// is where the member will actually part — so a bending-governed member gets its
// ticks clustered in the middle, pointing at the break before it happens.
function drawCracks(ctx, m, ax, ay, bx, by, width) {
  const count = Math.min(R.crackTicksMax, Math.ceil(m.damage * R.crackTicksMax));
  if (count <= 0) return;
  const midspan = bendGoverns(m);
  const seed = hashStr(m.id);
  const x0 = SX(ax), y0 = SY(ay), x1 = SX(bx), y1 = SY(by);
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const tick = Math.max(R.crackLenPx * dpr, width * 0.8);
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const f = frac(seed, i * 13 + 1);
    const t = midspan ? 0.5 + (f - 0.5) * R.bendCrackSpread : 0.15 + 0.7 * f;
    const mx = x0 + dx * t, my = y0 + dy * t;
    const l = tick * (0.55 + 0.45 * frac(seed, i * 29 + 5));
    ctx.moveTo(mx - nx * l * 0.5, my - ny * l * 0.5);
    ctx.lineTo(mx + nx * l * 0.5, my + ny * l * 0.5);
  }
  ctx.strokeStyle = R.crackColor;
  ctx.lineWidth = Math.max(1, dpr * 1.2);
  ctx.stroke();
}

function drawStructure(ctx, structure, time) {
  const members = structure.members;
  const B = getBuilder();
  const sel = B ? B.selection : null;

  sampleCreep(structure, time);     // once per frame, before anything draws

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (m.broken || !m.mat) continue;
    if (m.id === sel) highlightMember(ctx, m, R.selectColor, 0.32);
    drawMember(ctx, m, time, true);
  }
  drawNodes(ctx, structure.nodes, true);
}

function drawDebris(ctx, structure) {
  const list = structure.debris;
  if (!list || !list.length) return;
  ctx.save();
  ctx.globalAlpha = R.debrisAlpha;
  ctx.lineCap = 'butt';
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d.mat) continue;
    const px0 = SX(d.a.x), px1 = SX(d.b.x);
    if ((px0 < 0 && px1 < 0) || (px0 > W && px1 > W)) continue;
    memberPath(ctx, d.a.x, d.a.y, d.b.x, d.b.y, 0);
    ctx.strokeStyle = d.mat.darkColor || R.brokenColor;
    ctx.lineWidth = Math.max(R.memberMinPx * dpr, (d.mat.thickness || 0.3) * zoom * 0.9);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNodes(ctx, nodes, physics) {
  const r = R.nodePx * dpr;
  if (r < 1.5) return;
  // free nodes: one path, one fill
  ctx.beginPath();
  let any = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (physics ? n.anchored : n.anchorId) continue;
    const px = SX(n.x), py = SY(n.y);
    if (px < -r || px > W + r) continue;
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, TAU);
    any = true;
  }
  if (any) { ctx.fillStyle = R.nodeColor; ctx.fill(); }

  // anchored nodes: square bolt plates so a foundation reads differently
  const s = r * 1.5;
  ctx.beginPath();
  any = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (physics ? !n.anchored : !n.anchorId) continue;
    const px = SX(n.x), py = SY(n.y);
    if (px < -s || px > W + s) continue;
    ctx.rect(px - s, py - s, s * 2, s * 2);
    any = true;
  }
  if (any) { ctx.fillStyle = R.anchorColor; ctx.fill(); }
}

function highlightMember(ctx, m, color, alpha) {
  memberPath(ctx, m.a.x, m.a.y, m.b.x, m.b.y, 0);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(6 * dpr, ((m.mat && m.mat.thickness) || 0.3) * zoom + R.selectPx * dpr * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// ---- design (build phase) ----------------------------------------------

function drawDesign(ctx, design) {
  if (!design || !design.members.length) { if (design) drawDesignNodes(ctx, design); return; }
  const B = getBuilder();
  const sel = B ? B.selection : null;
  const hov = B ? B.hoverMember : null;
  const doomed = marqueeSet(B);
  const byId = nodeIndex(design);

  for (let i = 0; i < design.members.length; i++) {
    const dm = design.members[i];
    const a = byId[dm.a], b = byId[dm.b];
    const mat = MATERIALS[dm.mat];
    if (!a || !b || !mat) continue;
    // "about to be deleted" outranks both selection and hover: it is the only
    // one of the three that is about to destroy the player's work.
    const dead = doomed !== null && doomed.has(dm.id);
    if (dead) highlightMemberXY(ctx, a, b, mat, R.marqueeHitColor, R.marqueeHitAlpha);
    else if (dm.id === sel) highlightMemberXY(ctx, a, b, mat, R.selectColor, 0.34);
    else if (dm.id === hov) highlightMemberXY(ctx, a, b, mat, R.selectColor, 0.14);
    strokeFlat(ctx, a.x, a.y, b.x, b.y, mat);
    // ... plus a dashed overstroke ON the member. The halo alone is a colour
    // channel and nothing else; the dashes survive being small, being over a
    // busy backdrop, and being looked at by a colour-blind player.
    if (dead) dashOverMember(ctx, a, b, mat);
  }
  drawDesignNodes(ctx, design);
}

function dashOverMember(ctx, a, b, mat) {
  ctx.save();
  ctx.setLineDash(R.marqueeDash);
  memberPath(ctx, a.x, a.y, b.x, b.y, 0);
  ctx.globalAlpha = R.marqueeHitDashAlpha;
  ctx.strokeStyle = R.marqueeHitColor;
  ctx.lineWidth = Math.max(1.5, Math.min(3.5 * dpr, ((mat && mat.thickness) || 0.3) * zoom * 0.55));
  ctx.stroke();
  ctx.restore();
}

// design nodes are plain objects; a tiny reused index avoids Map churn
let idxCache = null, idxDesign = null, idxCount = -1;

function nodeIndex(design) {
  if (idxDesign === design && idxCount === design.nodes.length) return idxCache;
  const map = Object.create(null);
  for (let i = 0; i < design.nodes.length; i++) map[design.nodes[i].id] = design.nodes[i];
  idxCache = map; idxDesign = design; idxCount = design.nodes.length;
  return map;
}

function strokeFlat(ctx, ax, ay, bx, by, mat) {
  const width = Math.max(R.memberMinPx * dpr, (mat.thickness || 0.3) * zoom);
  const detail = width >= 5 * dpr;
  ctx.lineCap = 'butt';
  if (detail) {
    memberPath(ctx, ax, ay, bx, by, 0);
    ctx.strokeStyle = R.memberOutline;
    ctx.lineWidth = width + R.memberOutlinePx * dpr * 2;
    ctx.stroke();
  }
  memberPath(ctx, ax, ay, bx, by, 0);
  ctx.strokeStyle = mat.color;
  ctx.lineWidth = width;
  ctx.stroke();
  if (!detail) return;
  if (mat.id === 'timber') {
    offsetStroke(ctx, ax, ay, bx, by, 0, 0, mat.darkColor, width * 0.16, R.grainAlpha);
  } else if (mat.id === 'steel') {
    offsetStroke(ctx, ax, ay, bx, by, 0, (-width * 0.3) / zoom, '#ffffff', width * 0.22, R.highlightAlpha);
  } else if (mat.id === 'concrete') {
    offsetStroke(ctx, ax, ay, bx, by, 0, (width * 0.34) / zoom, mat.darkColor, width * 0.28, 0.5);
  }
}

function highlightMemberXY(ctx, a, b, mat, color, alpha) {
  memberPath(ctx, a.x, a.y, b.x, b.y, 0);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(6 * dpr, (mat.thickness || 0.3) * zoom + R.selectPx * dpr * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

function drawDesignNodes(ctx, design) {
  drawNodes(ctx, design.nodes, false);
}

// ---- ghost + snap feedback ---------------------------------------------

function drawGhost(ctx) {
  const B = getBuilder();
  if (!B) return;

  if (B.hover && (B.tool === 'erase' || B.tool === 'boxdelete')) {
    const px = SX(B.hover.x), py = SY(B.hover.y);
    ctx.save();
    ctx.setLineDash(R.dash);
    ctx.strokeStyle = R.ghostBad;
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.beginPath();
    if (B.tool === 'boxdelete') {
      // A dashed SQUARE, not the eraser's circle, and the same shape as the
      // toolbar icon: the cursor tells you the gesture is "drag a box" before
      // you have dragged anything. (A bare tap here still erases one member —
      // that is the tool's fallback — so the cursor stays a delete cue.)
      const s = R.marqueeCursorPx * dpr;
      ctx.rect(px - s, py - s, s * 2, s * 2);
    } else {
      ctx.arc(px, py, Math.max(10 * dpr, CONFIG.build.hitPx * dpr * 0.8), 0, TAU);
    }
    ctx.stroke();
    ctx.restore();
  }

  const g = B.ghost;
  if (!g) {
    if (B.hover && B.hover.snap) snapMark(ctx, B.hover.snap, 0.5);
    return;
  }

  const mat = MATERIALS[g.mat] || MATERIALS[B.material];
  const color = g.ok ? R.ghostOk : R.ghostBad;
  const width = Math.max(R.memberMinPx * dpr, ((mat && mat.thickness) || 0.3) * zoom);

  ctx.save();
  ctx.globalAlpha = R.ghostAlpha;
  memberPath(ctx, g.x0, g.y0, g.x1, g.y1, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash(R.dash);
  memberPath(ctx, g.x0, g.y0, g.x1, g.y1, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();
  ctx.restore();

  if (g.start) snapMark(ctx, g.start, 1);
  if (g.end) snapMark(ctx, g.end, 1);

  // floating label: length + cost, or why it is refused
  const txt = g.ok
    ? g.len.toFixed(1) + ' m  ·  $' + Math.round(g.cost)
    : (g.reason ? String(g.reason).toUpperCase() : 'CANNOT BUILD');
  labelAt(ctx, txt, SX(g.x1), SY(g.y1) - 20 * dpr, g.ok ? R.ghostOk : R.ghostBad, false);
}

// ---- touch building v3: chain head + lifted node ------------------------
//
// Both are read from getBuilder() and nowhere else: the builder owns what the
// gesture MEANS, this file only says what it looks like.

// The joint the next touch press will build from. It pulses because it is the
// one mark on screen that is a PROMISE rather than a fact — and because it is
// also the button that ends the run ("tap the glowing joint to finish"). Drawn
// even when the head is PENDING, i.e. a point the player has claimed that is
// not a design node yet: without this, the first tap of a chain would appear to
// do nothing at all.
function drawChainHead(ctx) {
  const B = getBuilder();
  const h = B && B.chainHead;
  if (!h || !isFinite(h.x) || !isFinite(h.y)) return;
  const px = SX(h.x), py = SY(h.y);
  const pad = 40 * dpr;
  if (px < -pad || px > W + pad || py < -pad || py > H + pad) return;

  const breath = Math.sin((frames % R.chainHeadPulseFrames) / R.chainHeadPulseFrames * TAU);
  const r = R.chainHeadPx * dpr * (1 + R.chainHeadPulse * breath);

  ctx.save();
  ctx.globalAlpha = R.chainHeadAlpha;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, TAU);
  ctx.strokeStyle = R.chainHeadColor;
  ctx.lineWidth = Math.max(1.5, R.chainHeadLinePx * dpr);
  ctx.stroke();
  // solid core: a pending head is not in design.nodes, so nothing else draws it
  ctx.beginPath();
  ctx.arc(px, py, Math.max(1.6, R.nodePx * dpr * 0.85), 0, TAU);
  ctx.fillStyle = R.chainHeadColor;
  ctx.fill();
  ctx.restore();
}

// A node in the air. The members already follow it (the builder moves the design
// node itself), so all this adds is "you are holding this one" — and RED the
// moment the drop would be illegal, with the reason spelled out in the ghost's
// own voice.
function drawLiftedNode(ctx) {
  const B = getBuilder();
  const nd = B && B.nodeDrag;
  if (!nd || !isFinite(nd.x) || !isFinite(nd.y)) return;
  const px = SX(nd.x), py = SY(nd.y);
  const col = nd.ok ? R.dragNodeColor : R.ghostBad;
  const r = R.dragNodePx * dpr;

  ctx.save();
  ctx.globalAlpha = R.dragNodeGlowAlpha;
  ctx.beginPath();
  ctx.arc(px, py, r + R.dragNodeGlowPx * dpr, 0, TAU);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, TAU);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();

  if (!nd.ok && nd.reason) {
    labelAt(ctx, String(nd.reason).toUpperCase(), px, py - 20 * dpr, R.ghostBad, true);
  }
}

// ---- box-delete marquee -------------------------------------------------
//
// builder.js publishes getBuilder().marquee = {x0,y0,x1,y1} (world, already
// normalized so x0<x1 and y0<y1) plus marqueeHits = [memberId,...] while the
// box-delete drag is live, and null/[] otherwise — including for the first ~6px
// of travel, before the gesture has committed to being a box rather than a tap.
// So "no marquee" is a completely normal state and is simply not drawn.

// The hit list is rebuilt from scratch on every pointer move, so it is a fresh
// array each time and cannot be cached by identity for long — but it CAN be
// cached within a frame-pair (render + any overlay pass), which is what saves
// re-hashing a hundred ids twice per frame. Reused Set, no allocation.
const doomedSet = new Set();
let doomedSrc = null;

function marqueeSet(B) {
  const list = B && B.marqueeHits;
  if (!list || !list.length) { doomedSrc = null; return null; }
  if (doomedSrc === list) return doomedSet;
  doomedSet.clear();
  for (let i = 0; i < list.length; i++) doomedSet.add(list[i]);
  doomedSrc = list;
  return doomedSet;
}

function drawMarquee(ctx) {
  const B = getBuilder();
  const m = B && B.marquee;
  if (!m) return;
  if (!isFinite(m.x0) || !isFinite(m.y0) || !isFinite(m.x1) || !isFinite(m.y1)) return;

  // World y is up, screen y is down: y1 (the larger world y) is the TOP edge.
  const x = SX(m.x0), y = SY(m.y1);
  const w = SX(m.x1) - x, h = SY(m.y0) - y;
  if (!(w >= R.marqueeMinPx) || !(h >= R.marqueeMinPx)) return;
  if (x > W || y > H || x + w < 0 || y + h < 0) return;

  ctx.save();
  ctx.fillStyle = R.marqueeFill;
  ctx.fillRect(x, y, w, h);
  ctx.setLineDash(R.marqueeDash);
  ctx.lineDashOffset = 0;              // deterministic: no marching ants
  ctx.strokeStyle = R.marqueeLine;
  ctx.lineWidth = Math.max(1, 1.6 * dpr);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  // The count is the whole reason to look at the box: "this will take 7 beams"
  // is the difference between a confident drag and an undo.
  const n = (B.marqueeHits && B.marqueeHits.length) || 0;
  if (n > 0) {
    labelAt(ctx, n === 1 ? 'DELETE 1 BEAM' : 'DELETE ' + n + ' BEAMS',
      x + w * 0.5, Math.max(R.labelFontPx * dpr + 4 * dpr, y - 6 * dpr), R.marqueeLine, true);
  }
}

// A ring whose look says what the endpoint snapped to.
function snapMark(ctx, snap, alpha) {
  if (!snap) return;
  const kind = snap.kind || (snap.nodeId ? 'node' : snap.anchorId ? 'anchor' : 'grid');
  const px = SX(snap.x), py = SY(snap.y);
  const r = (kind === 'grid' ? 3.2 : 5.2) * dpr;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, TAU);
  ctx.strokeStyle = kind === 'anchor' ? R.anchorColor : kind === 'node' ? R.nodeColor : R.buildZoneLine;
  ctx.lineWidth = Math.max(1, 1.6 * dpr);
  ctx.stroke();
  if (kind === 'anchor') {
    ctx.beginPath();
    ctx.moveTo(px - r * 1.9, py); ctx.lineTo(px + r * 1.9, py);
    ctx.moveTo(px, py - r * 1.9); ctx.lineTo(px, py + r * 1.9);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- canvas text --------------------------------------------------------

let fontPx = -1, fontStr = '';

function useFont(ctx, px) {
  if (fontPx !== px) {
    fontPx = px;
    fontStr = '600 ' + px + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
  }
  ctx.font = fontStr;
}

function labelAt(ctx, text, px, py, fg, centered) {
  const size = Math.round(R.labelFontPx * dpr);
  useFont(ctx, size);
  const pad = R.labelPadPx * dpr;
  const w = ctx.measureText(text).width;
  let x = centered ? px - w * 0.5 : px + pad * 2;
  const y = py;
  x = Math.max(pad, Math.min(W - w - pad, x));
  ctx.save();
  ctx.fillStyle = R.labelBg;
  ctx.fillRect(x - pad, y - size, w + pad * 2, size + pad * 1.4);
  ctx.fillStyle = fg || R.labelFg;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y + pad * 0.2);
  ctx.restore();
}
