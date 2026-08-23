// OPUS A owns. THE critical module: two-way water ↔ structure interface.
// Contract: ARCHITECTURE.md §5 "Coupling". DOM-free, deterministic (no Math.random).
//
// updateObstructions()  structure → water geometry
//   Every unbroken sealing member is rasterised as a *capsule* of width
//   mat.thickness into blocked y-intervals on each water boundary it crosses.
//   Intervals within CONFIG.coupling.mergeEps of each other fuse, so a sensible
//   wall of adjacent members is watertight while a real gap stays a real gap.
//   A member foot within groundSealEps of the sill is sealed down into the bed.
//   A broken member simply stops contributing → the breach emerges by itself.
//
// applyWaterForces()    water → structure force accumulators
//   Forces are integrated PER BOUNDARY rather than per member: for each blocked
//   y-band we integrate the hydrostatic pressure difference between the two
//   neighbouring columns exactly, add a dynamic ρv² term for water moving into
//   the face, and hand the result to the member(s) that actually own that band
//   (split evenly where several overlap). That is what stops a braced wall from
//   collecting the reservoir's load two or three times over — the total force on
//   the dam is the water's force, no matter how many members form the face.
//   Deeper bands integrate to much larger loads, so the bottom of a 10 m
//   reservoir loads far harder than the top.

import { CONFIG } from '../config.js';
import { emit } from '../core/events.js';
import { setBoundaryBlocks, surfaceAt, velAt, boundaryX } from './water.js';

// ---- module state (rebuilt when the structure or water instance changes) ----

const ST = {
  structure: null, water: null, n1: 0,
  rawCap: 0, iy0: null, iy1: null, iOwn: null, iNext: null,
  head: null, sortBuf: null, endBuf: null,
  bands: [], bandN: 0, bandStart: null, bandCnt: null,
  blocked: null, ivArr: null, pairPool: null,
  impactMag: null, impactSpeed: null, lastImpact: null,
  breachNext: null, overtopNext: null,
  clock: 0, lastImpactEvent: -1e9, lastBreachEvent: -1e9, lastOvertopEvent: -1e9,
};

export function reset() {
  ST.structure = null;
  ST.water = null;
  ST.clock = 0;
  ST.lastImpactEvent = -1e9;
  ST.lastBreachEvent = -1e9;
  ST.lastOvertopEvent = -1e9;
}

function ensureState(structure, water) {
  if (ST.structure === structure && ST.water === water) return;
  ST.structure = structure;
  ST.water = water;
  ST.clock = 0;
  ST.lastImpactEvent = -1e9;
  ST.lastBreachEvent = -1e9;
  ST.lastOvertopEvent = -1e9;
  const n1 = water ? water.n + 1 : 0;
  if (ST.n1 !== n1) {
    ST.n1 = n1;
    ST.head = new Int32Array(n1);
    ST.bandStart = new Int32Array(n1);
    ST.bandCnt = new Int32Array(n1);
    ST.blocked = new Array(n1).fill(null);
    ST.ivArr = new Array(n1);
    ST.pairPool = new Array(n1);
    ST.breachNext = new Float64Array(n1).fill(-1e9);
    ST.overtopNext = new Float64Array(n1).fill(-1e9);
  } else {
    ST.breachNext.fill(-1e9);
    ST.overtopNext.fill(-1e9);
    ST.bandCnt.fill(0);      // member indices from the old structure are void
  }
  const mc = structure ? structure.members.length : 0;
  ST.impactMag = new Float64Array(mc);
  ST.impactSpeed = new Float64Array(mc);
  ST.lastImpact = new Float64Array(mc).fill(-1e9);
}

function ensureRaw(need) {
  if (ST.rawCap >= need) return;
  let cap = ST.rawCap || 128;
  while (cap < need) cap *= 2;
  const iy0 = new Float64Array(cap), iy1 = new Float64Array(cap);
  const own = new Int32Array(cap), nxt = new Int32Array(cap);
  if (ST.rawCap) { iy0.set(ST.iy0); iy1.set(ST.iy1); own.set(ST.iOwn); nxt.set(ST.iNext); }
  ST.iy0 = iy0; ST.iy1 = iy1; ST.iOwn = own; ST.iNext = nxt;
  ST.sortBuf = new Int32Array(cap);
  ST.endBuf = new Float64Array(cap * 2);
  ST.rawCap = cap;
}

// ---- structure → water ---------------------------------------------------

