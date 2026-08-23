// OPUS C owns. Bulk water rendering. Contract §9.
//
// WATER v2: the water IS the particles (physics/fluid.js), so this pass draws
// the particles — not the derived column heightfield. The old height columns
// could only ever describe "how much water is above cell i", which is a lie for
// everything the PIC/FLIP solver now does: a mid-air wave crest became a solid
// teal mountain, a falling stream read as a 12 m deep column, and a lone
// droplet became a 0.4 m wide square of reservoir.
//
// TECHNIQUE — 2-D metaballs, three offscreen layers at ~half device resolution:
//
//   acc   coverage mask. Every visible particle is one cached radial-gradient
//         sprite (Blinn kernel) drawn with 'lighter', so overlapping particles
//         ADD and fuse. The field is then blurred by half a particle spacing
//         and gained ×4 by 'lighter' self-blits: the blur removes the lattice
//         ripple, the clamped gain is the threshold that turns a cloud of soft
//         dots into one body with a defined edge. Interior cells (a dense 3×3
//         block of the coarse occupancy grid) are filled as merged rectangles
//         instead of per-particle sprites — same silhouette, a third of the
//         draws on a full reservoir.
//
//   sc    scratch. Depth is measured by MORPHOLOGY, never by a column height:
//         a stack of downward-shifted copies of the mask (one per depth band)
//         eroded once horizontally and clipped back to the body. The horizontal
//         term is what keeps a falling nappe or a jet light and airy while a
//         reservoir goes dark and saturated — a purely vertical measure paints
//         a 10 m waterfall as deep water, because it does have water above it.
//         The same buffer then builds the foam (fast particles at the surface,
//         clipped to the body) and the free surface band (mask − mask↓s, ∩ the
//         mask pushed up, so a one-particle trickle gets no waterline).
//
//   out   the composite: body colour, then depth tint, then foam, then the
//         surface band twice — once offset and dim as sky sheen, once in place
//         and bright as the waterline. Alpha compositing is associative, so
//         building the whole stack offscreen and blitting ONCE (upscaled,
//         smoothed) is identical to five separate blits and far cheaper.
//
// Every pass is confined to the dirty rectangle — the particle bounding box
// grown by the kernel, the blur and the largest shift — which is what makes
// the whole thing cost about a third of the screen instead of all of it.
//
// The body's base alpha is deliberately low and the depth bands are what add
// opacity, so a puddle or a wave tongue shows the bed through it while a deep
// reservoir reads heavy. Nothing is drawn below ground: the whole pass is
// clipped to the region above the terrain polyline.
//
// RETIRED here: the hand-traced overtopping nappe and the breach jet arcs. Both
// were ballistic sheets drawn from measured flux because the old heightfield
// could not show water leaving the dam. The fluid does it now, and the two
// disagreed with each other on screen.
//
// Deterministic: no Math.random anywhere (decorative randomness lives in
// effects.js). Allocation-free per frame — sprites, buffers and the occupancy
// grid are all cached and reused.

import { CONFIG } from '../config.js';
import { renderStressOverlay } from './renderer.js';

const R = CONFIG.render;
const TAU = Math.PI * 2;

let W = 0, H = 0, cx = 0, cy = 0;
let camX = 0, camY = 0, zoom = 1, shX = 0, shY = 0, dpr = 1;

const SX = (x) => (x - camX) * zoom + cx + shX;
const SY = (y) => cy - (y - camY) * zoom + shY;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function beginFrame(ctx, cam) {
  W = ctx.canvas.width; H = ctx.canvas.height;
  cx = W * 0.5; cy = H * 0.5;
  camX = cam.x; camY = cam.y; zoom = cam.zoom;
  shX = cam.shakeX || 0; shY = cam.shakeY || 0;
  const cw = ctx.canvas.clientWidth;
  const d = cw > 0 ? W / cw : 1;
  dpr = d > 0.1 && d < 8 ? d : 1;
}

// ---- offscreen layers ----------------------------------------------------

let buf = null;              // {w,h,sx,sy,c:{},g:{}}
let offscreenOk = true;      // false under the Node test stubs (no getContext)

function newCanvas(w, h) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let c = null;
  try { c = document.createElement('canvas'); } catch (e) { return null; }
  if (!c || typeof c.getContext !== 'function') return null;
  c.width = w; c.height = h;
  let g = null;
  try { g = c.getContext('2d'); } catch (e) { return null; }
  if (!g || typeof g.drawImage !== 'function' || typeof g.createRadialGradient !== 'function') return null;
  return { c, g };
}

