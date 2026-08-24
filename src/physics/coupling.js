// OPUS A owns. THE critical module: two-way water ↔ structure interface.
// Contract: ARCHITECTURE.md §5 "Coupling". DOM-free, deterministic (no Math.random).
//
// v2 (PIC/FLIP water). The interface is now GEOMETRIC in both directions:
//
// updateObstructions()  structure → water
//   Every unbroken sealing member becomes a CAPSULE COLLIDER (radius
//   mat.thickness/2) handed to water.setColliders. Particles collide with those
//   capsules, and the cells a capsule covers become solid in the pressure solve,
//   owned by that member. A broken member drops out of the list, so the breach is
//   a hole in the geometry, not a special case.
//   The same members are ALSO rasterised into the v1 blocked-interval arrays
//   (blocked/sealed/crest per boundary) — the renderer's jets/nappes and the
//   breach/overtop event logic read those, and they cost almost nothing.
//
// applyWaterForces()    water → structure force accumulators
//   The load on a member is Σ p·h over its OWN solid faces, straight out of the
//   pressure solve (water.colliderForces). Two consequences worth stating:
//     * it is a property of the pressure FIELD, not of how many particles touch
//       the face this frame, so a settled reservoir loads the dam steadily
//       (measured: peak-to-peak under 0.1% of the mean) instead of buzzing;
//     * bracing a face with more members does not multiply the load — the water
//       pushes on the cells, and each cell has exactly one owner.
//   Hydrostatics (∫p dy = ½ρgH², base loaded far harder than crest) and impact
//   (stopping a front costs an impulse, which the solve turns into a pressure
//   spike) both come out of the same term. Nothing is scripted.
//   Buoyancy + drag on submerged nodes and debris still ride the velocity field.
//   v2.1: the same per-member force is PUBLISHED on the member as waterFx /
//   waterFy / waterFperp (component perpendicular to the axis) so stress.js can
//   bend it and the renderer can bow it. See the sign convention below.

import { CONFIG } from '../config.js';
import { emit } from '../core/events.js';
import { setBoundaryBlocks, setColliders, surfaceAt, velAt, boundaryX } from './water.js';
import { sampleV } from './fluid.js';

// ---- module state (rebuilt when the structure or water instance changes) ----

const ST = {
  structure: null, water: null, n1: 0,
  rawCap: 0, iy0: null, iy1: null, iNext: null,
  head: null, sortBuf: null,
  blocked: null, ivArr: null, pairPool: null,
  caps: [], capCount: 0, capMi: null,
  fxRaw: null, fyRaw: null, appX: null, appY: null, spd: null,
  fxS: null, fyS: null,
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
    ST.blocked = new Array(n1).fill(null);
    ST.ivArr = new Array(n1);
    ST.pairPool = new Array(n1);
    ST.breachNext = new Float64Array(n1).fill(-1e9);
    ST.overtopNext = new Float64Array(n1).fill(-1e9);
  } else {
    ST.breachNext.fill(-1e9);
    ST.overtopNext.fill(-1e9);
  }
  ensureMembers(structure ? structure.members.length : 0);
}

function ensureMembers(mc) {
  if (ST.fxRaw && ST.fxRaw.length === mc) {
    ST.fxS.fill(0); ST.fyS.fill(0);
    ST.lastImpact.fill(-1e9);
    return;
  }
  ST.fxRaw = new Float64Array(mc);
  ST.fyRaw = new Float64Array(mc);
  ST.appX = new Float64Array(mc);
  ST.appY = new Float64Array(mc);
  ST.spd = new Float64Array(mc);
  ST.fxS = new Float64Array(mc);
  ST.fyS = new Float64Array(mc);
  ST.impactMag = new Float64Array(mc);
  ST.impactSpeed = new Float64Array(mc);
  ST.lastImpact = new Float64Array(mc).fill(-1e9);
  ST.capMi = new Int32Array(mc);
}

