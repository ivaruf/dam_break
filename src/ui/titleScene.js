// OPUS C owns. The live fluid diorama behind the title and level-select menus.
// Contract: game.js calls render(ctx, dtReal, phase) every animation frame while
// the phase is 'title' or 'levelselect'; this module self-initialises lazily and
// must never touch the game's own scene.
//
// WHAT THIS IS: not a decoration, and not a loop of pre-baked frames. It is the
// REAL engine — src/core/terrain.js, src/physics/{water,coupling,constraints,
// stress,structures}.js, src/rendering/{renderer,waterRenderer}.js — running a
// second, private world on its own instances, in the exact update order of
// ARCHITECTURE.md §3. The reservoir rises because a source is pouring into it,
// the timber face bows because the pressure solve is pushing on it, and the dam
// breaks because its accumulated damage reaches 1. Nothing in the ~26 s loop is
// scripted except the numbers in CONFIG.render.title.
//
// WHY THAT IS WORTH THE COST: the first thing a player sees is the game's own
// physics telling them what the game is about — water arrives, timber bows, then
// it lets go. A CSS gradient cannot make that promise.
//
// DETERMINISM: no Math.random anywhere here, and every cycle rebuilds fresh
// water + structure instances from the same config, so cycle N is
// bit-identical to cycle 0. (The physics is already deterministic; the only
// thing that could drift is state carried across a cycle, so nothing is.)
//
// ISOLATION, in four parts:
//   1. Its own terrain / water / structure / camera. game.getScene() is never
//      read and never written.
//   2. Its own camera OBJECT, so effects.js's shake — which writes to the game
//      camera — can never move this framing, and this framing can never move
//      the game's.
//   3. It only steps while game.js is actually calling it (the accumulator is
//      fed from dtReal), and the catch-up is clamped to under two ticks, so
//      returning to the menu after a level cannot fast-forward a burst.
//   4. Any throw disables the whole thing permanently and silently. The menu
//      must never be the reason the game is unplayable.
//
// ONE ACCEPTED SIDE EFFECT: stress.js and coupling.js emit 'member:break',
// 'breach', 'overtop' and 'water:impact' on the GLOBAL bus, and there is no way
// to run the damage model without them. Audited consequence by listener:
//   modes.js  — every handler is guarded by `M.stats`, which is null outside a
//               live level. No-op.
//   effects.js— spawns particles and adds camera shake. effects.render() is only
//               called by game.js in the play phases, so the particles are
//               invisible and decay on their own; the shake is applied to the
//               GAME camera (not this one, see 2) and effects.reset() zeroes
//               both the particles and that shake on every level start / retry.
//   hud.js    — queues a toast into #hud-toast, which is inside the hidden #hud.
//               Invisible, but a toast queued in the last 1.6 s before PLAY
//               could survive into the level, so screens.js clears that host
//               when the phase leaves the menus.
// Verified end to end: tests/ui-title.mjs runs a full campaign level after a
// title-screen breach and asserts the level is unaffected.

import { CONFIG } from '../config.js';
import { createTerrain } from '../core/terrain.js';
import { MATERIALS } from '../build/materials.js';

import * as waterSim from '../physics/water.js';
import * as coupling from '../physics/coupling.js';
import * as structures from '../physics/structures.js';
import * as constraints from '../physics/constraints.js';
import * as stress from '../physics/stress.js';

import * as renderer from '../rendering/renderer.js';
import * as waterRenderer from '../rendering/waterRenderer.js';

const T = () => CONFIG.render.title;

// ---- module state --------------------------------------------------------

let D = null;          // the diorama scene (renderer/waterRenderer read it as `S`)
let acc = 0;           // fixed-timestep accumulator, fed from dtReal
let dead = false;      // a throw in here disables the diorama for good
let cycles = 0;

// Our own camera. Shape-compatible with core/camera.js as far as the renderers
// care (x, y, zoom, shakeX, shakeY) — deliberately NOT the game's camera.
const cam = { x: 0, y: 8, zoom: 20, shakeX: 0, shakeY: 0 };

const stat = {
  t: 0, stage: 'idle', cycles: 0, particles: 0, members: 0, broken: 0,
  maxLoad: 0, peakBend: 0, ticks: 0, ms: 0, simMs: 0,
};

// Per-frame cost readout: the F2 overlay and tests/ui-title.mjs read this.
export function stats() { return stat; }

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- scene construction --------------------------------------------------

