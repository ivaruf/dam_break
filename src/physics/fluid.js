// OPUS A owns. PIC/FLIP hybrid particle-grid fluid core (v2 water).
// Contract: ARCHITECTURE.md §5 "Water v2". DOM-free, deterministic (no Math.random).
//
// The water IS particles. Each particle carries a fixed volume (pvol = spacing²,
// m² in this 2-D world), so mass conservation is exact: totalVolume == pcount·pvol.
// Velocity is advected on a staggered MAC grid and made divergence-free by a
// warm-started Gauss-Seidel pressure solve. Two things follow from that solve and
// nothing is scripted:
//
//   * p is a REAL pressure (Pa with rho=1): a settled reservoir converges to the
//     hydrostatic ramp p = rho·g·(surface − y), so the force on a wall integrates
//     to ½rho·g·H² and loads the base far harder than the crest;
//   * stopping a moving front against a solid face costs an impulse, which shows
//     up in p as a stagnation spike — a flood wave hits harder than a calm pond.
//
// WARM START is the reason this works with a fixed, small iteration count: in a
// steady reservoir the Poisson right-hand side is the same every tick, so p
// carries over and the iterations accumulate instead of restarting from zero.
// (Reset p and the first solve would under-converge the low-frequency ramp and
// the wall load would read far too low near the bed.)
//
// Solids are CELLS, not impulses: terrain cells are baked once, and every sealing
// member capsule marks the cells it passes through as solid and owns them. The
// force handed back to a member is Σ p·h over its own solid faces — it depends on
// the pressure field, not on how many particles happen to touch it this frame, so
// a settled dam gets a steady load instead of a buzzing one. Particles ALSO
// collide with the exact capsules (substepped, push-out along the entry normal),
// which is what makes tunnelling impossible.
//
// Index conventions (column-major so a vertical wall is contiguous):
//   cell  c  = ix*ny + iy          center (x0+(ix+.5)h, y0+(iy+.5)h)
//   u face   = ix*ny + iy          at (x0+ix·h,      y0+(iy+.5)h), ix ∈ [0,nx]
//   v face   = ix*(ny+1) + iy      at (x0+(ix+.5)h,  y0+iy·h),     iy ∈ [0,ny]

import { CONFIG } from '../config.js';

export const AIR = 0;
export const FLUID = 1;
export const SOLID = 2;

// ---- construction --------------------------------------------------------

// Bigger levels get bigger particles: the particle COUNT is what costs, and a
// 150 m valley holds several times the water of a 60 m one.
export function spacingFor(span) {
  const F = CONFIG.fluid;
  const s = F.spacing * Math.sqrt(Math.max(1, span / F.spacingSpanRef));
  return Math.min(F.spacingMax, s);
}

