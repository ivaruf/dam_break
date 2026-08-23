// OPUS A owns. Water v2: the public water surface over the PIC/FLIP particle
// fluid in physics/fluid.js. Contract: ARCHITECTURE.md §5 "Water v2".
// DOM-free, deterministic (no Math.random anywhere).
//
// The water IS particles (water.pcount / ppx / ppy / pvx / pvy). Everything the
// rest of the game reads is DERIVED from them once per tick, so renderer, HUD,
// modes and the level suite keep working against the v1 column contract:
//
//   depth[i]   particle volume binned into column i, divided by cellW. Because
//              every particle carries exactly pvol, volumeBetween/totalVolume
//              and stats.totalIn stay in the same units and retention is exact.
//   vel[b]     volume-weighted mean particle vx at the boundary (EMA-smoothed)
//   flow[b]    MEASURED particle flux across the boundary (m²/s), split into
//              gapFlow (below the sealed crest → leak/breach jets) and weirFlow
//              (above it → overtopping nappe). Nothing about them is modelled:
//              a particle crossed, so it is counted.
//   blocked/sealed/crest/bedB  written by coupling from the same member capsules
//              the fluid collides with, so the renderer's jets and nappes line
//              up with where the water physically goes.
//
// Layout is unchanged from v1: cell i covers [x0+i·cellW, x0+(i+1)·cellW],
// boundary b sits at x0+b·cellW.

import { CONFIG } from '../config.js';
import * as F from './fluid.js';

export function createWater(terrain, cfg) {
  const c = cfg || CONFIG.water;
  const x0 = terrain.minX;
  const span = Math.max(c.cellW, terrain.maxX - terrain.minX);
  const n = Math.max(2, Math.ceil(span / c.cellW));

  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) bed[i] = terrain.heightAt(x0 + (i + 0.5) * c.cellW);

  const bedB = new Float32Array(n + 1);
  bedB[0] = bed[0];
  bedB[n] = bed[n - 1];
  for (let b = 1; b < n; b++) bedB[b] = Math.max(bed[b - 1], bed[b]);

  const fluid = F.createFluid(terrain);
  const crest = new Float32Array(n + 1);
  crest.set(bedB);

  const water = {
    x0, cellW: c.cellW, n, cfg: c, terrain,
    bed, bedB,
    depth: new Float32Array(n),
    vel: new Float32Array(n + 1),
    blocked: new Array(n + 1).fill(null),
    flow: new Float32Array(n + 1),
    gapFlow: new Float32Array(n + 1),
    weirFlow: new Float32Array(n + 1),
    crest,
    sealed: new Uint8Array(n + 1),
    sources: [],
    time: 0,
    stats: { totalIn: 0 },

    // ---- v2 surface ----
    fluid,
    pcount: 0,
    ppx: fluid.px, ppy: fluid.py, pvx: fluid.pvx, pvy: fluid.pvy,
    pvol: fluid.pvol, pradius: fluid.radius,
    colliderForces: [],          // [{ref, fx, fy, x, y, speed}], rebuilt per tick

    // scratch (never read from outside)
    _colVol: new Float64Array(n),
    _colTmp: new Float64Array(n),
    _colTmp2: new Float64Array(n),
    _colMom: new Float64Array(n),
    _inst: new Float64Array(n + 1),
    _instGap: new Float64Array(n + 1),
    _instWeir: new Float64Array(n + 1),
    _prevX: new Float64Array(fluid.max),
    _caps: null, _capCount: 0,
    _forcePool: [],
  };
  return water;
}

// ---- lookups -------------------------------------------------------------

export function cellIndex(water, x) {
  const i = Math.floor((x - water.x0) / water.cellW);
  return i < 0 ? 0 : i >= water.n ? water.n - 1 : i;
}

export function boundaryIndex(water, x) {
  const b = Math.round((x - water.x0) / water.cellW);
  return b < 0 ? 0 : b > water.n ? water.n : b;
}

export function boundaryX(water, b) { return water.x0 + b * water.cellW; }

export function surfaceAt(water, x) {
  const i = cellIndex(water, x);
  return water.bed[i] + water.depth[i];
}

export function depthAt(water, x) { return water.depth[cellIndex(water, x)]; }

// Cell-centred horizontal velocity: the mean of the two bounding boundaries.
export function velAt(water, x) {
  const i = cellIndex(water, x);
  return (water.vel[i] + water.vel[i + 1]) * 0.5;
}

// True 2-D fluid velocity at a point (drag on submerged nodes and debris).
export function fluidVelAt(water, x, y, out) {
  const o = out || { x: 0, y: 0 };
  o.x = F.sampleU(water.fluid, x, y);
  o.y = F.sampleV(water.fluid, x, y);
  return o;
}

export function pressureAt(water, x, y) { return F.pressureAt(water.fluid, x, y); }

export function flowAt(water, x) { return water.flow[boundaryIndex(water, x)]; }