const LAYERS = ['acc', 'sc', 'out'];

function ensureBuffers() {
  if (!offscreenOk || !(W > 0) || !(H > 0)) return null;
  const s = clamp(R.blobBufScale, 0.15, 1);
  const w = Math.max(8, Math.round(W * s));
  const h = Math.max(8, Math.round(H * s));
  if (buf && buf.w === w && buf.h === h) return buf;
  const made = { w, h, sx: w / W, sy: h / H, c: {}, g: {} };
  for (let i = 0; i < LAYERS.length; i++) {
    const o = newCanvas(w, h);
    if (!o) { offscreenOk = false; buf = null; return null; }
    made.c[LAYERS[i]] = o.c;
    made.g[LAYERS[i]] = o.g;
    o.g.imageSmoothingEnabled = true;
  }
  buf = made;
  return buf;
}

// ---- cached sprites -----------------------------------------------------
// Diameters in buffer pixels. All particles share one radius, so the sprite is
// chosen ONCE per frame, not per particle.

const LADDER = [4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
let bodySprites = null, foamSprites = null;

function makeSprite(size, stops) {
  const o = newCanvas(size, size);
  if (!o) return null;
  const r = size * 0.5;
  const grad = o.g.createRadialGradient(r, r, 0, r, r, r);
  for (let i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
  o.g.fillStyle = grad;
  o.g.fillRect(0, 0, size, size);
  return o.c;
}

// The falloff profile IS the metaball kernel: Blinn's (1 − t²)³, sampled as
// gradient stops. The shape matters more than it looks: what makes the water
// read as a SURFACE rather than a fog bank is that the clamped gain saturates
// exactly where this kernel is steepest (t ≈ 0.45), so the alpha ramp from
// body to air is spatially thin. A kernel with a long flat tail (the obvious
// first guess) puts that transition out where the falloff is nearly flat, and
// every blob then wears a wide grey halo — measured: a 15 px fuzzy crust along
// the whole shoreline.
const BODY_STOPS = [
  [0, 'rgba(255,255,255,1)'],
  [0.2, 'rgba(255,255,255,0.885)'],
  [0.4, 'rgba(255,255,255,0.593)'],
  [0.5, 'rgba(255,255,255,0.422)'],
  [0.6, 'rgba(255,255,255,0.262)'],
  [0.7, 'rgba(255,255,255,0.133)'],
  [0.8, 'rgba(255,255,255,0.047)'],
  [0.9, 'rgba(255,255,255,0.007)'],
  [1, 'rgba(255,255,255,0)'],
];
const FOAM_STOPS = [
  [0, 'rgba(255,255,255,0.95)'],
  [0.5, 'rgba(255,255,255,0.42)'],
  [1, 'rgba(255,255,255,0)'],
];

function ladderFor(cache, stops, diameter) {
  if (!cache) return null;
  let i = 0;
  while (i < LADDER.length - 1 && LADDER[i] < diameter) i++;
  let s = cache[i];
  if (s === undefined) {
    s = makeSprite(LADDER[i], stops);
    cache[i] = s;
  }
  return s;
}

function bodySprite(diameter) {
  if (!bodySprites) bodySprites = new Array(LADDER.length);
  return ladderFor(bodySprites, BODY_STOPS, diameter);
}

function foamSprite(diameter) {
  if (!foamSprites) foamSprites = new Array(LADDER.length);
  return ladderFor(foamSprites, FOAM_STOPS, diameter);
}

// ---- coarse occupancy grid ----------------------------------------------
// One pass over the visible particles gives three things at once: the interior
// cells that can be fused into rectangles, a wetness probe for the structure
// overlay, and the water/ground contact shading.

let gCell = 1, gX0 = 0, gY0 = 0, gNX = 0, gNY = 0;
let gCount = null, gInner = null, gCellOf = null;
let gReady = false;
let gMinX = 0, gMaxX = 0, gMinY = 0, gMaxY = 0;   // world bbox of visible water

function buildGrid(water, count) {
  gReady = false;
  gNX = 0; gNY = 0;
  if (!count) return;
  const spacing = particleSpacing(water);
  // never finer than a few device pixels: at far zoom the cell count, not the
  // particle count, would be what costs
  const cell = Math.max(spacing * R.blobRadiusMul, R.blobGridMinPx / Math.max(0.05, zoom));
  const mx = (cx + Math.abs(shX)) / zoom + cell * 2;
  const my = (cy + Math.abs(shY)) / zoom + cell * 2;
  const nx = Math.ceil((2 * mx) / cell), ny = Math.ceil((2 * my) / cell);
  if (!(nx > 0) || !(ny > 0) || nx * ny > R.blobGridMaxCells) return;

  const n = nx * ny;
  if (!gCount || gCount.length < n) {
    gCount = new Int32Array(n);
    gInner = new Uint8Array(n);
  } else {
    gCount.fill(0, 0, n);
    gInner.fill(0, 0, n);
  }
  if (!gCellOf || gCellOf.length < count) gCellOf = new Int32Array(Math.max(count, 4096));

  gCell = cell; gNX = nx; gNY = ny;
  gX0 = camX - mx; gY0 = camY - my;

  const px = water.ppx, py = water.ppy;
  const inv = 1 / cell;
  gMinX = Infinity; gMaxX = -Infinity; gMinY = Infinity; gMaxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const ix = ((px[i] - gX0) * inv) | 0;
    const iy = ((py[i] - gY0) * inv) | 0;
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || px[i] < gX0 || py[i] < gY0) { gCellOf[i] = -1; continue; }
    const c = iy * nx + ix;
    gCellOf[i] = c;
    gCount[c]++;
    // world bbox of the visible water: everything downstream of here works on
    // that rectangle instead of the whole canvas, which is most of the win on a
    // level where the reservoir fills a third of the screen
    if (px[i] < gMinX) gMinX = px[i];
    if (px[i] > gMaxX) gMaxX = px[i];
    if (py[i] < gMinY) gMinY = py[i];
    if (py[i] > gMaxY) gMaxY = py[i];
  }

  // A cell is INTERIOR when it and all eight neighbours hold enough particles
  // to be genuinely full — then its own rectangle is inside the disc union and
  // its particles add nothing to the silhouette.
  const full = (cell / spacing) * (cell / spacing);
  const K = Math.max(R.blobFuseMin, Math.ceil(full * R.blobFuseFrac));
  if (R.blobFuse) {
    for (let iy = 1; iy < ny - 1; iy++) {
      const row = iy * nx;
      for (let ix = 1; ix < nx - 1; ix++) {
        const c = row + ix;
        if (gCount[c] < K) continue;
        if (gCount[c - 1] < K || gCount[c + 1] < K) continue;
        const up = c - nx, dn = c + nx;
        if (gCount[up] < K || gCount[dn] < K) continue;
        if (gCount[up - 1] < K || gCount[up + 1] < K) continue;
        if (gCount[dn - 1] < K || gCount[dn + 1] < K) continue;
        gInner[c] = 1;
      }
    }
  }
  gReady = true;
}