export function createFluid(terrain, cfgOverride) {
  const F = cfgOverride || CONFIG.fluid;
  const span = Math.max(4, terrain.maxX - terrain.minX);

  let tMin = Infinity, tMax = -Infinity;
  for (const pt of terrain.points) {
    if (pt[1] < tMin) tMin = pt[1];
    if (pt[1] > tMax) tMax = pt[1];
  }
  if (!Number.isFinite(tMin)) { tMin = 0; tMax = 0; }

  let h = F.h;
  const x0 = terrain.minX - h;                 // one solid border cell each side
  const y0 = tMin - F.yPad;
  const height = (tMax + F.yHead) - y0;
  let nx = Math.ceil((span + 2 * h) / h);
  let ny = Math.ceil(height / h);
  // Safety valve: coarsen rather than blow the cell budget on a huge level.
  while (nx * ny > F.maxCells) {
    h *= 1.15;
    nx = Math.ceil((span + 2 * h) / h);
    ny = Math.ceil(height / h);
  }

  const spacing = spacingFor(span);
  const nc = nx * ny;
  const f = {
    h, invH: 1 / h, x0, y0, nx, ny, nc,
    spacing, pvol: spacing * spacing, radius: spacing * F.radiusFrac,
    cfg: F,
    // particles
    max: F.maxParticles | 0,
    pcount: 0,
    px: new Float64Array(F.maxParticles | 0),
    py: new Float64Array(F.maxParticles | 0),
    pvx: new Float32Array(F.maxParticles | 0),
    pvy: new Float32Array(F.maxParticles | 0),
    ox: new Float64Array(F.maxParticles | 0),   // position before the last move
    oy: new Float64Array(F.maxParticles | 0),
    // MAC fields
    u: new Float32Array((nx + 1) * ny),
    uPre: new Float32Array((nx + 1) * ny),
    uw: new Float32Array((nx + 1) * ny),
    uValid: new Uint8Array((nx + 1) * ny),
    v: new Float32Array(nx * (ny + 1)),
    vPre: new Float32Array(nx * (ny + 1)),
    vw: new Float32Array(nx * (ny + 1)),
    vValid: new Uint8Array(nx * (ny + 1)),
    p: new Float32Array(nc),                    // PERSISTS between ticks (warm start)
    div: new Float32Array(nc),
    dens: new Float32Array(nc),
    cellType: new Uint8Array(nc),
    staticSolid: new Uint8Array(nc),            // terrain + domain border, baked once
    colSolid: new Uint8Array(nc),               // member capsules, rebuilt per tick
    colOwner: new Int32Array(nc),
    fluidList: new Int32Array(nc),
    fluidCount: 0,
    kcount: new Uint8Array(nc),
    // owned-solid-cell list (for the force readout)
    ownedCells: new Int32Array(1024),
    ownedOwner: new Int32Array(1024),
    ownedCount: 0,
    // particle bins (counting sort, deterministic order)
    binStart: new Int32Array(nc + 1),
    binIdx: new Int32Array(F.maxParticles | 0),
    binCursor: new Int32Array(nc),
    // colliders
    caps: null, capCount: 0,
    capBinStart: new Int32Array(nc + 1),
    capBinIdx: new Int32Array(1024),
    capBinCursor: new Int32Array(nc),
    capBinCap: 1024,
    cfx: new Float64Array(256),
    cfy: new Float64Array(256),
    cax: new Float64Array(256),
    cay: new Float64Array(256),
    cw: new Float64Array(256),
    cspd: new Float64Array(256),
    capForceCap: 256,
    // terrain lookup (heightAt is a linear scan; sample it once)
    bedStep: h * 0.25,
    bedN: 0,
    bed: null,
    restDens: 0,
    primed: false,
    substeps: 1,
    maxSpeed: 0,
  };

  f.restDens = (h * h) / f.pvol;

  // terrain sample table + static solids
  f.bedN = Math.ceil((nx * h) / f.bedStep) + 2;
  f.bed = new Float32Array(f.bedN);
  for (let i = 0; i < f.bedN; i++) f.bed[i] = terrain.heightAt(x0 + i * f.bedStep);

  const frac = F.terrainSolidFrac;
  for (let ix = 0; ix < nx; ix++) {
    const xa = x0 + ix * h, xb = xa + h;
    let top = -Infinity;
    for (let k = 0; k <= 4; k++) {
      const bh = bedAt(f, xa + (xb - xa) * (k / 4));
      if (bh > top) top = bh;
    }
    for (let iy = 0; iy < ny; iy++) {
      const cellBot = y0 + iy * h;
      const border = ix === 0 || ix === nx - 1 || iy === 0 || iy === ny - 1;
      f.staticSolid[ix * ny + iy] = (border || top >= cellBot + h * frac) ? 1 : 0;
    }
  }
  return f;
}

export function bedAt(f, x) {
  const t = (x - f.x0) / f.bedStep;
  let i = Math.floor(t);
  if (i < 0) return f.bed[0];
  if (i >= f.bedN - 1) return f.bed[f.bedN - 1];
  const s = t - i;
  return f.bed[i] + (f.bed[i + 1] - f.bed[i]) * s;
}

function bedSlope(f, x) {
  const e = f.bedStep;
  return (bedAt(f, x + e) - bedAt(f, x - e)) / (2 * e);
}

export function resetFluidParticles(f) {
  f.pcount = 0;
  f.p.fill(0);
  f.primed = false;
}

// ---- particles -----------------------------------------------------------

export function addParticle(f, x, y, vx, vy) {
  if (f.pcount >= f.max) return false;
  const i = f.pcount++;
  f.px[i] = x; f.py[i] = y;
  f.pvx[i] = vx; f.pvy[i] = vy;
  return true;
}

