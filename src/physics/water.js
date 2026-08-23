// OPUS A owns. 1-D shallow-water column grid (pipe model with momentum).
// Contract: ARCHITECTURE.md §5 "Water". DOM-free, deterministic (no Math.random).
//
// Layout:  cell i covers x ∈ [x0 + i·cellW, x0 + (i+1)·cellW], centre at
// x0 + (i+0.5)·cellW.  Boundary b sits at x = x0 + b·cellW between cells b−1
// and b; boundaries 0 and n are closed walls, so the domain conserves mass.
//
// Every boundary carries a horizontal velocity (momentum), which is what makes a
// released reservoir arrive downstream as a travelling wave front instead of
// teleporting.
//
// THE KEY FEATURE — blocked boundaries.  coupling.js rasterises the dam into
// merged y-intervals per boundary (water.blocked[b]).  Water may only cross a
// boundary through the OPEN part of the wetted cross-section:
//
//   * fully blocked from the bed to above the surface → flux is exactly 0, the
//     reservoir just rises (no numerical seepage, or the game is unwinnable);
//   * an open interval below the crest → orifice/jet flux, ∝ gap · √(2g·head);
//   * surface above the blocked crest → weir-like overtopping, ∝ H^1.5.
//
// Per-boundary diagnostics (additions to the contract, read-only for others):
//   flow[b]      signed applied flux, m²/s, + = towards +x
//   gapFlow[b]   part of flow[b] squeezing through gaps/holes (breach jets)
//   weirFlow[b]  part of flow[b] going over the crest (overtopping)
//   sealed[b]    1 when the boundary currently carries blocking intervals
//   crest[b]     top of the blockage (bed elevation when unblocked)
//   bedB[b]      sill elevation of the boundary = max of the two cell beds

import { CONFIG } from '../config.js';

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

  return {
    x0, cellW: c.cellW, n, cfg: c,
    bed, bedB,
    depth: new Float32Array(n),
    vel: new Float32Array(n + 1),
    blocked: new Array(n + 1).fill(null),
    // diagnostics, averaged over the substeps of the last tick
    flow: new Float32Array(n + 1),
    gapFlow: new Float32Array(n + 1),
    weirFlow: new Float32Array(n + 1),
    crest: new Float32Array(n + 1),
    sealed: new Uint8Array(n + 1),
    sources: [],
    time: 0,
    stats: { totalIn: 0 },
    // scratch (never read from outside)
    _q: new Float32Array(n + 1),
    _qg: new Float32Array(n + 1),
    _qw: new Float32Array(n + 1),
    _out: new Float32Array(n),
    _scale: new Float32Array(n),
  };
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

export function addWater(water, { x0, x1, surface }) {
  for (let i = 0; i < water.n; i++) {
    const x = water.x0 + (i + 0.5) * water.cellW;
    if (x >= x0 && x <= x1) {
      const d = Math.max(0, surface - water.bed[i]);
      if (d > water.depth[i]) {
        water.stats.totalIn += (d - water.depth[i]) * water.cellW;
        water.depth[i] = d;
      }
    }
  }
}

export function addSource(water, { x, rate, duration = Infinity, delay = 0 }) {
  water.sources.push({ x, rate, duration, delay, t: 0 });
}

export function setBoundaryBlocks(water, blocked) { water.blocked = blocked; }

function applySources(water, dt) {
  for (const s of water.sources) {
    const t0 = s.t;
    s.t += dt;
    const start = Math.max(s.delay, t0);
    const end = Math.min(s.delay + s.duration, s.t);
    const active = end - start;
    if (!(active > 0)) continue;
    const i = cellIndex(water, s.x);
    const vol = s.rate * active;
    water.depth[i] += vol / water.cellW;
    water.stats.totalIn += vol;
  }
}

// ---- step ----------------------------------------------------------------

export function stepWater(water, dt) {
  if (!water) return;
  const c = water.cfg;
  const sub = Math.max(1, c.substeps | 0);
  const h = dt / sub;
  // cfg.damping is per TICK; spread it across the substeps so the substep count
  // does not silently change how fast a flood front loses its momentum
  const damp = sub === 1 ? c.damping : Math.pow(c.damping, 1 / sub);

  applySources(water, dt);

  water.flow.fill(0);
  water.gapFlow.fill(0);
  water.weirFlow.fill(0);

  for (let s = 0; s < sub; s++) {
    computeFluxes(water, h, damp);
    transfer(water, h);
  }

  const invSub = 1 / sub;
  for (let b = 0; b <= water.n; b++) {
    water.flow[b] *= invSub;
    water.gapFlow[b] *= invSub;
    water.weirFlow[b] *= invSub;
  }
  water.time += dt;
}