export function volumeBetween(water, x0, x1) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  const cw = water.cellW;
  let i0 = Math.floor((lo - water.x0) / cw);
  let i1 = Math.ceil((hi - water.x0) / cw);
  if (i0 < 0) i0 = 0;
  if (i1 > water.n) i1 = water.n;
  let v = 0;
  for (let i = i0; i < i1; i++) {
    const a = water.x0 + i * cw;
    const w = Math.min(a + cw, hi) - Math.max(a, lo);
    if (w > 0) v += water.depth[i] * w;
  }
  return v;
}

export function totalVolume(water) {
  let v = 0;
  for (let i = 0; i < water.n; i++) v += water.depth[i];
  return v * water.cellW;
}

// ---- filling -------------------------------------------------------------

// Instant fill to a surface elevation: a grid-aligned block of particles under
// `surface`, skipping anything already under water (so repeated calls top up
// rather than double-fill).
export function addWater(water, { x0, x1, surface }) {
  const f = water.fluid;
  const occupied = (x, y) => y < surfaceAt(water, x) - water.cfg.minDepth;
  const added = F.seedBlock(f, x0, x1, surface, water.pcount > 0 ? occupied : null);
  water.stats.totalIn += added;
  derive(water, CONFIG.physics.dt, true);
  return added;
}

export function addSource(water, { x, rate, duration = Infinity, delay = 0 }) {
  water.sources.push({ x, rate, duration, delay, t: 0, acc: 0, seq: 0 });
}

export function setBoundaryBlocks(water, blocked) {
  water.blocked = blocked;
  const n = water.n;
  for (let b = 0; b <= n; b++) {
    const blk = blocked ? blocked[b] : null;
    if (blk && blk.length) {
      water.sealed[b] = 1;
      let c = water.bedB[b];
      for (let k = 0; k < blk.length; k++) if (blk[k][1] > c) c = blk[k][1];
      water.crest[b] = c;
    } else {
      water.sealed[b] = 0;
      water.crest[b] = water.bedB[b];
    }
  }
}

// capsules: [{ax,ay,bx,by,r,ref}] from coupling (unbroken sealing members).
// Replaces v1's blocked-interval rasterisation as the thing water collides with.
export function setColliders(water, caps, count) {
  water._caps = caps;
  water._capCount = count === undefined ? (caps ? caps.length : 0) : count;
  F.setColliders(water.fluid, caps, water._capCount);
}

// Deterministic emission. A fractional accumulator turns m²/s into whole
// particles; they are injected through a mass-consistent INLET — a rectangle of
// height rate/v and width v·dt, moving downhill at v — so the flux the level
// asked for arrives as a moving stream. Spawning it through a point spout instead
// builds a tower over the source that no slope can drain.
function applySources(water, dt) {
  const f = water.fluid;
  const Fc = CONFIG.fluid;
  const s2 = f.spacing;
  const v = Fc.sourceSpeed;
  for (const s of water.sources) {
    const t0 = s.t;
    s.t += dt;
    const start = Math.max(s.delay, t0);
    const end = Math.min(s.delay + s.duration, s.t);
    const active = end - start;
    if (!(active > 0)) continue;
    s.acc += (s.rate * active) / f.pvol;
    let k = Math.floor(s.acc);
    if (k <= 0) continue;
    s.acc -= k;

    const slope = (F.bedAt(f, s.x + 0.5) - F.bedAt(f, s.x - 0.5)) * 0.5;
    const dir = slope > Fc.sourceSlopeEps ? -1 : 1;      // downhill (flat aims +x)
    const hIn = Math.max(s2, s.rate / v);                // inlet height  = rate/v
    const wIn = Math.max(s2 * 0.5, v * dt);              // inlet width   = v·dt
    // sits on the ground when dry, rides the surface when there is already a pool
    const base = Math.max(surfaceAt(water, s.x), F.bedAt(f, s.x)) + s2 * 0.5;
    for (let j = 0; j < k; j++) {
      const seq = s.seq++;
      const px = s.x + (F.hash01(seq, 17) - 0.5) * wIn;
      const py = base + F.hash01(seq, 31) * hIn;
      if (!F.addParticle(f, px, py, dir * v, 0)) break;
      water.stats.totalIn += f.pvol;
    }
  }
}

// ---- step ----------------------------------------------------------------

export function stepWater(water, dt) {
  if (!water) return;
  const f = water.fluid;

  applySources(water, dt);

  // remember where every particle was, so the flux across each boundary is
  // MEASURED rather than modelled
  const n = f.pcount;
  for (let i = 0; i < n; i++) water._prevX[i] = f.px[i];

  F.stepFluid(f, dt);

  derive(water, dt, false);
  collectForces(water);
  water.time += dt;
}

