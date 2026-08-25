// Game orchestrator: phase machine + fixed-timestep loop. FABLE owns.
// Update order per ARCHITECTURE.md §3. Other modules may import this one and
// call its functions at runtime (circular imports are fine at call time).

import { CONFIG } from '../config.js';
import { emit, on } from './events.js';
import { createCamera } from './camera.js';
import { initInput } from './input.js';
import { recordResult } from './state.js';

import * as structures from '../physics/structures.js';
import * as constraints from '../physics/constraints.js';
import * as stress from '../physics/stress.js';
import * as waterSim from '../physics/water.js';
import * as coupling from '../physics/coupling.js';

import * as builder from '../build/builder.js';
import { MATERIALS } from '../build/materials.js';
import * as modes from '../build/modes.js';

import * as renderer from '../rendering/renderer.js';
import * as waterRenderer from '../rendering/waterRenderer.js';
import * as effects from '../rendering/effects.js';

import * as hud from '../ui/hud.js';
import * as screens from '../ui/screens.js';
import * as debug from '../ui/debug.js';
import * as titleScene from '../ui/titleScene.js';
import * as loupe from '../rendering/loupe.js';

import { LEVELS } from '../levels/levels.js';
import { loadLevelSpec } from '../levels/levelLoader.js';

// ---- scene state ---------------------------------------------------------

const S = {
  phase: 'title',       // title | levelselect | build | sim | result | paused-overlay handled by simSpeed
  level: null,          // level spec
  levelIndex: 0,        // 1-based campaign position
  terrain: null,
  water: null,
  structure: null,      // physics structure (sim phase)
  design: null,         // build-time design (builder mutates)
  camera: null,
  simSpeed: 1,
  buildTimer: 0,        // countdown mode (s remaining)
  simTime: 0,
  stats: null,          // modes.js owns contents
  testScene: 0,
};

let canvas = null;
let ctx = null;
let accum = 0;
let lastNow = 0;
let frac = 0; // fractional ticks for 0.25× speed

export function getScene() { return S; }

// ---- boot ----------------------------------------------------------------

export function boot(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  S.camera = createCamera(canvas);
  initInput(canvas, S.camera);

  builder.initBuilder();
  modes.initModes();
  renderer.init(canvas);
  effects.init();
  hud.init();
  screens.init();
  debug.init();
  loupe.init();

  wireEvents();
  setPhase('title');
}

function wireEvents() {
  on('ui:level', ({ index }) => loadLevel(index));
  on('ui:release', () => release());
  on('ui:retry', () => retry());
  on('ui:edit', () => toEdit());
  on('ui:menu', () => setPhase(S.phase === 'title' ? 'title' : 'levelselect'));
  on('ui:speed', ({ v }) => setSpeed(v));

  on('input:pan', ({ dx, dy }) => S.camera && S.camera.pan(dx, dy));
  on('input:zoom', ({ px, py, factor }) => S.camera && S.camera.zoomAt(px, py, factor));

  on('input:key', ({ key }) => {
    if (key === ' ') {
      if (S.phase === 'build' && S.level && S.level.mode === 'freebuild') release();
      else if (S.phase === 'sim') setSpeed(S.simSpeed === 0 ? 1 : 0);
    } else if (key === 'r' || key === 'R') {
      if (S.phase === 'sim' || S.phase === 'result') retry();
    } else if (key === 'F2') {
      debug.toggle();
    } else if (key === 'Escape') {
      if (S.phase === 'sim' || S.phase === 'build') setPhase('levelselect');
    }
  });

  on('level:win', ({ stats }) => finishLevel(stats));
  on('level:fail', ({ stats }) => finishLevel(stats));
}

function finishLevel(stats) {
  if (S.phase !== 'sim') return;
  S.stats = stats;
  if (S.level && !S.level.isTest) recordResult(S.level.id, S.levelIndex, stats);
  setPhase('result');
}

// ---- phase machine -------------------------------------------------------

function setPhase(phase) {
  S.phase = phase;
  emit('phase:change', { phase });
}

export function loadLevel(index) {
  const spec = LEVELS[index - 1];
  if (!spec) return;
  S.levelIndex = index;
  startFromSpec(spec);
}