// Wetness probe for renderer.renderStressOverlay: "is there water AT this
// point", straight from the particles. The derived depth column cannot answer
// this any more — a waterfall plume makes a dry downstream slope report metres
// of depth.
function wetAt(x, y) {
  if (!gReady) return false;
  const ix = ((x - gX0) / gCell) | 0;
  const iy = ((y - gY0) / gCell) | 0;
  if (ix < 0 || ix >= gNX || iy < 0 || iy >= gNY || x < gX0 || y < gY0) return false;
  return gCount[iy * gNX + ix] > 0;
}

// Is this cell within one cell of the free surface (nothing, or almost nothing,
// directly above it)? Used to keep foam on the skin of the water.
function atSurface(cellId) {
  const up = cellId + gNX;
  if (up >= gNX * gNY) return true;
  return gCount[up] === 0;
}

function particleSpacing(water) {
  const f = water.fluid;
  if (f && f.spacing > 0) return f.spacing;
  if (water.pradius > 0) return water.pradius / Math.max(0.05, CONFIG.fluid.radiusFrac);
  return CONFIG.fluid.spacing;
}

// ---- entry point --------------------------------------------------------

// Per-frame cost readout for the F2 overlay and the headless perf runs. Two
// timestamps a frame; nothing else in here is allowed to allocate.
const stat = { ms: 0, particles: 0, sprites: 0, fused: 0, buf: 0, dirty: 0, offscreen: true };
export function stats() {
  stat.buf = buf ? buf.w : 0;
  stat.offscreen = offscreenOk;
  return stat;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function render(ctx, cam, water, S) {
  if (!water) return;
  const t0 = nowMs();
  beginFrame(ctx, cam);

  const count = water.pcount | 0;
  stat.particles = count;
  stat.sprites = 0;
  stat.fused = 0;
  buildGrid(water, count);

  ctx.save();
  clipAboveTerrain(ctx, S && S.terrain);
  if (count > 0) {
    const b = ensureBuffers();
    if (b) drawBody(ctx, water, count, b);
    else drawBodyFallback(ctx, water, count);
  }
  drawBedContact(ctx, S && S.terrain);
  ctx.restore();
  stat.ms = nowMs() - t0;

  // failing / submerged members must stay readable through the water
  renderStressOverlay(ctx, cam, S, gReady ? wetAt : null);
}

// ---- the water body -----------------------------------------------------

function drawBody(ctx, water, count, b) {
  const bw = b.w, bh = b.h, bsx = b.sx, bsy = b.sy;
  const gAcc = b.g.acc, gSc = b.g.sc, gOut = b.g.out;

  const spacing = particleSpacing(water);
  const rW = spacing * R.blobRadiusMul;                     // kernel radius, metres
  let rB = rW * zoom * bsx;                                 // ... in buffer px
  if (rB < R.blobMinBufPx) rB = R.blobMinBufPx;             // far-zoom LOD
  const dia = rB * 2;
  const sprite = bodySprite(dia);
  if (!sprite) { offscreenOk = false; drawBodyFallback(ctx, water, count); return; }

  const bands = R.blobDepthBands, alphas = R.blobDepthAlphas;
  const blurPx = spacing * R.blobSmooth * zoom * bsx;
  const rimPx = Math.max(1, R.blobRimShift * zoom * bsy);
  const sheenPx = R.blobSheenShift * zoom * bsy;
  const thinPx = R.blobThinTest * zoom * bsx;

  // ---- dirty rectangle -------------------------------------------------
  // Every offscreen pass below is a full-buffer blend if you let it be one, and
  // the water usually covers a third of the screen. Confining all of them to
  // the particle bounding box (grown by the kernel, the blur and the deepest
  // shift any pass applies) is the single biggest saving in here.
  let maxShift = rimPx > sheenPx ? rimPx : sheenPx;
  for (let k = 0; k < bands.length; k++) {
    const sh = bands[k] * zoom * bsy;
    if (sh > maxShift) maxShift = sh;
  }
  if (thinPx > maxShift) maxShift = thinPx;
  const pad = rB + blurPx * 3 + maxShift + 2;
  let x0 = Math.floor(SX(gMinX) * bsx - pad);
  let x1 = Math.ceil(SX(gMaxX) * bsx + pad);
  let y0 = Math.floor(SY(gMaxY) * bsy - pad);
  let y1 = Math.ceil(SY(gMinY) * bsy + pad);
  if (!gReady) { x0 = 0; y0 = 0; x1 = bw; y1 = bh; }
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > bw) x1 = bw;
  if (y1 > bh) y1 = bh;
  const dW = x1 - x0, dH = y1 - y0;
  if (!(dW > 0) || !(dH > 0)) return;
  stat.dirty = (dW * dH) / (bw * bh);

  // ---- 1. coverage mask ------------------------------------------------
  gAcc.globalCompositeOperation = 'source-over';
  gAcc.globalAlpha = 1;
  gAcc.clearRect(x0, y0, dW, dH);
  gAcc.globalCompositeOperation = 'lighter';

  if (gReady && R.blobFuse) fuseInterior(gAcc, bsx, bsy, bw, bh);

  const px = water.ppx, py = water.ppy, pvx = water.pvx, pvy = water.pvy;
  const margin = rB + 2;
  const foamSpeed = R.blobFoamSpeed;
  const foamSpan = Math.max(0.01, R.blobFoamFull - foamSpeed);
  const foamCap = R.blobFoamMax | 0;
  let foamN = 0;
  ensureFoamBuf(foamCap);
  const useGrid = gReady && !!gCellOf;

  gAcc.globalAlpha = R.blobPeak;
  for (let i = 0; i < count; i++) {
    const sx = SX(px[i]) * bsx;
    if (sx < -margin || sx > bw + margin) continue;
    const sy = SY(py[i]) * bsy;
    if (sy < -margin || sy > bh + margin) continue;

    // Only trust the occupancy grid when THIS frame built one: it is skipped
    // when the view is so wide that the cell count would blow its budget, and
    // last frame's cell indices would then punch holes in the mask.
    const cellId = useGrid ? gCellOf[i] : -1;
    // Foam comes FROM the fluid: a fast particle that is also within a cell of
    // the free surface. The surface test is the whole trick — gate on speed
    // alone and an entire 6 m/s wave foams from crest to bed, which is how you
    // get a cauliflower instead of water. The occupancy grid already knows what
    // is above each particle, so it costs one array read.
    if (foamN < foamCap) {
      const vx = pvx[i], vy = pvy[i];
      const sp2 = vx * vx + vy * vy;
      if (sp2 > foamSpeed * foamSpeed && cellId >= 0 && atSurface(cellId)) {
        foamX[foamN] = sx; foamY[foamN] = sy;
        foamW[foamN] = clamp01((Math.sqrt(sp2) - foamSpeed) / foamSpan);
        foamN++;
      }
    }

    if (cellId >= 0 && gInner[cellId]) continue;  // interior: the rects have it
    gAcc.drawImage(sprite, sx - rB, sy - rB, dia, dia);
    stat.sprites++;
  }
  gAcc.globalAlpha = 1;
  gAcc.globalCompositeOperation = 'source-over';

  // Smooth, THEN gain. The particles sit on a ~0.3 m lattice, so the raw
  // isosurface wears a per-particle ripple that reads as a lumpy crust along
  // the whole shoreline. A blur of about half a particle spacing averages that
  // ripple away; the 'lighter' self-blit afterwards clamps the softened field
  // back into a crisp edge. Blur first and gain second — the other order just
  // fattens the body.
  smoothMask(b, x0, y0, dW, dH, blurPx);

  // From here on every layer is clipped to the dirty rectangle, so the
  // whole-canvas composite operations ('copy', 'source-in', 'destination-in')
  // cost the rectangle and not the buffer.
  clipRect(gAcc, x0, y0, dW, dH);
  clipRect(gSc, x0, y0, dW, dH);
  clipRect(gOut, x0, y0, dW, dH);

  gAcc.globalCompositeOperation = 'lighter';
  for (let k = 0; k < R.blobGainPasses; k++) {
    gAcc.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
  }
  gAcc.globalCompositeOperation = 'source-over';

  // ---- 2. body colour into `out` --------------------------------------
  gOut.globalCompositeOperation = 'source-over';
  gOut.globalAlpha = clamp01(R.blobBodyAlpha);
  gOut.clearRect(x0, y0, dW, dH);
  gOut.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
  gOut.globalAlpha = 1;
  gOut.globalCompositeOperation = 'source-in';
  gOut.fillStyle = R.blobBodyColor;
  gOut.fillRect(x0, y0, dW, dH);
  gOut.globalCompositeOperation = 'source-over';

  // ---- 3. depth tint ---------------------------------------------------
  // A stack of downward-shifted copies of the mask: a pixel with water 0.15 m
  // above it takes one layer of tint, one with water 3.5 m above it takes all
  // four. Then ONE horizontal erosion for the whole stack — "is this body wider
  // than a stream" — before it is clipped back to the body and colourised.
  // Per-band erosion looked marginally better and cost three times the blits.
  let bandN = 0;
  for (let k = 0; k < bands.length; k++) {
    const dy = bands[k] * zoom * bsy;
    if (!(dy >= 0.5)) continue;
    gSc.globalAlpha = clamp01(alphas[k] === undefined ? 0.3 : alphas[k]);
    gSc.globalCompositeOperation = bandN === 0 ? 'copy' : 'source-over';
    gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0 + dy, dW, dH);
    bandN++;
  }
  if (bandN > 0) {
    gSc.globalAlpha = 1;
    gSc.globalCompositeOperation = 'destination-in';
    if (thinPx >= 0.5) {
      gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0 + thinPx, y0, dW, dH);
      gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0 - thinPx, y0, dW, dH);
    }
    gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
    gSc.globalCompositeOperation = 'source-in';
    gSc.fillStyle = R.blobDeepColor;
    gSc.fillRect(x0, y0, dW, dH);
    gSc.globalCompositeOperation = 'source-over';
    gOut.drawImage(b.c.sc, x0, y0, dW, dH, x0, y0, dW, dH);
  }

  // ---- 4. foam, sitting ON the body ----------------------------------
  if (foamN > 0) {
    let fr = spacing * R.blobFoamR * zoom * bsx;
    if (fr < 1) fr = 1;
    const fsp = foamSprite(fr * 2);
    if (fsp) {
      gSc.globalCompositeOperation = 'source-over';
      gSc.globalAlpha = 1;
      gSc.clearRect(x0, y0, dW, dH);
      gSc.globalCompositeOperation = 'lighter';
      for (let i = 0; i < foamN; i++) {
        gSc.globalAlpha = R.blobFoamSprite * (0.35 + 0.65 * foamW[i]);
        const s = fr * (0.75 + 0.55 * foamW[i]);
        gSc.drawImage(fsp, foamX[i] - s, foamY[i] - s, s * 2, s * 2);
      }
      gSc.globalAlpha = 1;
      gSc.globalCompositeOperation = 'destination-in';
      gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
      gSc.globalCompositeOperation = 'source-in';
      gSc.fillStyle = R.blobFoamColor;
      gSc.fillRect(x0, y0, dW, dH);
      gSc.globalCompositeOperation = 'source-over';
      gOut.globalAlpha = clamp01(R.blobFoamAlpha);
      gOut.drawImage(b.c.sc, x0, y0, dW, dH, x0, y0, dW, dH);
      gOut.globalAlpha = 1;
    }
  }

  // ---- 5. free surface -------------------------------------------------
  // mask − mask↓rim = the top rim of every blob. Blitted twice: once in place
  // as the crisp waterline, once pushed down a little at low alpha as the sky
  // sheen sitting just under it (a second, wider band would cost four more
  // buffer passes for the same read).
  surfaceBand(gSc, b, rimPx, R.blobRimMinThick * zoom * bsy, R.blobRimColor, x0, y0, dW, dH);
  gOut.globalAlpha = clamp01(R.blobSheenAlpha);
  gOut.drawImage(b.c.sc, x0, y0, dW, dH, x0, y0 + sheenPx, dW, dH);
  gOut.globalAlpha = clamp01(R.blobRimAlpha);
  gOut.drawImage(b.c.sc, x0, y0, dW, dH, x0, y0, dW, dH);
  gOut.globalAlpha = 1;

  unclip(gAcc); unclip(gSc); unclip(gOut);

  // ---- 6. one upscaled blit -------------------------------------------
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(b.c.out, x0, y0, dW, dH, x0 / bsx, y0 / bsy, dW / bsx, dH / bsy);
}