// Rebuild the v1 column contract from the particles.
function derive(water, dt, instant) {
  const f = water.fluid;
  const n = water.n, cw = water.cellW;
  const vol = water._colVol, mom = water._colMom;
  vol.fill(0); mom.fill(0);

  const pv = f.pvol;
  const cnt = f.pcount;
  // Linear (tent) spread over the two nearest columns: a particle is 0.3 m wide,
  // so dumping its whole volume in one 0.4 m column makes a lone splash droplet
  // read as a 0.22 m puddle. Weights sum to 1, so volume is still exact.
  for (let i = 0; i < cnt; i++) {
    const t = (f.px[i] - water.x0) / cw - 0.5;
    let i0 = Math.floor(t);
    const s = t - i0;
    let i1 = i0 + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (i0 > n - 1) i0 = n - 1;
    if (i1 < 0) i1 = 0;
    const w1 = s, w0 = 1 - s;
    const vx = f.pvx[i];
    vol[i0] += pv * w0; mom[i0] += pv * w0 * vx;
    vol[i1] += pv * w1; mom[i1] += pv * w1 * vx;
  }

  // [1 2 1] smoothing of the binned volume: kills the sampling saw-tooth without
  // moving any water out of the domain (the reflective edge folds the outside
  // share back into the edge column, so Σvol — and retention — is untouched).
  // `vol` itself stays raw: it is the weight for the velocity average below.
  const passes = CONFIG.fluid.volSmoothPasses | 0;
  const depth = water.depth;
  if (passes > 0) {
    const a = water._colTmp, b = water._colTmp2;
    let src = vol, dst = a;
    for (let k = 0; k < passes; k++) {
      for (let i = 0; i < n; i++) {
        const l = i > 0 ? src[i - 1] : src[i];
        const r = i < n - 1 ? src[i + 1] : src[i];
        dst[i] = (l + 2 * src[i] + r) * 0.25;
      }
      src = dst;
      dst = dst === a ? b : a;
    }
    for (let i = 0; i < n; i++) depth[i] = src[i] / cw;
  } else {
    for (let i = 0; i < n; i++) depth[i] = vol[i] / cw;
  }

  // boundary velocities from the two adjacent columns (volume-weighted)
  const Fc = CONFIG.fluid;
  const aV = instant ? 1 : 1 - Math.exp(-dt / Math.max(1e-4, Fc.velTau));
  const vel = water.vel;
  for (let b = 0; b <= n; b++) {
    const iL = b - 1, iR = b;
    let m = 0, v = 0;
    if (iL >= 0) { m += vol[iL]; v += mom[iL]; }
    if (iR < n) { m += vol[iR]; v += mom[iR]; }
    const target = m > 1e-9 ? v / m : 0;
    vel[b] += (target - vel[b]) * aV;
  }

  water.pcount = f.pcount;
  water.ppx = f.px; water.ppy = f.py; water.pvx = f.pvx; water.pvy = f.pvy;

  if (instant) {
    water.flow.fill(0); water.gapFlow.fill(0); water.weirFlow.fill(0);
    return;
  }

  // ---- measured flux per boundary ----
  const inst = water._inst, ig = water._instGap, iw = water._instWeir;
  inst.fill(0); ig.fill(0); iw.fill(0);
  const invDt = 1 / dt;
  const prevX = water._prevX;
  for (let i = 0; i < cnt; i++) {
    const xa = prevX[i], xb = f.px[i];
    if (xa === xb) continue;
    const ta = (xa - water.x0) / cw, tb = (xb - water.x0) / cw;
    let b0, b1, sign;
    if (tb > ta) { b0 = Math.ceil(ta); b1 = Math.floor(tb); sign = 1; }
    else { b0 = Math.ceil(tb); b1 = Math.floor(ta); sign = -1; }
    if (b1 < b0) continue;
    if (b0 < 0) b0 = 0;
    if (b1 > n) b1 = n;
    const q = sign * pv * invDt;
    const y = f.py[i];
    for (let b = b0; b <= b1; b++) {
      inst[b] += q;
      if (water.sealed[b] && y > water.crest[b]) iw[b] += q; else ig[b] += q;
    }
  }
  const aF = 1 - Math.exp(-dt / Math.max(1e-4, Fc.flowTau));
  for (let b = 0; b <= n; b++) {
    water.flow[b] += (inst[b] - water.flow[b]) * aF;
    const g = water.sealed[b] ? ig[b] : 0;
    const w = water.sealed[b] ? iw[b] : 0;
    water.gapFlow[b] += (g - water.gapFlow[b]) * aF;
    water.weirFlow[b] += (w - water.weirFlow[b]) * aF;
  }
}

// Per-collider force objects for coupling (pooled: no per-tick allocation).
function collectForces(water) {
  const f = water.fluid;
  const caps = water._caps;
  const n = water._capCount;
  const out = water.colliderForces;
  out.length = 0;
  if (!caps || !n) return;
  const pool = water._forcePool;
  for (let i = 0; i < n; i++) {
    const w = f.cw[i];
    if (w <= 0 && f.cfx[i] === 0 && f.cfy[i] === 0) continue;
    let o = pool[out.length];
    if (!o) { o = { ref: null, ci: 0, fx: 0, fy: 0, x: 0, y: 0, speed: 0 }; pool[out.length] = o; }
    o.ref = caps[i].ref;
    o.ci = i;
    o.fx = f.cfx[i];
    o.fy = f.cfy[i];
    o.x = w > 0 ? f.cax[i] / w : (caps[i].ax + caps[i].bx) * 0.5;
    o.y = w > 0 ? f.cay[i] / w : (caps[i].ay + caps[i].by) * 0.5;
    o.speed = f.cspd[i];
    out.push(o);
  }
}