// Deterministic hash → [0, 1). Emission/seed jitter only; never Math.random.
export function hash01(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// Grid-aligned block of particles under `surface`, above the terrain. Returns the
// volume actually added. Lattice pitch is exactly `spacing`, which is also the
// push-apart rest distance, so a freshly seeded reservoir is already relaxed.
export function seedBlock(f, xa, xb, surface, occupied) {
  const s = f.spacing;
  const jit = f.cfg.seedJitter * s;
  let added = 0;
  const i0 = Math.ceil((xa - f.x0) / s);
  const i1 = Math.floor((xb - f.x0) / s);
  for (let i = i0; i <= i1; i++) {
    const x = f.x0 + i * s;
    if (x < f.x0 + f.h || x > f.x0 + (f.nx - 1) * f.h) continue;
    const bed = bedAt(f, x) + s * 0.5;
    if (surface <= bed) continue;
    const j0 = Math.ceil((bed - f.y0) / s);
    const j1 = Math.floor((surface - f.y0) / s);
    for (let j = j0; j <= j1; j++) {
      const y = f.y0 + j * s;
      if (y <= bedAt(f, x)) continue;
      if (occupied && occupied(x, y)) continue;
      const jx = (hash01(i, j) - 0.5) * jit;
      const jy = (hash01(j, i * 7 + 1) - 0.5) * jit;
      if (!addParticle(f, x + jx, y + jy, 0, 0)) return added;
      added += f.pvol;
    }
  }
  return added;
}

// ---- colliders -----------------------------------------------------------

function ensureCapForce(f, n) {
  if (f.capForceCap >= n) return;
  let cap = f.capForceCap;
  while (cap < n) cap *= 2;
  f.cfx = new Float64Array(cap); f.cfy = new Float64Array(cap);
  f.cax = new Float64Array(cap); f.cay = new Float64Array(cap);
  f.cw = new Float64Array(cap); f.cspd = new Float64Array(cap);
  f.capForceCap = cap;
}

function ensureOwned(f, n) {
  if (f.ownedCells.length >= n) return;
  let cap = f.ownedCells.length || 1024;
  while (cap < n) cap *= 2;
  f.ownedCells = new Int32Array(cap);
  f.ownedOwner = new Int32Array(cap);
}

// Distance² from point to segment, plus the parameter t along it.
function segDist2(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + dx * t - x, cy = ay + dy * t - y;
  return cx * cx + cy * cy;
}

// capsules: [{ax,ay,bx,by,r,ref}] — coupling rebuilds this list every tick from
// the unbroken sealing members. Marks solid cells (+owner) and buckets the
// capsules per cell for the particle collision broadphase.
export function setColliders(f, caps, count) {
  const n = count === undefined ? (caps ? caps.length : 0) : count;
  f.caps = caps;
  f.capCount = n;
  ensureCapForce(f, Math.max(1, n));
  f.colSolid.fill(0);
  f.ownedCount = 0;
  f.capBinStart.fill(0);
  if (!n) return;

  const h = f.h, nx = f.nx, ny = f.ny;
  const padSolid = f.cfg.solidPad;
  // A particle sits anywhere inside its cell: a capsule must be listed for every
  // cell it could possibly touch from the cell's far corner.
  const padHit = f.radius + h * 0.75;
  const counts = f.capBinStart;

  // pass 1: counts (+ solid marking, which needs no bucket)
  let total = 0;
  for (let ci = 0; ci < n; ci++) {
    const c = caps[ci];
    const rHit = c.r + padHit, rSolid = c.r + padSolid;
    const xa = Math.min(c.ax, c.bx) - rHit, xb = Math.max(c.ax, c.bx) + rHit;
    const ya = Math.min(c.ay, c.by) - rHit, yb = Math.max(c.ay, c.by) + rHit;
    let ix0 = Math.floor((xa - f.x0) * f.invH), ix1 = Math.floor((xb - f.x0) * f.invH);
    let iy0 = Math.floor((ya - f.y0) * f.invH), iy1 = Math.floor((yb - f.y0) * f.invH);
    if (ix0 < 0) ix0 = 0; if (ix1 > nx - 1) ix1 = nx - 1;
    if (iy0 < 0) iy0 = 0; if (iy1 > ny - 1) iy1 = ny - 1;
    const r2Hit = rHit * rHit, r2Solid = rSolid * rSolid;
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = f.x0 + (ix + 0.5) * h;
      for (let iy = iy0; iy <= iy1; iy++) {
        const cy = f.y0 + (iy + 0.5) * h;
        const d2 = segDist2(cx, cy, c.ax, c.ay, c.bx, c.by);
        if (d2 > r2Hit) continue;
        counts[ix * ny + iy + 1]++;
        total++;
        if (d2 <= r2Solid) {
          const cell = ix * ny + iy;
          if (f.staticSolid[cell]) continue;         // buried: terrain owns it
          if (!f.colSolid[cell]) {
            f.colSolid[cell] = 1;
            f.colOwner[cell] = ci;
          } else if (d2 < segDist2(cx, cy, caps[f.colOwner[cell]].ax, caps[f.colOwner[cell]].ay,
            caps[f.colOwner[cell]].bx, caps[f.colOwner[cell]].by)) {
            f.colOwner[cell] = ci;                   // closest capsule owns the cell
          }
        }
      }
    }
  }

  if (f.capBinCap < total) {
    let cap = f.capBinCap;
    while (cap < total) cap *= 2;
    f.capBinIdx = new Int32Array(cap);
    f.capBinCap = cap;
  }
  for (let i = 0; i < f.nc; i++) counts[i + 1] += counts[i];

  // pass 2: fill (cursor walks a copy of the starts, kept in binIdx-free space)
  const cursor = f.capBinCursor;
  for (let i = 0; i < f.nc; i++) cursor[i] = counts[i];
  for (let ci = 0; ci < n; ci++) {
    const c = caps[ci];
    const rHit = c.r + padHit;
    const xa = Math.min(c.ax, c.bx) - rHit, xb = Math.max(c.ax, c.bx) + rHit;
    const ya = Math.min(c.ay, c.by) - rHit, yb = Math.max(c.ay, c.by) + rHit;
    let ix0 = Math.floor((xa - f.x0) * f.invH), ix1 = Math.floor((xb - f.x0) * f.invH);
    let iy0 = Math.floor((ya - f.y0) * f.invH), iy1 = Math.floor((yb - f.y0) * f.invH);
    if (ix0 < 0) ix0 = 0; if (ix1 > nx - 1) ix1 = nx - 1;
    if (iy0 < 0) iy0 = 0; if (iy1 > ny - 1) iy1 = ny - 1;
    const r2Hit = rHit * rHit;
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = f.x0 + (ix + 0.5) * h;
      for (let iy = iy0; iy <= iy1; iy++) {
        const cy = f.y0 + (iy + 0.5) * h;
        if (segDist2(cx, cy, c.ax, c.ay, c.bx, c.by) > r2Hit) continue;
        f.capBinIdx[cursor[ix * ny + iy]++] = ci;
      }
    }
  }

  // owned solid cells, in ascending cell order (deterministic force readout)
  let cnt = 0;
  for (let cell = 0; cell < f.nc; cell++) if (f.colSolid[cell]) cnt++;
  ensureOwned(f, cnt);
  let k = 0;
  for (let cell = 0; cell < f.nc; cell++) {
    if (!f.colSolid[cell]) continue;
    f.ownedCells[k] = cell;
    f.ownedOwner[k] = f.colOwner[cell];
    k++;
  }
  f.ownedCount = k;
}