function clipRect(g, x, y, w, h) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
}

function unclip(g) {
  g.restore();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

// Blur the coverage mask in place (via the scratch layer). Uses the 2-D context
// filter where it exists, and falls back to a bilinear down/up bounce, which is
// a serviceable box blur and needs no feature at all.
function smoothMask(b, x0, y0, dW, dH, radiusPx) {
  if (!(radiusPx > 0.4)) return;
  const gAcc = b.g.acc, gSc = b.g.sc;
  gSc.globalAlpha = 1;
  gAcc.globalAlpha = 1;
  if (typeof gAcc.filter === 'string') {
    gSc.globalCompositeOperation = 'copy';
    gSc.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
    gAcc.globalCompositeOperation = 'copy';
    gAcc.filter = 'blur(' + (Math.round(radiusPx * 100) / 100) + 'px)';
    gAcc.drawImage(b.c.sc, x0, y0, dW, dH, x0, y0, dW, dH);
    gAcc.filter = 'none';
  } else {
    const div = 1 + radiusPx;
    const sw = Math.max(2, Math.round(dW / div));
    const sh = Math.max(2, Math.round(dH / div));
    gSc.globalCompositeOperation = 'copy';
    gSc.drawImage(b.c.acc, x0, y0, dW, dH, 0, 0, sw, sh);
    gAcc.globalCompositeOperation = 'copy';
    gAcc.drawImage(b.c.sc, 0, 0, sw, sh, x0, y0, dW, dH);
  }
  gAcc.globalCompositeOperation = 'source-over';
  gSc.globalCompositeOperation = 'source-over';
}

// mask − mask↓shift = the top rim of every blob = the free surface, then
// ∩ mask↑thick = "and there is real water under it". That second term is what
// stops a one-particle-thick sheet running down a slope from being drawn as a
// bright white line: a 0.2 m trickle would otherwise be nothing BUT waterline,
// and the shallows read as frost instead of water.
function surfaceBand(g, b, shift, thick, color, x0, y0, dW, dH) {
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'copy';
  g.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0, dW, dH);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0 + Math.max(0.75, shift), dW, dH);
  if (thick >= 0.5) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(b.c.acc, x0, y0, dW, dH, x0, y0 - thick, dW, dH);
  }
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(x0, y0, dW, dH);
  g.globalCompositeOperation = 'source-over';
}