export function updateObstructions(structure, water) {
  if (!water) return;
  ensureState(structure, water);
  const C = CONFIG.coupling;
  const n = water.n;
  const cw = water.cellW;
  const eps = C.vertEps;
  const reach = cw * C.sealReachCells;

  ST.head.fill(-1);
  ST.bandN = 0;
  let rawN = 0;

  if (structure) {
    const members = structure.members;
    for (let mi = 0; mi < members.length; mi++) {
      const m = members[mi];
      if (m.broken || !m.sealing) continue;
      const ax = m.a.x, ay = m.a.y, bx = m.b.x, by = m.b.y;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-9)) continue;
      const ht = (m.mat.thickness || 0) * 0.5;
      const ux = dx / len;
      const yLo = Math.min(ay, by) - ht;
      const yHi = Math.max(ay, by) + ht;
      // Seal reach: a member also blocks the boundaries within `reach` of its
      // own x-span. Without it a wall that has deflected even slightly puts
      // consecutive members on *different* boundaries, so no single boundary
      // spans the full height and a geometrically solid dam leaks like a sieve.
      const xLo = Math.min(ax, bx) - ht - reach;
      const xHi = Math.max(ax, bx) + ht + reach;

      let b0 = Math.ceil((xLo - water.x0) / cw);
      let b1 = Math.floor((xHi - water.x0) / cw);
      if (b1 < b0) {
        // thinner than a cell and sitting between two boundaries: snap to the
        // nearest one, otherwise a vertical wall could block nothing at all
        const bm = Math.round(((ax + bx) * 0.5 - water.x0) / cw);
        b0 = bm; b1 = bm;
      }
      if (b0 < 1) b0 = 1;
      if (b1 > n - 1) b1 = n - 1;

      for (let b = b0; b <= b1; b++) {
        const xb = water.x0 + b * cw;
        // Capsule slice at x = xb. The half-extent ht/|ux| grows as the member
        // leans away from perpendicular (a vertical member covers its whole
        // span); t is CLAMPED to the segment so boundaries beyond the ends fall
        // back to the nearest end cap instead of extrapolating the infinite
        // line off to infinity.
        let t = Math.abs(dx) > eps ? (xb - ax) / dx : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const yc = ay + dy * t;
        const e = ht / Math.max(Math.abs(ux), eps);
        let y0 = Math.max(yc - e, yLo);
        let y1 = Math.min(yc + e, yHi);
        if (!(y1 > y0)) continue;
        const sill = water.bedB[b];
        if (y1 <= sill - C.groundSealSink) continue;      // buried
        if (y0 <= sill + C.groundSealEps) y0 = sill - C.groundSealSink;
        ensureRaw(rawN + 1);
        ST.iy0[rawN] = y0; ST.iy1[rawN] = y1; ST.iOwn[rawN] = mi;
        ST.iNext[rawN] = ST.head[b]; ST.head[b] = rawN;
        rawN++;
      }
    }
  }

  for (let b = 0; b <= n; b++) buildBoundary(b, C);
  setBoundaryBlocks(water, ST.blocked);
}

function buildBoundary(b, C) {
  ST.bandStart[b] = ST.bandN;
  ST.bandCnt[b] = 0;
  let idx = ST.head[b];
  if (idx < 0) { ST.blocked[b] = null; return; }

  // gather + insertion sort by y0 (a handful of entries per boundary)
  const sort = ST.sortBuf;
  let k = 0;
  while (idx >= 0) { sort[k++] = idx; idx = ST.iNext[idx]; }
  for (let i = 1; i < k; i++) {
    const v = sort[i], key = ST.iy0[v];
    let j = i - 1;
    while (j >= 0 && ST.iy0[sort[j]] > key) { sort[j + 1] = sort[j]; j--; }
    sort[j + 1] = v;
  }

  // ---- merged intervals for the water solver ----
  const pool = ST.pairPool[b] || (ST.pairPool[b] = []);
  const out = ST.ivArr[b] || (ST.ivArr[b] = []);
  let count = 0;
  let curLo = ST.iy0[sort[0]], curHi = ST.iy1[sort[0]];
  for (let i = 1; i < k; i++) {
    const lo = ST.iy0[sort[i]], hi = ST.iy1[sort[i]];
    if (lo <= curHi + C.mergeEps) {
      if (hi > curHi) curHi = hi;
    } else {
      count = pushPair(pool, out, count, curLo, curHi);
      curLo = lo; curHi = hi;
    }
  }
  count = pushPair(pool, out, count, curLo, curHi);
  if (count > C.maxIntervals) {
    // pathological profile: collapse to one interval rather than choke
    const lo = out[0][0], hi = out[count - 1][1];
    count = pushPair(pool, out, 0, lo, hi);
  }
  out.length = count;
  ST.blocked[b] = out;

  // ---- elementary bands with owners (for the force pass) ----
  const ends = ST.endBuf;
  let e = 0;
  for (let i = 0; i < k; i++) { ends[e++] = ST.iy0[sort[i]]; ends[e++] = ST.iy1[sort[i]]; }
  for (let i = 1; i < e; i++) {
    const key = ends[i];
    let j = i - 1;
    while (j >= 0 && ends[j] > key) { ends[j + 1] = ends[j]; j--; }
    ends[j + 1] = key;
  }
  for (let i = 0; i + 1 < e; i++) {
    const y0 = ends[i], y1 = ends[i + 1];
    if (y1 - y0 <= C.vertEps) continue;
    const mid = (y0 + y1) * 0.5;
    const band = nextBand();
    band.y0 = y0; band.y1 = y1;
    for (let s = 0; s < k; s++) {
      const r = sort[s];
      if (ST.iy0[r] <= mid && ST.iy1[r] >= mid) band.owners.push(ST.iOwn[r]);
    }
    if (!band.owners.length) { ST.bandN--; continue; }   // gap: give the slot back
    ST.bandCnt[b]++;
  }
}