// ---- step ---------------------------------------------------------------

export function stepFluid(f, dt) {
  const F = f.cfg;
  const g = CONFIG.water.g;
  const n = f.pcount;
  if (n <= 0) {
    clearColliderForces(f);
    return;
  }

  // CFL: never advect more than a fraction of a particle radius per substep, so
  // a particle cannot cross the mid-plane of the thinnest collider it can hit.
  let vmax = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(f.pvx[i]) + Math.abs(f.pvy[i]);
    if (s > vmax) vmax = s;
  }
  vmax += g * dt;
  f.maxSpeed = vmax;
  const step = Math.max(1e-3, F.moveFrac * f.radius);
  let sub = Math.ceil((vmax * dt) / step);
  if (sub < 1) sub = 1;
  if (sub > F.maxSubsteps) sub = F.maxSubsteps;
  f.substeps = sub;
  const hs = dt / sub;

  for (let s = 0; s < sub; s++) {
    integrate(f, hs, g, F.maxSpeed);
    collide(f);
  }

  buildBins(f);
  for (let it = 0; it < F.separationIters; it++) pushApart(f);
  collide(f);

  p2g(f);
  classify(f);
  solve(f, dt);
  g2p(f, F.flip);
}

function integrate(f, h, g, maxSpeed) {
  const n = f.pcount;
  const px = f.px, py = f.py, vx = f.pvx, vy = f.pvy, ox = f.ox, oy = f.oy;
  for (let i = 0; i < n; i++) {
    let ux = vx[i], uy = vy[i] - g * h;
    const sp = Math.abs(ux) + Math.abs(uy);
    if (sp > maxSpeed) { const k = maxSpeed / sp; ux *= k; uy *= k; }
    vx[i] = ux; vy[i] = uy;
    ox[i] = px[i]; oy[i] = py[i];
    px[i] += ux * h;
    py[i] += uy * h;
  }
}

// Terrain + capsules + domain box. Push-out uses the normal taken at the PREVIOUS
// position (which is outside by induction), so a particle is always returned to
// the side it came from: no tunnelling, whatever the wall thickness.
function collide(f) {
  const n = f.pcount;
  const F = f.cfg;
  const r = f.radius;
  const keepT = F.wallFriction;
  const xLo = f.x0 + f.h + r, xHi = f.x0 + (f.nx - 1) * f.h - r;
  const yHi = f.y0 + (f.ny - 1) * f.h - r;
  const px = f.px, py = f.py, vx = f.pvx, vy = f.pvy, ox = f.ox, oy = f.oy;

  for (let i = 0; i < n; i++) {
    let x = px[i], y = py[i];

    // domain box
    if (x < xLo) { x = xLo; if (vx[i] < 0) vx[i] = 0; }
    else if (x > xHi) { x = xHi; if (vx[i] > 0) vx[i] = 0; }
    if (y > yHi) { y = yHi; if (vy[i] > 0) vy[i] = 0; }

    // terrain heightfield: exact, cannot be tunnelled
    const bed = bedAt(f, x);
    if (y < bed) {
      const sl = bedSlope(f, x);
      const inv = 1 / Math.hypot(1, sl);
      const nx = -sl * inv, ny = inv;
      y = bed;
      const vn = vx[i] * nx + vy[i] * ny;
      if (vn < 0) {
        vx[i] -= vn * nx; vy[i] -= vn * ny;
        vx[i] *= keepT; vy[i] *= keepT;
      }
    }

    // capsules from the cell bucket
    if (f.capCount) {
      let ix = Math.floor((x - f.x0) * f.invH);
      let iy = Math.floor((y - f.y0) * f.invH);
      if (ix < 0) ix = 0; else if (ix > f.nx - 1) ix = f.nx - 1;
      if (iy < 0) iy = 0; else if (iy > f.ny - 1) iy = f.ny - 1;
      const cell = ix * f.ny + iy;
      const s0 = f.capBinStart[cell], s1 = f.capBinStart[cell + 1];
      for (let k = s0; k < s1; k++) {
        const c = f.caps[f.capBinIdx[k]];
        const rr = c.r + r;
        const dx = c.bx - c.ax, dy = c.by - c.ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 1e-12 ? ((x - c.ax) * dx + (y - c.ay) * dy) / l2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cx = c.ax + dx * t, cy = c.ay + dy * t;
        let ex = x - cx, ey = y - cy;
        let d = Math.hypot(ex, ey);
        if (d >= rr) continue;
        // entry normal from the pre-move position
        let t0 = l2 > 1e-12 ? ((ox[i] - c.ax) * dx + (oy[i] - c.ay) * dy) / l2 : 0;
        if (t0 < 0) t0 = 0; else if (t0 > 1) t0 = 1;
        let ax = ox[i] - (c.ax + dx * t0), ay = oy[i] - (c.ay + dy * t0);
        let ad = Math.hypot(ax, ay);
        let nx, ny;
        if (ad >= rr * 0.999 && ad > 1e-9) { nx = ax / ad; ny = ay / ad; }
        else if (d > 1e-9) { nx = ex / d; ny = ey / d; }
        else { nx = 0; ny = 1; }
        // place on the surface along the entry normal
        const proj = ex * nx + ey * ny;
        x += nx * (rr - proj);
        y += ny * (rr - proj);
        const vn = vx[i] * nx + vy[i] * ny;
        if (vn < 0) {
          vx[i] -= vn * nx * (1 + F.restitution);
          vy[i] -= vn * ny * (1 + F.restitution);
          vx[i] *= keepT; vy[i] *= keepT;
        }
      }
    }

    px[i] = x; py[i] = y;
  }
}