// Interior cells as merged horizontal runs: identical silhouette, one rect per
// run instead of a sprite per particle. This is what keeps an 8000-particle
// reservoir at a couple of thousand draw calls.
function fuseInterior(g, bsx, bsy, bw, bh) {
  const cell = gCell;
  g.globalAlpha = 1;
  g.fillStyle = '#ffffff';
  g.beginPath();
  let any = false;
  for (let iy = 0; iy < gNY; iy++) {
    const row = iy * gNX;
    let ix = 0;
    while (ix < gNX) {
      if (!gInner[row + ix]) { ix++; continue; }
      let end = ix;
      while (end + 1 < gNX && gInner[row + end + 1]) end++;
      const wx0 = gX0 + ix * cell, wx1 = gX0 + (end + 1) * cell;
      const wy0 = gY0 + iy * cell, wy1 = gY0 + (iy + 1) * cell;
      const x0 = SX(wx0) * bsx, x1 = SX(wx1) * bsx;
      const y1 = SY(wy0) * bsy, y0 = SY(wy1) * bsy;       // y flips
      if (x1 > -2 && x0 < bw + 2 && y1 > -2 && y0 < bh + 2) {
        g.rect(x0, y0, x1 - x0, y1 - y0);
        stat.fused++;
        any = true;
      }
      ix = end + 1;
    }
  }
  if (any) g.fill();
}

