// OPUS C owns. Spray/foam/debris particles, camera shake. Contract §9.
// Listens: member:break, water:impact, breach, overtop. Visual randomness OK
// (this is the one file in the game allowed to call Math.random()).
//
// Pool strategy: a fixed CONFIG.render.maxParticles array of plain particle
// objects is created once at module load and never grown. Spawning reuses a
// dead slot (ring-buffer cursor) or, once the pool is saturated, steals the
// particle with the least life remaining. step()/render() never allocate an
// object, array, or closure; the handful of small color/geometry helpers run
// only at spawn time (bounded by emit rate, not by pool size or frame rate),
// and even there every particle color is a *reference* to an existing string
// (mat.color / mat.darkColor / a CONFIG.render color) rather than a newly
// built one, so there is truly no per-frame string allocation either.
//
// Continuous events (breach/overtop) are turned into a small fixed table of
// "jets" (upserted, not appended) that step() drains every frame instead of
// reacting to each individual event — see §6 note in the task brief on why
// coupling re-emits these repeatedly.

import { CONFIG } from '../config.js';
import { on } from '../core/events.js';
import { getScene } from '../core/game.js';
import { MATERIALS } from '../build/materials.js';
import * as waterSim from '../physics/water.js';

// ---- particle kinds --------------------------------------------------------

const PKIND_DROPLET = 0;
const PKIND_FOAM = 1;
const PKIND_MIST = 2;
const PKIND_SPLINTER = 3;
const PKIND_DUST = 4;
const PKIND_RING = 5;

// ---- pool (allocated once, at module load; never grown) -------------------

const POOL_SIZE = CONFIG.render.maxParticles;
const pool = new Array(POOL_SIZE);
for (let i = 0; i < POOL_SIZE; i++) pool[i] = makeParticle();
let cursor = 0;

function makeParticle() {
  return {
    alive: false,
    kind: PKIND_DROPLET,
    x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1,
    size: 0,            // splinter: world-metre length. everything else: nominal px (×dpr at draw)
    rot: 0, rotV: 0,
    color: '#ffffff',   // always a reference to an existing string, never built per-frame
    maxAlpha: 1,
    gravMul: 1,
    dragMul: 1,
    groundKill: false,  // droplets only: die when they cross below the terrain
  };
}

// Reuse a dead slot (round-robin scan from the cursor); if every slot is
// alive, steal whichever particle has the least life left rather than grow
// the pool or drop the new one silently.
function allocParticle(kind) {
  const n = pool.length;
  let idx = cursor;
  for (let tries = 0; tries < n; tries++) {
    const p = pool[idx];
    if (!p.alive) {
      cursor = (idx + 1) % n;
      p.alive = true; p.kind = kind;
      return p;
    }
    idx = (idx + 1) % n;
  }
  let best = 0, bestLife = Infinity;
  for (let i = 0; i < n; i++) {
    if (pool[i].life < bestLife) { bestLife = pool[i].life; best = i; }
  }
  cursor = (best + 1) % n;
  const p = pool[best];
  p.alive = true; p.kind = kind;
  return p;
}

// ---- continuous jets (breach / overtop) ------------------------------------
// A tiny fixed table, upserted by rounded x rather than appended per event, so
// a boundary that keeps re-crossing its flow threshold (see CONFIG.coupling.
// eventMinInterval) reads as one continuous spray instead of a burst storm.

const JKIND_BREACH = 0;
const JKIND_OVERTOP = 1;
const JET_SLOTS = 16; // technical capacity, not a balance knob: far more than any level has active dam faces

const jets = new Array(JET_SLOTS);
for (let i = 0; i < JET_SLOTS; i++) {
  jets[i] = {
    active: false, kind: JKIND_BREACH, key: 0,
    x: 0, y: 0, flow: 0,
    until: -1e9, lastTouch: -1e9,
    acc: 0, foamAcc: 0, mistCount: 0,
  };
}