// Counting sort of particles into cells: deterministic bucket order (ascending
// particle index inside ascending cell index), no allocation, no hashing.
function buildBins(f) {
  const n = f.pcount, nc = f.nc;
  const start = f.binStart, idx = f.binIdx;
  start.fill(0);
  for (let i = 0; i < n; i++) {
    let ix = Math.floor((f.px[i] - f.x0) * f.invH);
    let iy = Math.floor((f.py[i] - f.y0) * f.invH);
    if (ix < 0) ix = 0; else if (ix > f.nx - 1) ix = f.nx - 1;
    if (iy < 0) iy = 0; else if (iy > f.ny - 1) iy = f.ny - 1;
    start[ix * f.ny + iy + 1]++;
  }
  for (let c = 0; c < nc; c++) start[c + 1] += start[c];
  const cursor = f.binCursor;
  for (let c = 0; c < nc; c++) cursor[c] = start[c];
  for (let i = 0; i < n; i++) {
    let ix = Math.floor((f.px[i] - f.x0) * f.invH);
    let iy = Math.floor((f.py[i] - f.y0) * f.invH);
    if (ix < 0) ix = 0; else if (ix > f.nx - 1) ix = f.nx - 1;
    if (iy < 0) iy = 0; else if (iy > f.ny - 1) iy = f.ny - 1;
    idx[cursor[ix * f.ny + iy]++] = i;
  }
}

// Particle separation: keeps the reservoir from clumping (and from boiling, since
// clumps are what the pressure solve fights with big corrections).
function pushApart(f) {
  const n = f.pcount;
  const minD = f.spacing * f.cfg.separation;
  const minD2 = minD * minD;
  const px = f.px, py = f.py, start = f.binStart, idx = f.binIdx;
  const ny = f.ny, nx = f.nx;
  for (let i = 0; i < n; i++) {
    const x = px[i], y = py[i];
    let ix = Math.floor((x - f.x0) * f.invH);
    let iy = Math.floor((y - f.y0) * f.invH);
    if (ix < 0) ix = 0; else if (ix > nx - 1) ix = nx - 1;
    if (iy < 0) iy = 0; else if (iy > ny - 1) iy = ny - 1;
    const x0i = ix > 0 ? ix - 1 : 0, x1i = ix < nx - 1 ? ix + 1 : nx - 1;
    const y0i = iy > 0 ? iy - 1 : 0, y1i = iy < ny - 1 ? iy + 1 : ny - 1;
    for (let cx = x0i; cx <= x1i; cx++) {
      for (let cy = y0i; cy <= y1i; cy++) {
        const c = cx * ny + cy;
        const s0 = start[c], s1 = start[c + 1];
        for (let k = s0; k < s1; k++) {
          const j = idx[k];
          if (j === i) continue;
          let dx = px[j] - px[i], dy = py[j] - py[i];
          const d2 = dx * dx + dy * dy;
          if (d2 > minD2 || d2 < 1e-12) continue;
          const d = Math.sqrt(d2);
          const s = (0.5 * (minD - d)) / d;
          dx *= s; dy *= s;
          px[i] -= dx; py[i] -= dy;
          px[j] += dx; py[j] += dy;
        }
      }
    }
  }
}

// ---- particle ↔ grid transfer -------------------------------------------