function ensureRaw(need) {
  if (ST.rawCap >= need) return;
  let cap = ST.rawCap || 128;
  while (cap < need) cap *= 2;
  const iy0 = new Float64Array(cap), iy1 = new Float64Array(cap);
  const nxt = new Int32Array(cap);
  if (ST.rawCap) { iy0.set(ST.iy0); iy1.set(ST.iy1); nxt.set(ST.iNext); }
  ST.iy0 = iy0; ST.iy1 = iy1; ST.iNext = nxt;
  ST.sortBuf = new Int32Array(cap);
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
  const reach = cw * CONFIG.fluid.blockReach;

  ST.head.fill(-1);
  let rawN = 0;
  let capN = 0;

  if (structure) {
    const members = structure.members;
    if (ST.fxRaw.length !== members.length) ensureMembers(members.length);
    const terrain = water.terrain;
    for (let mi = 0; mi < members.length; mi++) {
      const m = members[mi];
      if (m.broken || !m.sealing) continue;
      const ax = m.a.x, ay = m.a.y, bx = m.b.x, by = m.b.y;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-9)) continue;
      const ht = (m.mat.thickness || 0) * 0.5;

      // ---- capsule for the fluid ----
      // A foot resting on the ground is sunk into it, so no hairline gap opens
      // between the member's end cap and the bed for the water to squirt through.
      let cay = ay, cby = by;
      if (terrain) {
        if (ay - terrain.heightAt(ax) <= C.groundSealEps) cay = ay - C.groundSealSink;
        if (by - terrain.heightAt(bx) <= C.groundSealEps) cby = by - C.groundSealSink;
      }
      let cap = ST.caps[capN];
      if (!cap) { cap = { ax: 0, ay: 0, bx: 0, by: 0, r: 0, ref: null }; ST.caps[capN] = cap; }
      cap.ax = ax; cap.ay = cay; cap.bx = bx; cap.by = cby;
      cap.r = ht; cap.ref = m;
      ST.capMi[capN] = mi;
      capN++;

      // ---- v1 blocked intervals (renderer + event geometry) ----
      const ux = dx / len;
      const yLo = Math.min(ay, by) - ht;
      const yHi = Math.max(ay, by) + ht;
      const xLo = Math.min(ax, bx) - ht - reach;
      const xHi = Math.max(ax, bx) + ht + reach;
      let b0 = Math.ceil((xLo - water.x0) / cw);
      let b1 = Math.floor((xHi - water.x0) / cw);
      if (b1 < b0) {
        const bm = Math.round(((ax + bx) * 0.5 - water.x0) / cw);
        b0 = bm; b1 = bm;
      }
      if (b0 < 1) b0 = 1;
      if (b1 > n - 1) b1 = n - 1;
      for (let b = b0; b <= b1; b++) {
        const xb = water.x0 + b * cw;
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
        ST.iy0[rawN] = y0; ST.iy1[rawN] = y1;
        ST.iNext[rawN] = ST.head[b]; ST.head[b] = rawN;
        rawN++;
      }
    }
  }

  ST.capCount = capN;
  for (let b = 0; b <= n; b++) buildBoundary(b, C);
  setBoundaryBlocks(water, ST.blocked);
  setColliders(water, ST.caps, capN);
}

function buildBoundary(b, C) {
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
    const lo = out[0][0], hi = out[count - 1][1];
    count = pushPair(pool, out, 0, lo, hi);
  }
  out.length = count;
  ST.blocked[b] = out;
}

function pushPair(pool, out, count, lo, hi) {
  let p = pool[count];
  if (!p) { p = [0, 0]; pool[count] = p; }
  p[0] = lo; p[1] = hi;
  out[count] = p;
  return count + 1;
}

// ---- water → structure ---------------------------------------------------