function findActiveJet(kind, key) {
  for (let i = 0; i < jets.length; i++) {
    const s = jets[i];
    if (s.active && s.kind === kind && s.key === key) return s;
  }
  return null;
}

function findFreeJet() {
  for (let i = 0; i < jets.length; i++) if (!jets[i].active) return jets[i];
  return null;
}

function findSoonestExpiringJet() {
  let best = jets[0];
  for (let i = 1; i < jets.length; i++) if (jets[i].until < best.until) best = jets[i];
  return best;
}

function upsertJet(kind, x, y, flow) {
  // key on x AND y: a second gap opening lower down the same face is a NEW
  // event the player must notice, not a continuation of the one above it
  const key = Math.round(x * 10) * 4096 + Math.round(y * 5);
  let slot = findActiveJet(kind, key);
  let isNew = false;
  if (!slot) { slot = findFreeJet(); isNew = true; }
  if (!slot) { slot = findSoonestExpiringJet(); isNew = true; }
  if (isNew && kind === JKIND_BREACH && ringIsNew(x, y)) spawnRing(x, y);

  const R = CONFIG.render;
  if (!isNew && clock - slot.lastTouch < R.emitThrottle) {
    // Re-fired faster than needed: just extend the hold, skip the rest of the
    // upsert work (CONFIG.render.emitThrottle — avoids re-processing bursts
    // more often than the emitter can actually be re-triggered).
    slot.until = clock + R.jetHold;
    slot.flow = flow;
    return;
  }
  if (isNew) { slot.acc = 0; slot.foamAcc = 0; slot.mistCount = 0; }
  slot.active = true; slot.kind = kind; slot.key = key;
  slot.x = x; slot.y = y; slot.flow = flow;
  slot.until = clock + R.jetHold;
  slot.lastTouch = clock;
}

// ---- new-leak cue bookkeeping ----------------------------------------------
// A breach re-announces itself every CONFIG.coupling.flowRepeat seconds and its
// gap geometry drifts, so "is this a NEW leak?" needs a coarse, decaying site
// memory rather than the exact jet key.
const RING_SITES = 8;
const ringKey = new Int32Array(RING_SITES);
const ringSeen = new Float64Array(RING_SITES);
let lastRingAt = -1e9;

function ringIsNew(x, y) {
  const R = CONFIG.render;
  if (clock - lastRingAt < R.ringCooldown) return false;
  if (countKind(PKIND_RING) >= R.maxRings) return false;
  const key = (Math.round(x) * 4096 + Math.round(y)) | 0;
  let free = -1;
  for (let i = 0; i < RING_SITES; i++) {
    if (ringKey[i] === key && clock - ringSeen[i] < R.ringSiteMemory) {
      ringSeen[i] = clock;
      return false;                       // this site already announced itself
    }
    if (free < 0 && clock - ringSeen[i] >= R.ringSiteMemory) free = i;
  }
  const slot = free >= 0 ? free : 0;
  ringKey[slot] = key;
  ringSeen[slot] = clock;
  lastRingAt = clock;
  return true;
}

// ---- camera shake -----------------------------------------------------------

let shakeAmp = 0;
let shakePhase = 0;
// Oscillation frequencies: no CONFIG.render knob exists for these (only the
// decay rate and cap do), so they're fixed local constants — see report.
const SHAKE_FREQ_X = 46;
const SHAKE_FREQ_Y = 33;

function addShake(amount) {
  if (!(amount > 0)) return;
  shakeAmp = Math.min(CONFIG.render.shakeMax, shakeAmp + amount);
}