// A two-column timber crib on the sill: the upstream column is the face the
// water loads, the downstream column and the ties are what stops it toppling
// bodily instead of bending. The bottom face bay is the member the whole loop is
// about, so it is a plain unsupported span — the exact mistake the tutorial
// teaches players not to make.
function buildDesign(d) {
  const nodes = [];
  const members = [];
  const nid = (r, c) => 'tn' + r + '_' + c;
  const xs = [d.x0, d.x1];

  for (let r = 0; r <= d.rows; r++) {
    for (let c = 0; c < 2; c++) {
      nodes.push({
        id: nid(r, c), x: xs[c], y: d.y + r * d.rowH,
        // Feet only. instantiate() treats a non-null anchorId as anchored even
        // with no terrain anchor of that name, which is what we want: pinned
        // feet WITHOUT painting the level editor's yellow anchor dots on the
        // title screen.
        anchorId: r === 0 ? 'sill' : null,
      });
    }
  }

  let k = 0;
  const add = (a, b) => members.push({ id: 'tm' + (k++), a, b, mat: d.mat });
  for (let r = 0; r < d.rows; r++) {          // the two faces
    add(nid(r, 0), nid(r + 1, 0));
    add(nid(r, 1), nid(r + 1, 1));
  }
  for (let r = 1; r <= d.rows; r++) add(nid(r, 0), nid(r, 1));   // ties
  for (let r = 0; r < d.rows; r++) {                             // bracing
    if (r % 2 === 0) add(nid(r, 0), nid(r + 1, 1));
    else add(nid(r, 1), nid(r + 1, 0));
  }
  return { nodes, members };
}

// Fresh instances every cycle. Rebuilding rather than resetting is what keeps
// the loop identical: there is no EMA, no warm-started pressure field and no
// accumulated damage left over from the cycle before.
function makeScene() {
  const t = T();
  const terrain = createTerrain(t.terrain, []);
  const water = waterSim.createWater(terrain, CONFIG.water);
  waterSim.addWater(water, t.pond);
  waterSim.addSource(water, t.flood);

  const design = buildDesign(t.dam);
  const structure = structures.instantiate(design, terrain, MATERIALS);

  cycles++;
  return {
    // The shape renderer.render / waterRenderer.render expect of a scene.
    phase: 'title',            // never 'build': no grid, no ghost, no build zone
    terrain, water, structure,
    design: null,              // a structure exists, so the design is never drawn
    level: { id: t.levelId, props: t.props },
    camera: cam,
    simSpeed: 1,
    simTime: 0,
    stats: null,
    t: 0,
  };
}

// ---- simulation ----------------------------------------------------------

// ARCHITECTURE §3, verbatim, minus modes (no objectives here) and effects
// (game.js already steps the shared effects layer every frame).
function step(dt) {
  D.t += dt;
  D.simTime = D.t;
  coupling.updateObstructions(D.structure, D.water);
  waterSim.stepWater(D.water, dt);
  coupling.applyWaterForces(D.structure, D.water, dt);
  constraints.stepStructure(D.structure, D.terrain, dt);
  stress.updateStress(D.structure, dt, D.t);
}

// Purely for the readout / tests — the loop itself is driven by physics, not by
// these labels.
function stageOf() {
  const t = T();
  const src = t.flood;
  if (D.t < src.delay) return 'settle';
  if (D.structure.brokenCount > 0) return D.t > t.loop - 3 ? 'calm' : 'breach';
  if (D.t < src.delay + src.duration) return 'fill';
  return 'strain';
}

// ---- which menu is up ----------------------------------------------------

// The level grid is reachable two ways, and the game PHASE only tells us about
// one of them: pressing PLAY on the title swaps the DOM screen without leaving
// the 'title' phase (screens.js), while ☰ / Esc from inside a level really does
// set phase 'levelselect'. Framing the diorama off the phase alone therefore
// gave the level grid two different backdrops depending on how you got there.
// The DOM is the honest source: ask which screen is actually visible. One
// cached element and a classList read per frame.
let levelsEl = null;

function showingLevels(phase) {
  if (phase === 'levelselect') return true;
  if (typeof document === 'undefined' || !document.getElementById) return false;
  if (!levelsEl) levelsEl = document.getElementById('screen-levels');
  return !!(levelsEl && levelsEl.classList && !levelsEl.classList.contains('hidden'));
}

// ---- camera --------------------------------------------------------------

// Fixed framing, derived from the canvas so it is right on a 21:9 desktop and on
// a portrait phone. Fit the world WIDTH when the aspect allows it, and zoom IN
// on a tall canvas rather than showing 45 m of empty sky — but only up to
// zoomInMax, because a phone that zoomed all the way to viewH would frame three
// metres of dam and nothing else. Then place the sill at a chosen fraction of
// the screen height, which is what actually controls the composition: menu text
// over sky, water below it.
function frameCamera(canvas, levels) {
  const t = T();
  const W = canvas.width || 1;
  const H = canvas.height || 1;
  const tall = H > W;

  const zw = W / t.viewW;
  const zh = H / t.viewH;
  const base = Math.max(zw, Math.min(zh, zw * t.zoomInMax));
  // One full period per loop: the sway and the breath are back at zero exactly
  // when the cycle restarts, so the cut never also jumps the camera.
  const ph = (D.t / t.loop) * Math.PI * 2;
  const breath = 1 + t.breathe * (1 - Math.cos(ph)) * 0.5;
  cam.zoom = base * breath * (levels ? t.levelsZoom : 1);

  const sillAt = levels
    ? (tall ? t.levelsSillAtTall : t.levelsSillAt)
    : (tall ? t.sillAtTall : t.sillAt);

  cam.x = t.focusX - (W / cam.zoom) * t.focusBias + Math.sin(ph) * t.sway;
  cam.y = t.dam.y + (H * (sillAt - 0.5)) / cam.zoom;
  cam.shakeX = 0;
  cam.shakeY = 0;
}