export function applyWaterForces(structure, water, dt) {
  if (!structure || !water) return;
  ensureState(structure, water);
  const C = CONFIG.coupling;
  const F = CONFIG.fluid;
  const g = water.cfg.g;
  const rho = C.density;
  const members = structure.members;
  if (ST.fxRaw.length !== members.length) ensureMembers(members.length);
  ST.clock += dt;

  ST.fxRaw.fill(0); ST.fyRaw.fill(0); ST.spd.fill(0);
  ST.impactMag.fill(0); ST.impactSpeed.fill(0);

  const forces = water.colliderForces;
  for (let i = 0; i < forces.length; i++) {
    const cf = forces[i];
    const mi = ST.capMi[cf.ci];
    if (mi >= members.length || members[mi] !== cf.ref) continue;
    ST.fxRaw[mi] += cf.fx;
    ST.fyRaw[mi] += cf.fy;
    ST.appX[mi] = cf.x;
    ST.appY[mi] = cf.y;
    if (Math.abs(cf.speed) > Math.abs(ST.spd[mi])) ST.spd[mi] = cf.speed;
  }

  // The reservoir exists before the dam is released, so applying its full load
  // as a step at t=0 would ring the whole truss. Fade it in instead.
  const ramp = C.rampTime > 0 ? Math.min(1, ST.clock / C.rampTime) : 1;
  // Short EMA: kills the single-frame spikes a discrete particle solve produces
  // at a face, keeps the multi-tick shape of a real wave impact.
  const aF = 1 - Math.exp(-dt / Math.max(1e-4, F.forceTau));
  const scale = C.pressureScale * ramp;

  for (let mi = 0; mi < members.length; mi++) {
    ST.fxS[mi] += (ST.fxRaw[mi] - ST.fxS[mi]) * aF;
    ST.fyS[mi] += (ST.fyRaw[mi] - ST.fyS[mi]) * aF;
    const m = members[mi];
    if (m.broken) { m.waterFx = 0; m.waterFy = 0; m.waterFperp = 0; continue; }
    const fx = ST.fxS[mi] * scale;
    const fy = ST.fyS[mi] * scale * C.verticalScale;

    // PUBLISHED per-member water load (ARCHITECTURE §5 v2.1). stress.js turns
    // waterFperp into bending; the renderer bows the member the other way.
    // Both are the EMA-smoothed force in game newtons — the same value the
    // nodes receive below, so what bends a member is exactly what pushes it.
    // SIGN CONVENTION: the perpendicular is the member axis a→b rotated +90°
    // (counter-clockwise), n = (−uy, ux). waterFperp > 0 therefore means the
    // water pushes toward that left-hand side of a→b, so for a vertical face
    // member built bottom→top (a low, b high) a downstream (+x) push reads
    // NEGATIVE. Only the magnitude enters bendLoad; the sign is for the
    // renderer's bow direction and for anyone asking which side is loaded.
    m.waterFx = fx;
    m.waterFy = fy;
    const pdx = m.b.x - m.a.x, pdy = m.b.y - m.a.y;
    const plen = Math.hypot(pdx, pdy);
    // A member that has never been wet has fxS exactly 0, so it reports exactly
    // zero; one that just came out of the water decays away with forceTau.
    m.waterFperp = plen > 1e-9 ? (fy * pdx - fx * pdy) / plen : 0;

    if (fx === 0 && fy === 0) continue;
    applyMemberForce(m, ST.appX[mi], ST.appY[mi], fx, fy);

    // Impact bookkeeping for the event layer: same meaning as v1 — how hard the
    // MOVING water hit, not how deep the still water is. rho·v²·(wetted length).
    const sp = ST.spd[mi];
    if (Math.abs(sp) >= C.impactSpeedMin) {
      const wet = wettedLength(m, water);
      if (wet > 0) {
        ST.impactMag[mi] = rho * C.impactScale * sp * sp * wet * ramp;
        ST.impactSpeed[mi] = sp;
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

// Length of the member that is under water (for the impact magnitude only).
function wettedLength(m, water) {
  const ay = m.a.y, by = m.b.y;
  const lo = Math.min(ay, by), hi = Math.max(ay, by);
  const s = Math.max(surfaceAt(water, m.a.x), surfaceAt(water, m.b.x));
  if (s <= lo) return 0;
  const top = s < hi ? s : hi;
  const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y;
  const len = Math.hypot(dx, dy);
  const span = hi - lo;
  if (span < 1e-6) return len;                 // horizontal member: all or nothing
  return len * ((top - lo) / span);
}

// Distribute a member's water load onto its two end nodes by lever arm along the
// member axis (t = 0 at a, 1 at b), so a force high up on a face genuinely tries
// to rotate it about the foot.
function applyMemberForce(m, x, y, fx, fy) {
  const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((x - m.a.x) * dx + (y - m.a.y) * dy) / l2 : 0.5;
  if (t < 0) t = 0; else if (t > 1) t = 1;
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

  // relative to the real flow field: the horizontal component from the column
  // average (defined everywhere there is water), the vertical from the MAC grid
  const dvx = velAt(water, nd.x) - nd.vx;
  const dvy = sampleV(water.fluid, nd.x, nd.y) - nd.vy;
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
  // The flux is measured from particles actually crossing the boundary.
  const off = C.eventOffFactor;
  // Quantisation floor: measured flux arrives one particle at a time, so the v1
  // continuous-model thresholds would fire on a single droplet.
  const floor = CONFIG.fluid.eventFlowParticles * (water.pvol || 0);
  const breachMin = Math.max(C.breachFlowMin, floor);
  const overtopMin = Math.max(C.overtopFlowMin, floor);
  for (let b = 1; b < water.n; b++) {
    if (!water.sealed[b]) { ST.breachNext[b] = -1e9; ST.overtopNext[b] = -1e9; continue; }
    const gap = Math.abs(water.gapFlow[b]);
    const weir = Math.abs(water.weirFlow[b]);

    if (gap > breachMin) {
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
    } else if (gap < breachMin * off) {
      ST.breachNext[b] = -1e9;
    }

    if (weir > overtopMin) {
      if (ST.clock >= ST.overtopNext[b] && ST.clock - ST.lastOvertopEvent >= C.eventMinInterval) {
        ST.overtopNext[b] = ST.clock + C.flowRepeat;
        ST.lastOvertopEvent = ST.clock;
        emit('overtop', { x: boundaryX(water, b), flow: water.weirFlow[b] });
      }
    } else if (weir < overtopMin * off) {
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