function updateShake(dt) {
  const R = CONFIG.render;
  if (shakeAmp > 0) {
    shakeAmp *= Math.exp(-R.shakeDecay * dt);
    if (shakeAmp < 0.02) shakeAmp = 0;
  }
  shakePhase += dt;
  const scene = getScene();
  const cam = scene && scene.camera;
  if (!cam) return;
  if (shakeAmp <= 0) { cam.shakeX = 0; cam.shakeY = 0; return; }
  let sx = Math.sin(shakePhase * SHAKE_FREQ_X) * shakeAmp;
  let sy = Math.sin(shakePhase * SHAKE_FREQ_Y + 1.7) * shakeAmp;
  if (sx > R.shakeMax) sx = R.shakeMax; else if (sx < -R.shakeMax) sx = -R.shakeMax;
  if (sy > R.shakeMax) sy = R.shakeMax; else if (sy < -R.shakeMax) sy = -R.shakeMax;
  cam.shakeX = sx;
  cam.shakeY = sy;
}

// ---- event handlers ---------------------------------------------------------

function onMemberBreak({ id, x, y, matId, load }) {
  const R = CONFIG.render;
  const mat = MATERIALS[matId];
  const scene = getScene();
  const structure = scene && scene.structure;

  let mass = R.shakeMassRef * 0.3; // fallback if the member can't be found any more
  let ax = 1, ay = 0;
  if (structure && structure.memberById) {
    const mem = structure.memberById.get(id);
    if (mem) {
      const mm = mem.mat || mat;
      mass = (mm && mm.massPerMeter || 0) * mem.restLength;
      const dx = mem.b.x - mem.a.x, dy = mem.b.y - mem.a.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) { ax = dx / len; ay = dy / len; }
    }
  }

  const massScale = Math.min(1, mass / R.shakeMassRef);
  const count = Math.max(3, Math.round(R.breakParticles * (0.4 + 0.6 * massScale)));
  const nx = -ay, ny = ax; // axis normal, for spread perpendicular to the broken member

  for (let i = 0; i < count; i++) {
    const p = allocParticle(PKIND_SPLINTER);
    const spread = (Math.random() - 0.5) * 1.8;
    let dx = ax + nx * spread, dy = ay + ny * spread;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    const speed = (1.5 + Math.random() * 4) * (0.5 + massScale);
    p.x = x + (Math.random() - 0.5) * 0.2;
    p.y = y + (Math.random() - 0.5) * 0.2;
    p.vx = dx * speed;
    p.vy = dy * speed + 1.2 + Math.random(); // a bit of upward pop regardless of axis
    p.maxLife = R.splinterLife * (0.6 + Math.random() * 0.7);
    p.life = p.maxLife;
    p.size = 0.10 + Math.random() * 0.24; // world-metre length
    p.rot = Math.random() * Math.PI * 2;
    p.rotV = (Math.random() - 0.5) * 10;
    p.color = mat ? (Math.random() < 0.5 ? mat.color : mat.darkColor) : R.brokenColor;
    p.maxAlpha = 1;
    p.gravMul = 1;
    p.dragMul = 1;
    p.groundKill = false;
  }

  const dustN = Math.max(2, Math.round(count * 0.4));
  for (let i = 0; i < dustN; i++) {
    const p = allocParticle(PKIND_DUST);
    p.x = x + (Math.random() - 0.5) * 0.5;
    p.y = y + (Math.random() - 0.5) * 0.5;
    const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 1.4;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp * 0.5 + 0.6;
    p.maxLife = R.splinterLife * 0.5 * (0.6 + Math.random() * 0.6);
    p.life = p.maxLife;
    p.size = R.foamPx * (1 + Math.random() * 1.2);
    p.rot = 0; p.rotV = 0;
    p.color = mat ? mat.darkColor : R.brokenColor;
    p.maxAlpha = 0.5;
    p.gravMul = 0.2;
    p.dragMul = 3;
    p.groundKill = false;
  }

  // Severity, not just size: `load` is the pre-break utilisation, so a member
  // that let go at the hard-break threshold jolts the camera harder than one
  // that quietly wore out at damage 1.0. Mass still scales it — a snapped
  // cable should never shake the screen like a concrete beam.
  const severity = load > 0
    ? Math.min(1, Math.max(0, (load - 1) / Math.max(0.01, R.shakeBigLoad - 1)))
    : 0;
  addShake(R.shakeBreak * massScale * (0.55 + 0.45 * severity));
}