function startFromSpec(spec) {
  const { terrain, level } = loadLevelSpec(spec);
  S.level = level;
  S.terrain = terrain;
  S.design = { nodes: [], members: [] };
  S.structure = null;
  S.simSpeed = 1;
  S.simTime = 0;
  S.stats = null;
  S.buildTimer = level.mode === 'countdown' ? level.countdown : 0;

  S.water = waterSim.createWater(terrain, CONFIG.water);
  applyInitialWater();
  if (level.mode === 'countdown') applyFlood(); // flood visibly approaches during build

  S.camera.fit(terrain);
  builder.startLevel(level, terrain, S.design);
  modes.startLevel(level, terrain);
  effects.reset();
  setPhase('build');
}

function applyInitialWater() {
  const w = S.level.water || {};
  for (const pond of w.initial || []) waterSim.addWater(S.water, pond);
}

function applyFlood() {
  const w = S.level.water || {};
  if (w.flood) waterSim.addSource(S.water, w.flood);
}

export function release() {
  if (S.phase !== 'build') return;
  S.structure = structures.instantiate(S.design, S.terrain, MATERIALS);
  S.simTime = 0;
  if (S.level.mode !== 'countdown') applyFlood();
  modes.startSim(S.level, S.stats);
  emit('sim:start', {});
  setPhase('sim');
}

export function retry() {
  // near-instant: fresh water + structure from the same design
  emit('sim:reset', {});
  const level = S.level;
  S.water = waterSim.createWater(S.terrain, CONFIG.water);
  applyInitialWater();
  S.structure = structures.instantiate(S.design, S.terrain, MATERIALS);
  S.simTime = 0;
  S.simSpeed = 1;
  applyFlood();
  modes.startSim(level, null);
  effects.reset();
  emit('sim:start', {});
  setPhase('sim');
}

export function toEdit() {
  emit('sim:reset', {});
  S.structure = null;
  S.simTime = 0;
  S.simSpeed = 1;
  S.water = waterSim.createWater(S.terrain, CONFIG.water);
  applyInitialWater();
  if (S.level.mode === 'countdown') S.buildTimer = S.level.countdown;
  if (S.level.mode === 'countdown') applyFlood();
  effects.reset();
  setPhase('build');
}

export function setSpeed(v) { S.simSpeed = v; }

export async function loadTestScene(i) {
  try {
    const mod = await import('../../tests/scenes.js');
    const spec = mod.testLevel(i);
    if (spec) { S.levelIndex = 0; S.testScene = i; startFromSpec(spec); }
  } catch (err) {
    console.warn('test scenes unavailable', err);
  }
}

// ---- fixed-timestep loop -------------------------------------------------

export function frame(now) {
  const dtReal = Math.min((now - lastNow) / 1000 || 0, CONFIG.physics.maxAccum);
  lastNow = now;

  if (S.phase === 'sim' || S.phase === 'build') {
    accum += dtReal;
    const dt = CONFIG.physics.dt;
    while (accum >= dt) {
      accum -= dt;
      frac += S.simSpeed;
      while (frac >= 1) { frac -= 1; tick(dt); }
    }
  }

  draw(dtReal);
}

function tick(dt) {
  const sim = S.phase === 'sim';

  if (S.phase === 'build') {
    // countdown mode: timer runs and flood water moves during construction
    if (S.level && S.level.mode === 'countdown') {
      S.buildTimer -= dt;
      waterSim.stepWater(S.water, dt);
      if (S.buildTimer <= 0) { S.buildTimer = 0; release(); }
    }
    return;
  }

  if (!sim) return;
  S.simTime += dt;

  coupling.updateObstructions(S.structure, S.water);
  waterSim.stepWater(S.water, dt);
  coupling.applyWaterForces(S.structure, S.water, dt);
  constraints.stepStructure(S.structure, S.terrain, dt);
  stress.updateStress(S.structure, dt, S.simTime);
  modes.update(dt);
}

function draw(dtReal) {
  effects.step(dtReal);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (S.phase === 'title' || S.phase === 'levelselect') {
    titleScene.render(ctx, dtReal, S.phase); // live diorama behind the menus
  }
  if (S.terrain && S.phase !== 'title' && S.phase !== 'levelselect') {
    renderer.render(ctx, S.camera, S);
    waterRenderer.render(ctx, S.camera, S.water, S);
    effects.render(ctx, S.camera);
    debug.render(ctx, S.camera, S);
    loupe.render(ctx, S);
  }
  hud.update(S);
}