function pushPair(pool, out, count, lo, hi) {
  let p = pool[count];
  if (!p) { p = [0, 0]; pool[count] = p; }
  p[0] = lo; p[1] = hi;
  out[count] = p;
  return count + 1;
}

function nextBand() {
  let bd = ST.bands[ST.bandN];
  if (!bd) { bd = { y0: 0, y1: 0, owners: [] }; ST.bands[ST.bandN] = bd; }
  ST.bandN++;
  bd.owners.length = 0;
  return bd;
}

// ---- water → structure ---------------------------------------------------

export function applyWaterForces(structure, water, dt) {
  if (!structure || !water) return;
  ensureState(structure, water);
  const C = CONFIG.coupling;
  const g = water.cfg.g;
  const rho = C.density;
  const members = structure.members;
  ST.clock += dt;
  if (ST.impactMag.length !== members.length) {
    ST.impactMag = new Float64Array(members.length);
    ST.impactSpeed = new Float64Array(members.length);
    ST.lastImpact = new Float64Array(members.length).fill(-1e9);
  } else {
    ST.impactMag.fill(0);
    ST.impactSpeed.fill(0);
  }

  // The reservoir exists before the dam is released, so applying its full load
  // as a step at t=0 would ring the whole truss. Fade it in instead.
  const ramp = C.rampTime > 0 ? Math.min(1, ST.clock / C.rampTime) : 1;

  // --- pressure + impact on the blocking profile, boundary by boundary ---
  for (let b = 1; b < water.n; b++) {
    const cnt = ST.bandCnt[b];
    if (!cnt) continue;
    const sill = water.bedB[b];
    const sL = water.bed[b - 1] + water.depth[b - 1];
    const sR = water.bed[b] + water.depth[b];
    if (sL <= sill && sR <= sill) continue;
    // Approach velocity. Right at a sealed face vel[b] is (correctly) ~0 —
    // the water has already stopped — and the cells immediately upstream are
    // inside that deceleration zone, so reading them would hide the very impact
    // we want to feel. Take the strongest inbound flow in a short window
    // upstream instead: that is the stagnation velocity of the oncoming front.
    const vL = approach(water, b, -1, C.impactProbeCells);
    const vR = approach(water, b, 1, C.impactProbeCells);
    const dynL = vL > 0 ? rho * C.impactScale * vL * vL * ramp : 0;
    const dynR = vR < 0 ? rho * C.impactScale * vR * vR * ramp : 0;
    const hyd = rho * g * C.pressureScale * ramp;

    const start = ST.bandStart[b];
    for (let i = 0; i < cnt; i++) {
      const band = ST.bands[start + i];
      const lo = Math.max(band.y0, sill);
      const hi = band.y1;
      if (!(hi > lo)) continue;
      const steps = Math.max(1, Math.ceil((hi - lo) / C.sampleStep));
      const step = (hi - lo) / steps;
      const share = 1 / band.owners.length;
      for (let s = 0; s < steps; s++) {
        const u0 = lo + step * s;
        const u1 = u0 + step;
        let fx = hyd * (headIntegral(sL, u0, u1) - headIntegral(sR, u0, u1));
        let dyn = 0;
        if (dynL > 0) {
          const wet = Math.min(u1, sL) - u0;
          if (wet > 0) { dyn += dynL * wet; }
        }
        if (dynR > 0) {
          const wet = Math.min(u1, sR) - u0;
          if (wet > 0) { dyn -= dynR * wet; }
        }
        fx += dyn;
        if (fx === 0) continue;
        const mid = (u0 + u1) * 0.5;
        const part = fx * share;
        const dynPart = Math.abs(dyn) * share;
        for (let o = 0; o < band.owners.length; o++) {
          const mi = band.owners[o];
          if (mi >= members.length) continue;
          applyBandForce(members[mi], mid, part, C);
          if (dynPart > 0) {
            ST.impactMag[mi] += dynPart;
            // remember how fast the water was, not just how much of it: a tall
            // wall in a slowly filling pond integrates a big force out of a
            // gentle current, and that is not an impact
            // signed: +1 = the blow came from the left (water heading +x)
            const spL = vL > 0 ? vL : 0;
            const spR = vR < 0 ? -vR : 0;
            const sp = spL >= spR ? spL : -spR;
            if (Math.abs(sp) > Math.abs(ST.impactSpeed[mi])) ST.impactSpeed[mi] = sp;
          }
        }
      }
    }
  }

  // --- buoyancy + drag on nodes and debris ---
  for (const nd of structure.nodes) submerge(nd, water, dt, C, g, rho);
  for (const d of structure.debris) {
    submerge(d.a, water, dt, C, g, rho);
    submerge(d.b, water, dt, C, g, rho);
  }

  emitEvents(structure, water, C);
}