// `dir` is the sign of the water's velocity at the impact, so the splash can
// throw back UPSTREAM off the dam face (-dir) the way real spray does, instead
// of fountaining symmetrically.
function onWaterImpact({ x, y, speed, magnitude, dir }) {
  const back = dir === undefined ? 0 : -dir;
  const R = CONFIG.render, C = CONFIG.coupling;
  const mScale = clamp(magnitude / C.impactEventMin, 1, 6);
  const launch = Math.max(1, speed) * (0.7 + 0.3 * mScale);
  const sizeMul = Math.sqrt(mScale);

  const n = Math.max(4, Math.round(R.impactParticles * mScale));
  for (let i = 0; i < n; i++) {
    spawnDroplet(
      x + (Math.random() - 0.5) * 0.3, y + (Math.random() - 0.5) * 0.15,
      ((Math.random() - 0.5) + back * 0.8) * launch, launch * (0.5 + Math.random() * 0.8),
      R.sprayLife * (0.6 + Math.random() * 0.6), R.foamPx * (0.4 + Math.random() * 0.5) * sizeMul, true);
  }

  const foamN = Math.max(2, Math.round(2 * mScale));
  for (let i = 0; i < foamN; i++) {
    spawnFoam(
      x + (Math.random() - 0.5) * 0.6, y + Math.random() * 0.3,
      ((Math.random() - 0.5) * 0.4 + back * 0.5) * launch, launch * 0.25 + Math.random() * 0.5,
      R.sprayLife * (1.0 + Math.random() * 0.5), R.foamPx * (1.1 + Math.random() * 0.9) * sizeMul,
      0.4, 2, R.foamSpriteAlpha);
  }

  // Shake is for EVENTS, not for weather: water:impact fires every
  // CONFIG.coupling.impactCooldown seconds all through a flood, so only the top
  // half of the magnitude range shakes at all, and never at full strength — a
  // snapping concrete beam has to stay the biggest jolt in the game.
  const big = (magnitude - R.shakeImpactRef * 0.5) / (R.shakeImpactRef * 0.5);
  if (big > 0) addShake(R.shakeMax * clamp(big, 0, 1) * 0.6);
}

function onBreach({ x, y, flow }) {
  upsertJet(JKIND_BREACH, x, y, flow);
}

function onOvertop({ x, flow }) {
  const scene = getScene();
  const water = scene && scene.water;
  if (!water) return; // payload has no y; without water there's nothing to anchor the mist to
  const b = waterSim.boundaryIndex(water, x);
  const y = water.crest ? water.crest[b] : waterSim.surfaceAt(water, x);
  upsertJet(JKIND_OVERTOP, x, y, flow);
}

// ---- shared spawn helpers ----------------------------------------------------
// Every particle field is set here from primitives; `color` is always a
// reference to an existing CONFIG.render / materials.js string, never one
// built per spawn, so even these bounded, rate-limited allocation points stay
// string-allocation-free.

function spawnDroplet(x, y, vx, vy, life, size, groundKill) {
  const p = allocParticle(PKIND_DROPLET);
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.maxLife = life; p.life = life;
  p.size = size;
  p.rot = 0; p.rotV = 0;
  p.color = Math.random() < 0.5 ? CONFIG.render.waterSurfaceColor : CONFIG.render.waterShallow;
  p.maxAlpha = 0.85 + Math.random() * 0.1;
  p.gravMul = 1;
  p.dragMul = 1;
  p.groundKill = groundKill;
}