function p2g(f) {
  const n = f.pcount, nx = f.nx, ny = f.ny, h = f.h, invH = f.invH;
  f.u.fill(0); f.uw.fill(0);
  f.v.fill(0); f.vw.fill(0);
  f.dens.fill(0);

  for (let i = 0; i < n; i++) {
    const x = f.px[i], y = f.py[i];
    const gx = (x - f.x0) * invH, gy = (y - f.y0) * invH;

    // u faces: sample at (gx, gy-0.5)
    {
      let fx = gx, fy = gy - 0.5;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 1) i0 = nx - 1;
      if (j0 < 0) j0 = 0; else if (j0 > ny - 2) j0 = ny - 2;
      const tx = fx - i0, ty = fy - j0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      const a = i0 * ny + j0, b = a + ny;
      const val = f.pvx[i];
      f.u[a] += val * w00; f.uw[a] += w00;
      f.u[b] += val * w10; f.uw[b] += w10;
      f.u[a + 1] += val * w01; f.uw[a + 1] += w01;
      f.u[b + 1] += val * w11; f.uw[b + 1] += w11;
    }
    // v faces: sample at (gx-0.5, gy)
    {
      let fx = gx - 0.5, fy = gy;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
      if (j0 < 0) j0 = 0; else if (j0 > ny - 1) j0 = ny - 1;
      const tx = fx - i0, ty = fy - j0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      const a = i0 * (ny + 1) + j0, b = a + (ny + 1);
      const val = f.pvy[i];
      f.v[a] += val * w00; f.vw[a] += w00;
      f.v[b] += val * w10; f.vw[b] += w10;
      f.v[a + 1] += val * w01; f.vw[a + 1] += w01;
      f.v[b + 1] += val * w11; f.vw[b + 1] += w11;
    }
    // cell density (particles per cell, weights sum to 1 per particle)
    {
      let fx = gx - 0.5, fy = gy - 0.5;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
      if (j0 < 0) j0 = 0; else if (j0 > ny - 2) j0 = ny - 2;
      const tx = fx - i0, ty = fy - j0;
      const a = i0 * ny + j0, b = a + ny;
      f.dens[a] += (1 - tx) * (1 - ty);
      f.dens[b] += tx * (1 - ty);
      f.dens[a + 1] += (1 - tx) * ty;
      f.dens[b + 1] += tx * ty;
    }
  }

  const un = f.u.length;
  for (let i = 0; i < un; i++) if (f.uw[i] > 0) f.u[i] /= f.uw[i];
  const vn = f.v.length;
  for (let i = 0; i < vn; i++) if (f.vw[i] > 0) f.v[i] /= f.vw[i];
  f.uPre.set(f.u);
  f.vPre.set(f.v);
}

// cellType from the solids + particle occupancy, then the fluid-cell list and
// the non-solid neighbour count each fluid cell needs in the pressure solve.
function classify(f) {
  const nx = f.nx, ny = f.ny;
  const t = f.cellType;
  for (let c = 0; c < f.nc; c++) {
    t[c] = (f.staticSolid[c] || f.colSolid[c]) ? SOLID : AIR;
  }
  const n = f.pcount;
  for (let i = 0; i < n; i++) {
    let ix = Math.floor((f.px[i] - f.x0) * f.invH);
    let iy = Math.floor((f.py[i] - f.y0) * f.invH);
    if (ix < 0) ix = 0; else if (ix > nx - 1) ix = nx - 1;
    if (iy < 0) iy = 0; else if (iy > ny - 1) iy = ny - 1;
    const c = ix * ny + iy;
    if (t[c] === AIR) t[c] = FLUID;
  }
  let fc = 0;
  for (let ix = 1; ix < nx - 1; ix++) {
    const base = ix * ny;
    for (let iy = 1; iy < ny - 1; iy++) {
      const c = base + iy;
      if (t[c] !== FLUID) { f.p[c] = 0; continue; }
      let k = 0;
      if (t[c - ny] !== SOLID) k++;
      if (t[c + ny] !== SOLID) k++;
      if (t[c - 1] !== SOLID) k++;
      if (t[c + 1] !== SOLID) k++;
      f.kcount[c] = k;
      if (k === 0) { f.p[c] = 0; continue; }
      f.fluidList[fc++] = c;
    }
  }
  f.fluidCount = fc;
}