// ---- overlays ------------------------------------------------------------

// One band of cool light along the horizon. This is the diorama's whole
// backdrop budget, and it earns it: the scene is lit like dusk, so without a
// light value somewhere in the sky the top half of the frame is a flat black
// field and the water — dim blue on dark rock — has nothing to be brighter
// than. Drawn over everything including the dam, which is correct: it is air.
let hazeGrad = null;
let hazeKey = '';

function drawHaze(ctx) {
  const t = T();
  if (!(t.hazeAlpha > 0)) return;
  const yTop = SYo(t.dam.y + t.hazeTop);
  const yBot = SYo(t.dam.y - t.hazeBottom);
  if (!(yBot > yTop)) return;
  const key = Math.round(yTop) + ':' + Math.round(yBot) + ':' + t.hazeColor;
  if (key !== hazeKey || !hazeGrad) {
    const g = ctx.createLinearGradient(0, yTop, 0, yBot);
    if (!g || typeof g.addColorStop !== 'function') return;
    const c = t.hazeColor;
    g.addColorStop(0, hexA(c, 0));
    g.addColorStop(0.62, hexA(c, 1));
    g.addColorStop(1, hexA(c, 0));
    hazeGrad = g;
    hazeKey = key;
  }
  ctx.save();
  ctx.globalAlpha = t.hazeAlpha;
  ctx.fillStyle = hazeGrad;
  ctx.fillRect(0, yTop, ctx.canvas.width, yBot - yTop);
  ctx.restore();
}

// world y -> device px, with the diorama camera. (The renderers keep their own
// inlined copies of this; ours only has to agree with them.)
let vh = 0;
const SYo = (y) => vh * 0.5 - (y - cam.y) * cam.zoom;

function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// The only two things drawn by hand: the cut at the loop seam, and the extra
// dimming that pushes the diorama behind the level-select cards. Both are one
// fillRect; anything more elaborate belongs in CSS, where the menu scrim lives.
function drawScrim(ctx, levels) {
  const t = T();
  let a = levels ? t.levelsDim : 0;

  const fin = t.fadeIn > 0 ? clamp01(D.t / t.fadeIn) : 1;
  const left = t.loop - D.t;
  const fout = t.fadeOut > 0 ? clamp01(left / t.fadeOut) : 1;
  const cut = Math.min(fin, fout);
  a = a + (1 - a) * (1 - cut);
  if (!(a > 0.002)) return;

  ctx.save();
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.fillStyle = t.dimColor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

// ---- contract ------------------------------------------------------------

export function render(ctx, dtReal, phase) {
  if (dead || !ctx || !ctx.canvas) return;
  const t = T();
  if (!t || t.enabled === false) return;

  const t0 = nowMs();
  try {
    if (!D) { D = makeScene(); acc = 0; }

    // ---- fixed timestep, clamped hard ----
    const dt = CONFIG.physics.dt;
    let a = acc + (dtReal > 0 ? dtReal * t.timeScale : 0);
    if (a > t.maxCatchUp) a = t.maxCatchUp;
    const s0 = nowMs();
    let n = 0;
    while (a >= dt && n < t.maxTicks) { a -= dt; step(dt); n++; }
    acc = a;
    stat.simMs = nowMs() - s0;
    stat.ticks = n;

    // ---- the cut ----
    if (D.t >= t.loop) { D = makeScene(); acc = 0; }

    // ---- draw ----
    const levels = showingLevels(phase);
    frameCamera(ctx.canvas, levels);
    vh = ctx.canvas.height;
    renderer.render(ctx, cam, D);
    drawHaze(ctx);
    waterRenderer.render(ctx, cam, D.water, D);
    drawScrim(ctx, levels);

    stat.t = D.t;
    stat.stage = stageOf();
    stat.cycles = cycles;
    stat.particles = D.water.pcount | 0;
    stat.members = D.structure.members.length;
    stat.broken = D.structure.brokenCount;
    stat.maxLoad = D.structure.maxLoad;
    let pb = 0;
    for (const m of D.structure.members) if (m.bendLoad > pb) pb = m.bendLoad;
    stat.peakBend = pb;
    stat.ms = nowMs() - t0;
  } catch (err) {
    // One warning, then never again: a broken backdrop must not cost the player
    // the game, and it must not spam the console either.
    dead = true;
    D = null;
    stat.stage = 'disabled';
    if (typeof console !== 'undefined') console.warn('title diorama disabled:', err);
  }
}

// Test hook (tests/ui-title.mjs). Not part of the render contract: it exists so
// the loop's timeline can be measured headlessly instead of by eyeballing
// screenshots, which is how the dam was tuned to fail when it does.
export function _diorama() { return D; }
export function _reset() { D = null; acc = 0; dead = false; }
export function _step(dt) { if (D) step(dt); }
export function _make() { D = makeScene(); acc = 0; dead = false; return D; }