// Expanding ring at a brand-new leak: the "look here" cue for a stress failure
// that has just started passing water.
function spawnRing(x, y) {
  const R = CONFIG.render;
  const p = allocParticle(PKIND_RING);
  p.x = x; p.y = y; p.vx = 0; p.vy = 0;
  p.maxLife = R.ringLife; p.life = R.ringLife;
  p.size = 0;
  p.rot = 0; p.rotV = 0;
  p.color = R.ringColor;
  p.maxAlpha = 0.95;
  p.gravMul = 0; p.dragMul = 0;
  p.groundKill = false;
}

function spawnFoam(x, y, vx, vy, life, size, gravMul, dragMul, alpha) {
  // Capped like mist: foam is the other sprite that used to stack into an
  // opaque white puff sitting on top of the dam.
  if (countKind(PKIND_FOAM) >= CONFIG.render.maxFoam) return;
  const p = allocParticle(PKIND_FOAM);
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.maxLife = life; p.life = life;
  p.size = size;
  p.rot = 0; p.rotV = 0;
  p.color = CONFIG.render.foamColor;
  p.maxAlpha = alpha;
  p.gravMul = gravMul;
  p.dragMul = dragMul;
  p.groundKill = false;
}

// ---- jet draining (called from step) ---------------------------------------

function spawnBreachDroplet(j, dir, strength) {
  const R = CONFIG.render;
  const speed = (2.5 + Math.random() * 3.5) * (0.6 + 0.4 * strength);
  spawnDroplet(
    j.x + (Math.random() - 0.5) * 0.15, j.y + (Math.random() - 0.5) * 0.2,
    dir * speed, (Math.random() - 0.5) * 2,
    R.sprayLife * (0.6 + Math.random() * 0.6), R.foamPx * (0.4 + Math.random() * 0.5), true);
}

function spawnLandingFoam(j, dir, strength) {
  const R = CONFIG.render;
  spawnFoam(
    j.x + dir * (0.6 + Math.random() * 1.2) * strength, j.y - Math.random() * 0.3,
    dir * (0.5 + Math.random()), 0.3 + Math.random() * 0.4,
    R.sprayLife * (1.0 + Math.random() * 0.5), R.foamPx * (1.5 + Math.random() * 1.5),
    0.3, 2.5, 0.75);
}

function countKind(kind) {
  let n = 0;
  for (let i = 0; i < pool.length; i++) if (pool[i].alive && pool[i].kind === kind) n++;
  return n;
}

function spawnMist(j, dir, strength) {
  const R = CONFIG.render;
  // The FLUID is the overtopping now — particles pour over the crest by
  // themselves. Mist is a thin garnish on top of that, and it is HARD CAPPED:
  // unbounded sprite stacking at the dam face is what turned overtopping into
  // an opaque white blob that hid the dam.
  if (countKind(PKIND_MIST) >= R.maxMist) return;
  const p = allocParticle(PKIND_MIST);
  p.x = j.x + (Math.random() - 0.5) * 0.6;
  p.y = j.y + (Math.random() - 0.5) * 0.3;
  p.vx = dir * (0.4 + Math.random() * 0.8) * (0.6 + 0.4 * strength);
  p.vy = -(0.2 + Math.random() * 0.4);
  p.maxLife = R.mistLife * (0.7 + Math.random() * 0.6);
  p.life = p.maxLife;
  p.size = R.foamPx * (2.4 + Math.random() * 2);
  p.rot = 0; p.rotV = 0;
  p.color = R.foamColor;
  p.maxAlpha = R.mistAlpha;
  p.gravMul = 0.25;
  p.dragMul = 1.6;
  p.groundKill = false;
}

function spawnOvertopDroplet(j, dir, strength) {
  const R = CONFIG.render;
  spawnDroplet(
    j.x + (Math.random() - 0.5) * 0.3, j.y + Math.random() * 0.15,
    dir * (1 + Math.random() * 1.5) * (0.6 + 0.4 * strength), -(0.3 + Math.random() * 0.6),
    R.sprayLife * (0.6 + Math.random() * 0.5), R.foamPx * (0.4 + Math.random() * 0.4), true);
}