// Warm-started Gauss-Seidel (SOR) pressure Poisson + velocity projection.
//   p_c = ( Σ_nonsolid-nb p_nb − D_c·rho·h/dt ) / k
// with p=0 in air (free surface Dirichlet) and no-flux at solids.
function solve(f, dt) {
  const F = f.cfg;
  const nx = f.nx, ny = f.ny, h = f.h;
  const t = f.cellType, u = f.u, v = f.v, p = f.p, div = f.div;
  const rho = CONFIG.coupling.density;

  // zero the solid faces (no-flux); uPre keeps the approach velocity for impacts
  for (let ix = 0; ix < nx; ix++) {
    const base = ix * ny;
    for (let iy = 0; iy < ny; iy++) {
      const c = base + iy;
      if (t[c] !== SOLID) continue;
      u[base + iy] = 0;
      u[base + ny + iy] = 0;
      v[ix * (ny + 1) + iy] = 0;
      v[ix * (ny + 1) + iy + 1] = 0;
    }
  }

  const rhoHdt = (rho * h) / dt;
  const drift = F.driftK;
  const fc = f.fluidCount, list = f.fluidList;
  for (let i = 0; i < fc; i++) {
    const c = list[i];
    const ix = (c / ny) | 0, iy = c - ix * ny;
    const iu = c, iv = ix * (ny + 1) + iy;
    let D = u[iu + ny] - u[iu] + v[iv + 1] - v[iv];
    if (drift > 0) {
      const comp = f.dens[c] / f.restDens - 1;
      if (comp > 0) D -= drift * comp * h / dt;
    }
    div[c] = D * rhoHdt;
  }

  const iters = f.primed ? F.pressureIters : F.primeIters;
  f.primed = true;
  const sor = F.sor;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < fc; i++) {
      const c = list[i];
      let sum = 0;
      if (t[c - ny] !== SOLID) sum += p[c - ny];
      if (t[c + ny] !== SOLID) sum += p[c + ny];
      if (t[c - 1] !== SOLID) sum += p[c - 1];
      if (t[c + 1] !== SOLID) sum += p[c + 1];
      const pn = (sum - div[c]) / f.kcount[c];
      p[c] += sor * (pn - p[c]);
    }
  }

  // project: every face with at least one fluid side, exactly once
  const scale = dt / (rho * h);
  for (let i = 0; i < fc; i++) {
    const c = list[i];
    const ix = (c / ny) | 0, iy = c - ix * ny;
    const iu = c, iv = ix * (ny + 1) + iy;
    const pc = p[c];
    const tl = t[c - ny], tr = t[c + ny], tb = t[c - 1], tt = t[c + 1];
    if (tl !== SOLID) u[iu] -= scale * (pc - (tl === FLUID ? p[c - ny] : 0));
    if (tb !== SOLID) v[iv] -= scale * (pc - (tb === FLUID ? p[c - 1] : 0));
    if (tr === AIR) u[iu + ny] -= scale * (0 - pc);
    if (tt === AIR) v[iv + 1] -= scale * (0 - pc);
  }

  colliderForces(f);
}

function clearColliderForces(f) {
  const n = f.capCount;
  for (let i = 0; i < n; i++) {
    f.cfx[i] = 0; f.cfy[i] = 0; f.cax[i] = 0; f.cay[i] = 0; f.cw[i] = 0; f.cspd[i] = 0;
  }
}

// Force on each owning member: Σ p·h over its own solid faces that touch fluid.
// Independent of the particle count at the face — that is the whole point.
function colliderForces(f) {
  clearColliderForces(f);
  const ny = f.ny, h = f.h;
  const t = f.cellType, p = f.p;
  const cnt = f.ownedCount;
  for (let k = 0; k < cnt; k++) {
    const c = f.ownedCells[k];
    const own = f.ownedOwner[k];
    const ix = (c / ny) | 0, iy = c - ix * ny;
    const cxm = f.x0 + (ix + 0.5) * h, cym = f.y0 + (iy + 0.5) * h;
    let fx = 0, fy = 0, w = 0, spd = f.cspd[own];
    const iu = c, iv = ix * (ny + 1) + iy;
    // spd stays SIGNED: the velocity of the water that is arriving, so the
    // 'water:impact' payload can say which way the blow came from
    if (t[c - ny] === FLUID) {                 // fluid on the left pushes +x
      const pr = p[c - ny] * h; fx += pr; w += Math.abs(pr);
      const s = f.uPre[iu]; if (s > 0 && s > Math.abs(spd)) spd = s;
    }
    if (t[c + ny] === FLUID) {
      const pr = p[c + ny] * h; fx -= pr; w += Math.abs(pr);
      const s = f.uPre[iu + ny]; if (s < 0 && -s > Math.abs(spd)) spd = s;
    }
    if (t[c - 1] === FLUID) {
      const pr = p[c - 1] * h; fy += pr; w += Math.abs(pr);
    }
    if (t[c + 1] === FLUID) {
      const pr = p[c + 1] * h; fy -= pr; w += Math.abs(pr);
    }
    if (w === 0) continue;
    f.cfx[own] += fx; f.cfy[own] += fy;
    f.cax[own] += cxm * w; f.cay[own] += cym * w; f.cw[own] += w;
    f.cspd[own] = spd;
  }
}

