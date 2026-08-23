// OPUS A owns. DOM-free Node test helpers for tests/scenes.js + tests/run.js.
// Written against ARCHITECTURE.md, not against the (currently stub) physics
// modules being rewritten in parallel.

import { createTerrain } from '../src/core/terrain.js';
import { createWater, addWater, addSource, stepWater } from '../src/physics/water.js';
import * as structuresMod from '../src/physics/structures.js';
import * as couplingMod from '../src/physics/coupling.js';
import * as constraintsMod from '../src/physics/constraints.js';
import * as stressMod from '../src/physics/stress.js';
import { MATERIALS } from '../src/build/materials.js';
import { CONFIG } from '../src/config.js';
import { on } from '../src/core/events.js';

// Builds {terrain, water, structure, design, level} from a level-spec-shaped
// object (ARCHITECTURE §8, plus isTest/testDesign/testMeta).
export function buildScene(spec) {
  const terrain = createTerrain(spec.terrain, spec.anchors || []);
  const water = createWater(terrain, CONFIG.water);
  const initial = (spec.water && spec.water.initial) || [];
  for (const w of initial) addWater(water, w);
  if (spec.water && spec.water.flood) addSource(water, spec.water.flood);
  const design = spec.testDesign || { nodes: [], members: [] };
  const structure = structuresMod.instantiate(design, terrain, MATERIALS);
  return { terrain, water, structure, design, level: spec };
}

// Subscribes to the four canonical events and tags each recorded entry with
// the sim time. `rec.time` must be kept in sync by the stepper (runSim does
// this) — never Date.now, this stays deterministic.
export function createRecorder() {
  const rec = { time: 0, breaks: [], impacts: [], breaches: [], overtops: [] };
  const offBreak = on('member:break', (p) => rec.breaks.push({ ...p, time: rec.time }));
  const offImpact = on('water:impact', (p) => rec.impacts.push({ ...p, time: rec.time }));
  const offBreach = on('breach', (p) => rec.breaches.push({ ...p, time: rec.time }));
  const offOvertop = on('overtop', (p) => rec.overtops.push({ ...p, time: rec.time }));
  rec.stop = () => { offBreak(); offImpact(); offBreach(); offOvertop(); };
  return rec;
}

// Steps sceneCtx at CONFIG.physics.dt for `seconds`, in the exact order from
// ARCHITECTURE §3 (mode/effects steps are Fable/Opus-C concerns, not run here).
// onTick(time, sceneCtx) fires after each tick; recorder.time is set to the
// new tick time BEFORE that tick's physics run, so events emitted during the
// tick land with the correct time. Returns the elapsed sim time.
export function runSim(sceneCtx, seconds, { onTick, recorder } = {}) {
  const dt = CONFIG.physics.dt;
  const { terrain, water, structure } = sceneCtx;
  const steps = Math.round(seconds / dt);
  let time = 0;
  for (let i = 0; i < steps; i++) {
    time += dt;
    if (recorder) recorder.time = time;
    couplingMod.updateObstructions(structure, water);
    stepWater(water, dt);
    couplingMod.applyWaterForces(structure, water, dt);
    constraintsMod.stepStructure(structure, terrain, dt);
    stressMod.updateStress(structure, dt, time);
    if (onTick) onTick(time, sceneCtx);
  }
  return time;
}

function sig4(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  if (n === 0) return '0';
  return Number(n.toPrecision(4)).toString();
}

// Assertion suite that collects results instead of throwing.
export function createSuite(name) {
  const results = [];
  function record(pass, label, detail) {
    results.push({ pass: !!pass, label, detail: detail || '' });
    return !!pass;
  }
  return {
    name,
    ok(cond, label, detail = '') { return record(cond, label, detail); },
    gt(a, b, label) { return record(a > b, label, `${sig4(a)} > ${sig4(b)}`); },
    lt(a, b, label) { return record(a < b, label, `${sig4(a)} < ${sig4(b)}`); },
    near(a, b, tol, label) { return record(Math.abs(a - b) <= tol, label, `${sig4(a)} ~= ${sig4(b)} (tol ${sig4(tol)})`); },
    eq(a, b, label) { return record(a === b, label, `${sig4(a)} === ${sig4(b)}`); },
    results() { return results; },
  };
}

export function snapshotPositions(structure) {
  const map = new Map();
  for (const n of structure.nodes) map.set(n.id, { x: n.x, y: n.y });
  return map;
}

export function maxNodeDrift(structure, initialPositions) {
  let max = 0;
  for (const n of structure.nodes) {
    const p0 = initialPositions.get(n.id);
    if (!p0) continue;
    const d = Math.hypot(n.x - p0.x, n.y - p0.y);
    if (d > max) max = d;
  }
  return max;
}

export function memberById(structure, id) {
  return structure.members.find((m) => m.id === id);
}

export function avgLoad(structure, ids) {
  let sum = 0;
  let count = 0;
  for (const id of ids) {
    const m = memberById(structure, id);
    if (!m) continue;
    sum += m.load;
    count++;
  }
  return count ? sum / count : 0;
}

export function anyBroken(structure, ids) {
  return ids.some((id) => {
    const m = memberById(structure, id);
    return !!(m && m.broken);
  });
}