function updateJets(h) {
  const R = CONFIG.render, C = CONFIG.coupling;
  for (let i = 0; i < jets.length; i++) {
    const j = jets[i];
    if (!j.active) continue;
    if (clock > j.until) { j.active = false; continue; }
    const dir = j.flow >= 0 ? 1 : -1;

    if (j.kind === JKIND_BREACH) {
      const strength = clamp(Math.abs(j.flow) / C.breachFlowMin, 1, 5);
      j.acc += R.breachRate * strength * h;   // rate is now a garnish (see CONFIG)
      while (j.acc >= 1) { j.acc -= 1; spawnBreachDroplet(j, dir, strength); }
      j.foamAcc += R.breachRate * 0.15 * strength * h;
      while (j.foamAcc >= 1) { j.foamAcc -= 1; spawnLandingFoam(j, dir, strength); }
    } else {
      const strength = clamp(Math.abs(j.flow) / C.overtopFlowMin, 1, 5);
      j.acc += R.overtopRate * strength * h;
      while (j.acc >= 1) {
        j.acc -= 1;
        spawnMist(j, dir, strength);
        j.mistCount++;
        if (j.mistCount % 3 === 0) spawnOvertopDroplet(j, dir, strength);
      }
    }
  }
}

// ---- particle integration ---------------------------------------------------

function integrateParticles(h) {
  const R = CONFIG.render;
  const g = R.particleGravity, drag = R.particleDrag;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive) continue;
    if (p.kind === PKIND_RING) continue;   // aged in real time, see ageRings()
    p.life -= h;
    if (p.life <= 0) { p.alive = false; continue; }
    p.vy -= g * p.gravMul * h;
    const k = 1 - drag * p.dragMul * h;
    if (k > 0) { p.vx *= k; p.vy *= k; } else { p.vx = 0; p.vy = 0; }
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.rot += p.rotV * h;
  }
}

// One terrain sample per grounded particle per FRAME (not per substep), per
// the brief's "at most one call per particle per frame" budget.
function groundCull() {
  const scene = getScene();
  const terrain = scene && scene.terrain;
  if (!terrain) return;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive || !p.groundKill) continue;
    const gy = terrain.heightAt(p.x);
    if (gy != null && p.y < gy) p.alive = false;
  }
}

// ---- contract ---------------------------------------------------------------

let clock = 0; // advances with sim-speed-scaled time; freezes at simSpeed 0

export function init() {
  on('member:break', onMemberBreak);
  on('water:impact', onWaterImpact);
  on('breach', onBreach);
  on('overtop', onOvertop);
  reset();
}

// Live particle count, for the F2 debug overlay (ui/debug.js).
export function count() {
  let n = 0;
  for (let i = 0; i < pool.length; i++) if (pool[i].alive) n++;
  return n;
}

export function reset() {
  for (let i = 0; i < pool.length; i++) pool[i].alive = false;
  for (let i = 0; i < jets.length; i++) {
    const j = jets[i];
    j.active = false; j.acc = 0; j.foamAcc = 0; j.mistCount = 0; j.until = -1e9; j.lastTouch = -1e9;
  }
  shakeAmp = 0;
  shakePhase = 0;
  clock = 0;
  lastRingAt = -1e9;
  ringSeen.fill(-1e9);
  const scene = getScene();
  if (scene && scene.camera) { scene.camera.shakeX = 0; scene.camera.shakeY = 0; }
}

const MAX_SUBSTEP = 0.1; // s; caps a single integration step so 4× sim speed can't teleport particles

export function step(dt) {
  const scene = getScene();
  const mul = scene && scene.phase === 'sim' ? scene.simSpeed : 1;
  let scaled = dt * mul;
  if (!(scaled > 0)) { updateShake(0); return; }
  if (scaled > 1) scaled = 1; // sanity clamp (dt itself is already ≤ physics.maxAccum, mul ≤ 4)
  clock += scaled;

  let remaining = scaled;
  while (remaining > 1e-9) {
    const h = remaining > MAX_SUBSTEP ? MAX_SUBSTEP : remaining;
    remaining -= h;
    integrateParticles(h);
    updateJets(h);
  }
  groundCull();
  ageRings(dt);
  updateShake(scaled);
}