function g2p(f, flipRatio) {
  const n = f.pcount, nx = f.nx, ny = f.ny, invH = f.invH;
  const t = f.cellType;
  // face validity: a face is usable if one of its two cells holds fluid
  const un = f.u.length;
  for (let ix = 0; ix <= nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const idx = ix * ny + iy;
      const l = ix > 0 ? t[(ix - 1) * ny + iy] : SOLID;
      const r = ix < nx ? t[ix * ny + iy] : SOLID;
      f.uValid[idx] = (l === FLUID || r === FLUID) ? 1 : 0;
    }
  }
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy <= ny; iy++) {
      const idx = ix * (ny + 1) + iy;
      const b = iy > 0 ? t[ix * ny + iy - 1] : SOLID;
      const a = iy < ny ? t[ix * ny + iy] : SOLID;
      f.vValid[idx] = (a === FLUID || b === FLUID) ? 1 : 0;
    }
  }

  const pic = 1 - flipRatio;
  for (let i = 0; i < n; i++) {
    const gx = (f.px[i] - f.x0) * invH, gy = (f.py[i] - f.y0) * invH;
    {
      let fx = gx, fy = gy - 0.5;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 1) i0 = nx - 1;
      if (j0 < 0) j0 = 0; else if (j0 > ny - 2) j0 = ny - 2;
      const tx = fx - i0, ty = fy - j0;
      const a = i0 * ny + j0, b = a + ny;
      const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
      const v0 = f.uValid[a], v1 = f.uValid[b], v2 = f.uValid[a + 1], v3 = f.uValid[b + 1];
      const wsum = v0 * w0 + v1 * w1 + v2 * w2 + v3 * w3;
      if (wsum > 0) {
        const cur = (v0 * w0 * f.u[a] + v1 * w1 * f.u[b] + v2 * w2 * f.u[a + 1] + v3 * w3 * f.u[b + 1]) / wsum;
        const old = (v0 * w0 * f.uPre[a] + v1 * w1 * f.uPre[b] + v2 * w2 * f.uPre[a + 1] + v3 * w3 * f.uPre[b + 1]) / wsum;
        f.pvx[i] = pic * cur + flipRatio * (f.pvx[i] + cur - old);
      }
    }
    {
      let fx = gx - 0.5, fy = gy;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
      if (j0 < 0) j0 = 0; else if (j0 > ny - 1) j0 = ny - 1;
      const tx = fx - i0, ty = fy - j0;
      const a = i0 * (ny + 1) + j0, b = a + (ny + 1);
      const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
      const v0 = f.vValid[a], v1 = f.vValid[b], v2 = f.vValid[a + 1], v3 = f.vValid[b + 1];
      const wsum = v0 * w0 + v1 * w1 + v2 * w2 + v3 * w3;
      if (wsum > 0) {
        const cur = (v0 * w0 * f.v[a] + v1 * w1 * f.v[b] + v2 * w2 * f.v[a + 1] + v3 * w3 * f.v[b + 1]) / wsum;
        const old = (v0 * w0 * f.vPre[a] + v1 * w1 * f.vPre[b] + v2 * w2 * f.vPre[a + 1] + v3 * w3 * f.vPre[b + 1]) / wsum;
        f.pvy[i] = pic * cur + flipRatio * (f.pvy[i] + cur - old);
      }
    }
  }
}

// ---- sampling (coupling drag / debris) ----------------------------------

export function sampleU(f, x, y) {
  const nx = f.nx, ny = f.ny;
  let fx = (x - f.x0) * f.invH, fy = (y - f.y0) * f.invH - 0.5;
  let i0 = Math.floor(fx), j0 = Math.floor(fy);
  if (i0 < 0) i0 = 0; else if (i0 > nx - 1) i0 = nx - 1;
  if (j0 < 0) j0 = 0; else if (j0 > ny - 2) j0 = ny - 2;
  const tx = fx - i0, ty = fy - j0;
  const a = i0 * ny + j0, b = a + ny;
  return (1 - tx) * (1 - ty) * f.u[a] + tx * (1 - ty) * f.u[b]
    + (1 - tx) * ty * f.u[a + 1] + tx * ty * f.u[b + 1];
}

export function sampleV(f, x, y) {
  const nx = f.nx, ny = f.ny;
  let fx = (x - f.x0) * f.invH - 0.5, fy = (y - f.y0) * f.invH;
  let i0 = Math.floor(fx), j0 = Math.floor(fy);
  if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
  if (j0 < 0) j0 = 0; else if (j0 > ny - 1) j0 = ny - 1;
  const tx = fx - i0, ty = fy - j0;
  const a = i0 * (ny + 1) + j0, b = a + (ny + 1);
  return (1 - tx) * (1 - ty) * f.v[a] + tx * (1 - ty) * f.v[b]
    + (1 - tx) * ty * f.v[a + 1] + tx * ty * f.v[b + 1];
}

// Pressure at a world point (0 outside the fluid) — used by tests/diagnostics.
export function pressureAt(f, x, y) {
  let ix = Math.floor((x - f.x0) * f.invH);
  let iy = Math.floor((y - f.y0) * f.invH);
  if (ix < 0 || ix >= f.nx || iy < 0 || iy >= f.ny) return 0;
  const c = ix * f.ny + iy;
  return f.cellType[c] === FLUID ? f.p[c] : 0;
}