// ---- foam scratch (no per-frame allocation) -----------------------------

let foamX = new Float32Array(0), foamY = new Float32Array(0), foamW = new Float32Array(0);

function ensureFoamBuf(n) {
  if (foamX.length >= n) return;
  foamX = new Float32Array(n);
  foamY = new Float32Array(n);
  foamW = new Float32Array(n);
}

// ---- fallback (no offscreen canvas: Node test stubs) --------------------

function drawBodyFallback(ctx, water, count) {
  const spacing = particleSpacing(water);
  const r = Math.max(1, spacing * R.blobRadiusMul * zoom * 0.85);
  const px = water.ppx, py = water.ppy;
  ctx.globalAlpha = clamp01(R.blobBodyAlpha);
  ctx.fillStyle = R.blobBodyColor;
  ctx.beginPath();
  let any = false;
  for (let i = 0; i < count; i++) {
    const sx = SX(px[i]);
    if (sx < -r || sx > W + r) continue;
    const sy = SY(py[i]);
    if (sy < -r || sy > H + r) continue;
    ctx.moveTo(sx + r, sy);
    ctx.arc(sx, sy, r, 0, TAU);
    any = true;
  }
  if (any) ctx.fill();
  ctx.globalAlpha = 1;
}

// ---- water/ground contact ----------------------------------------------
// A soft dark band exactly where water sits on the ground. Without it a
// translucent body floats; with it the shoreline reads as contact. Driven by
// the occupancy grid, so a waterfall passing over dry ground never paints one.

function drawBedContact(ctx, terrain) {
  if (!gReady || !terrain || !gNX) return;
  const cell = gCell;
  const yTop = gY0 + gNY * cell;
  ctx.beginPath();
  let run = false, any = false;
  for (let ix = 0; ix < gNX; ix++) {
    const x = gX0 + (ix + 0.5) * cell;
    const gy = terrain.heightAt(x);
    let wet = false;
    if (gy > gY0 && gy < yTop) {
      const iy = ((gy - gY0) / cell) | 0;
      const c = iy * gNX + ix;
      wet = gCount[c] > 0 || (iy + 1 < gNY && gCount[c + gNX] > 0);
    }
    if (!wet) { run = false; continue; }
    const sx = SX(x), sy = SY(gy);
    if (sx < -20 || sx > W + 20) { run = false; continue; }
    if (!run) { ctx.moveTo(sx, sy); run = true; } else ctx.lineTo(sx, sy);
    any = true;
  }
  if (!any) return;
  ctx.strokeStyle = R.bedShadow;
  ctx.lineWidth = Math.max(1, R.bedShadowPx * dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// ---- terrain clip ------------------------------------------------------

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