// The "a new leak just opened" cue must last the same wall-clock time at 1x and
// at 4x, so it is aged by REAL dt rather than sim-scaled dt.
function ageRings(dtReal) {
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive || p.kind !== PKIND_RING) continue;
    p.life -= dtReal;
    if (p.life <= 0) p.alive = false;
  }
}

export function render(ctx, cam) {
  const canvas = ctx.canvas;
  const w = canvas.width, h = canvas.height;
  let dpr = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
  if (!(dpr > 0) || !isFinite(dpr)) dpr = 1;

  const camX = cam.x, camY = cam.y, zoom = cam.zoom;
  const hw = w / 2, hh = h / 2;
  const shx = cam.shakeX || 0, shy = cam.shakeY || 0;
  const margin = 48;

  ctx.save();
  drawKind(ctx, PKIND_MIST, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  drawKind(ctx, PKIND_FOAM, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  drawKind(ctx, PKIND_DUST, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  drawKind(ctx, PKIND_DROPLET, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  drawKind(ctx, PKIND_SPLINTER, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  drawKind(ctx, PKIND_RING, camX, camY, zoom, hw, hh, shx, shy, w, h, margin, dpr);
  ctx.restore();
}

function drawKind(ctx, kind, camX, camY, zoom, hw, hh, shx, shy, cw, ch, margin, dpr) {
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive || p.kind !== kind) continue;

    // Inlined worldToScreen (mirrors core/camera.js exactly, shake included) —
    // no [x,y] destructuring / array allocation in this per-particle loop.
    const sx = (p.x - camX) * zoom + hw + shx;
    const sy = hh - (p.y - camY) * zoom + shy;
    if (sx < -margin || sx > cw + margin || sy < -margin || sy > ch + margin) continue;

    const lifeFrac = p.maxLife > 0 ? p.life / p.maxLife : 0;
    const age = 1 - lifeFrac;
    let alpha = p.maxAlpha;
    if (age < 0.08) alpha *= age / 0.08;
    else if (lifeFrac < 0.35) alpha *= lifeFrac / 0.35;
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;

    switch (kind) {
      // A droplet is round. It used to be a fillRect, which was defensible when
      // the bulk water was a heightfield polygon and nothing else in the frame
      // was drop-shaped — but the fluid now throws real spray, and a square
      // sitting next to a round particle blob reads as a rendering bug.
      case PKIND_DROPLET: {
        const s = Math.max(0.75, p.size * dpr * 0.6);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sx, sy, s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case PKIND_DUST: {
        const s = Math.max(1, p.size * dpr);
        ctx.fillStyle = p.color;
        ctx.fillRect(sx - s * 0.5, sy - s * 0.5, s, s);
        break;
      }
      case PKIND_FOAM: {
        const s = Math.max(1.5, p.size * dpr);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sx, sy, s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case PKIND_MIST: {
        const s = Math.max(3, p.size * dpr);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sx, sy, s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case PKIND_RING: {
        const R = CONFIG.render;
        const rr = (R.ringR0 + (R.ringR1 - R.ringR0) * age) * zoom;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, R.ringWidthPx * dpr * (1 - age * 0.6));
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case PKIND_SPLINTER: {
        const half = Math.max(0.02, p.size) * zoom * 0.5;
        const dx = Math.cos(p.rot) * half, dy = Math.sin(p.rot) * half;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.2 * dpr, half * 0.3);
        ctx.beginPath();
        ctx.moveTo(sx - dx, sy - dy);
        ctx.lineTo(sx + dx, sy + dy);
        ctx.stroke();
        break;
      }
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