// Strongest flow heading towards boundary b from `dir` (−1 = the left side, so
// we want the largest positive velocity; +1 = the right side, most negative).
// Scanning a few cells out skips the stalled water piled against the face.
function approach(water, b, dir, cells) {
  let best = 0;
  for (let k = 1; k <= cells; k++) {
    const i = dir < 0 ? b - k : b + k;
    if (i < 0 || i > water.n) break;
    const v = water.vel[i];
    if (dir < 0) { if (v > best) best = v; } else if (v < best) best = v;
  }
  return best;
}

// ∫ from y0 to y1 of max(0, surface − y) dy  — exact, so depth really matters.
function headIntegral(surface, y0, y1) {
  if (surface <= y0) return 0;
  const top = surface < y1 ? surface : y1;
  const a = surface - y0;
  const b = surface - top;
  return (a * a - b * b) * 0.5;
}

// Horizontal band force onto its owning member, split by lever arm; a battered
// (leaning) face also picks up the matching vertical component.
function applyBandForce(m, y, fx, C) {
  const dy = m.b.y - m.a.y;
  const dx = m.b.x - m.a.x;
  let t = Math.abs(dy) > C.vertEps ? (y - m.a.y) / dy : 0.5;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  let fy = 0;
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) {
    const nx = -dy / len, ny = dx / len;
    if (Math.abs(nx) > C.minNormalX) fy = fx * (ny / nx) * C.verticalScale;
  }
  m.a.fx += fx * (1 - t); m.a.fy += fy * (1 - t);
  m.b.fx += fx * t;       m.b.fy += fy * t;
}

function submerge(nd, water, dt, C, g, rho) {
  if (nd.invMass === 0) { nd.submerged = 0; return; }
  const d = surfaceAt(water, nd.x) - nd.y;
  if (d <= 0) { nd.submerged = 0; return; }
  const sub = d < C.submergeDepth ? d / C.submergeDepth : 1;
  nd.submerged = sub;
  nd.fy += rho * g * nd.area * sub * C.buoyancyScale;

  const dvx = velAt(water, nd.x) - nd.vx;
  const dvy = -nd.vy;
  const dv = Math.hypot(dvx, dvy);
  if (dv < 1e-6) return;
  let k = rho * nd.area * sub * C.dragScale * dv;    // quadratic drag
  const kMax = (nd.mass / dt) * C.dragImpulseCap;    // never overshoot
  if (k > kMax) k = kMax;
  nd.fx += k * dvx;
  nd.fy += k * dvy;
}

// ---- events --------------------------------------------------------------