function computeFluxes(water, h, damp) {
  const c = water.cfg;
  const n = water.n, cw = water.cellW;
  const g = c.g, maxVel = c.maxVel;
  const q = water._q, qg = water._qg, qw = water._qw;
  const depth = water.depth, bed = water.bed;

  q[0] = 0; qg[0] = 0; qw[0] = 0; water.vel[0] = 0;
  q[n] = 0; qg[n] = 0; qw[n] = 0; water.vel[n] = 0;

  for (let b = 1; b < n; b++) {
    const iL = b - 1, iR = b;
    const sill = water.bedB[b];
    const sL = bed[iL] + depth[iL];
    const sR = bed[iR] + depth[iR];
    const blk = water.blocked[b];
    const hasBlk = !!(blk && blk.length);
    water.sealed[b] = hasBlk ? 1 : 0;
    qg[b] = 0; qw[b] = 0;

    const sUp = sL > sR ? sL : sR;
    if (sUp <= sill + c.minDepth) {          // nothing to move at this sill
      q[b] = 0;
      water.vel[b] = 0;
      water.crest[b] = hasBlk ? blockCrest(blk, sill) : sill;
      continue;
    }

    if (!hasBlk) {
      water.crest[b] = sill;
      // momentum pipe flow: dv/dt = g·d(surface)/dx
      let v = (water.vel[b] + (g * (sL - sR) / cw) * h) * damp;
      if (v > maxVel) v = maxVel; else if (v < -maxVel) v = -maxVel;
      let hUp = (v >= 0 ? sL : sR) - sill;   // upwind depth over the sill
      if (hUp <= 0) { v = 0; hUp = 0; }
      water.vel[b] = v;
      q[b] = v * hUp;
      continue;
    }

    // ---- gated boundary --------------------------------------------------
    const crest = blockCrest(blk, sill);
    water.crest[b] = crest;
    const sDn = sL > sR ? sR : sL;
    const dir = sL > sR ? 1 : -1;
    let gap = 0, weir = 0, openH = 0;

    // gaps between the sill and the crest
    let cursor = sill;
    for (let k = 0; k < blk.length; k++) {
      const iv = blk[k];
      const y0 = iv[0] > sill ? iv[0] : sill;
      const y1 = iv[1] > sill ? iv[1] : sill;
      if (y1 <= sill) continue;
      if (y0 > cursor + c.sealEps) {
        const top = Math.min(y0, sUp);
        if (top > cursor) {
          const a = top - cursor;
          const mid = (cursor + top) * 0.5;
          const head = sUp - Math.max(sDn, mid);
          if (head > 0) { gap += c.orificeCoeff * a * Math.sqrt(2 * g * head); openH += a; }
        }
      }
      if (y1 > cursor) cursor = y1;
    }

    // free surface above the crest → weir
    const H = sUp - crest;
    if (H > 0) {
      let f = c.weirCoeff * Math.sqrt(g) * Math.pow(H, 1.5);
      const Hd = sDn - crest;
      if (Hd > 0) {
        // Villemonte drowned-weir reduction → smoothly zero as levels equalise
        const r = Math.min(1, Hd / H);
        f *= Math.pow(Math.max(0, 1 - Math.pow(r, 1.5)), c.weirDrownExp);
      }
      weir = f;
      openH += H;
    }

    qg[b] = dir * gap;
    qw[b] = dir * weir;
    q[b] = qg[b] + qw[b];
    let v = openH > c.minDepth ? q[b] / openH : 0;
    if (v > maxVel) v = maxVel; else if (v < -maxVel) v = -maxVel;
    water.vel[b] = v;
  }
}

// Top of the blockage above the sill (sill itself when nothing blocks it).
function blockCrest(blk, sill) {
  let crest = sill;
  for (let k = 0; k < blk.length; k++) if (blk[k][1] > crest) crest = blk[k][1];
  return crest;
}

// Move the water. Outflow per cell is capped at transferCap·depth so depth can
// never go negative and mass is conserved exactly (closed domain edges).
function transfer(water, h) {
  const n = water.n, cw = water.cellW;
  const cap = water.cfg.transferCap;
  const q = water._q, out = water._out, scale = water._scale;
  const depth = water.depth;

  out.fill(0);
  for (let b = 1; b < n; b++) {
    const d = (q[b] * h) / cw;
    if (d > 0) out[b - 1] += d;
    else if (d < 0) out[b] -= d;
  }
  for (let i = 0; i < n; i++) {
    const avail = depth[i] * cap;
    scale[i] = out[i] > avail ? (out[i] > 0 ? avail / out[i] : 0) : 1;
  }
  for (let b = 1; b < n; b++) {
    let d = (q[b] * h) / cw;
    if (d === 0) { continue; }
    const k = scale[d > 0 ? b - 1 : b];
    if (k !== 1) d *= k;
    depth[b - 1] -= d;
    depth[b] += d;
    const applied = (d * cw) / h;
    const ratio = q[b] !== 0 ? applied / q[b] : 0;
    water.flow[b] += applied;
    water.gapFlow[b] += water._qg[b] * ratio;
    water.weirFlow[b] += water._qw[b] * ratio;
  }
  for (let i = 0; i < n; i++) if (depth[i] < 0) depth[i] = 0;
}