function emitEvents(structure, water, C) {
  const members = structure.members;

  // strongest fresh dynamic hit this tick (deterministic: max, ties → lowest id)
  if (ST.clock - ST.lastImpactEvent >= C.impactCooldown) {
    let best = -1, bestMag = C.impactEventMin;
    for (let i = 0; i < ST.impactMag.length; i++) {
      const mag = ST.impactMag[i];
      if (mag <= bestMag) continue;
      if (Math.abs(ST.impactSpeed[i]) < C.impactSpeedMin) continue; // fast, not merely deep
      if (ST.clock - ST.lastImpact[i] < C.impactCooldown) continue;
      best = i; bestMag = mag;
    }
    if (best >= 0) {
      const m = members[best];
      const x = (m.a.x + m.b.x) * 0.5;
      const y = (m.a.y + m.b.y) * 0.5;
      ST.lastImpact[best] = ST.clock;
      ST.lastImpactEvent = ST.clock;
      const vel = ST.impactSpeed[best];
      emit('water:impact', {
        x, y,
        speed: Math.abs(vel),
        dir: vel >= 0 ? 1 : -1,           // which way the water was travelling
        magnitude: bestMag,
      });
    }
  }

  // Breach / overtopping. These re-fire on a slow cadence for as long as the
  // flow lasts, not just on the rising edge: the effects layer holds a jet alive
  // only briefly after the last event, so a steady leak has to keep saying so.
  // Rate-limited per kind, so a breach and an overtop never starve each other.
  const off = C.eventOffFactor;
  for (let b = 1; b < water.n; b++) {
    if (!water.sealed[b]) { ST.breachNext[b] = -1e9; ST.overtopNext[b] = -1e9; continue; }
    const gap = Math.abs(water.gapFlow[b]);
    const weir = Math.abs(water.weirFlow[b]);

    if (gap > C.breachFlowMin) {
      if (ST.clock >= ST.breachNext[b] && ST.clock - ST.lastBreachEvent >= C.eventMinInterval) {
        // Only a boundary that is mostly sealed is a dam FACE; a partly-open
        // lattice boundary inside a thick dam carries flow too, and calling that
        // a breach would spray water out of the middle of an intact dam.
        const seal = sealCoverage(water, b);
        if (seal.frac >= C.breachSealFrac) {
          ST.breachNext[b] = ST.clock + C.flowRepeat;
          ST.lastBreachEvent = ST.clock;
          emit('breach', { x: boundaryX(water, b), y: seal.gapMid, flow: water.gapFlow[b] });
        } else {
          ST.breachNext[b] = ST.clock + C.flowRepeat;   // don't re-test every tick
        }
      }
    } else if (gap < C.breachFlowMin * off) {
      ST.breachNext[b] = -1e9;
    }

    if (weir > C.overtopFlowMin) {
      if (ST.clock >= ST.overtopNext[b] && ST.clock - ST.lastOvertopEvent >= C.eventMinInterval) {
        ST.overtopNext[b] = ST.clock + C.flowRepeat;
        ST.lastOvertopEvent = ST.clock;
        emit('overtop', { x: boundaryX(water, b), flow: water.weirFlow[b] });
      }
    } else if (weir < C.overtopFlowMin * off) {
      ST.overtopNext[b] = -1e9;
    }
  }
}

// How much of the wetted cross-section at boundary b is actually blocked, plus
// the elevation of the middle of its lowest open gap. frac ~1 means a solid dam
// face (with a hole, if gapMid sits below the surface); a low frac means an open
// lattice that water simply flows through.
export function sealCoverage(water, b) {
  const sill = water.bedB[b];
  const sL = water.bed[b - 1] + water.depth[b - 1];
  const sR = water.bed[b] + water.depth[b];
  const sUp = sL > sR ? sL : sR;
  const span = sUp - sill;
  const blk = water.blocked[b];
  if (!(span > 0)) return { frac: 1, gapMid: sill };
  if (!blk || !blk.length) return { frac: 0, gapMid: sill };
  let covered = 0, gapMid = -1, cursor = sill;
  for (let k = 0; k < blk.length; k++) {
    const y0 = Math.max(blk[k][0], sill);
    const y1 = Math.min(Math.max(blk[k][1], sill), sUp);
    if (y1 > y0) {
      if (y0 > cursor && gapMid < 0) gapMid = (cursor + y0) * 0.5;
      covered += y1 - y0;
    }
    if (y1 > cursor) cursor = y1;
  }
  if (gapMid < 0) gapMid = cursor < sUp ? (cursor + sUp) * 0.5 : cursor;
  return { frac: covered / span, gapMid };
}
