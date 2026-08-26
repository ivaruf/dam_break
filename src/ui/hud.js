// OPUS C owns. HUD DOM updates + ui:* event emission. Contract §9.
//
// update(S) runs EVERY frame, so every write is guarded by a cached previous
// value: touching .textContent or .className unconditionally at 60 Hz makes the
// browser re-layout the whole HUD and shows up as jank on a phone.
//
// The HUD's job, in priority order: what am I trying to do (objective), what is
// it costing me (budget), how long have I got (timer), what did I just do wrong
// (build hint), and — in sim — how close is the dam to failing (peak load).

import { emit, on } from '../core/events.js';
import { CONFIG } from '../config.js';
import { designCost, getBuilder, canUndo, canRedo, getHint } from '../build/builder.js';
import { MATERIALS } from '../build/materials.js';
import * as modes from '../build/modes.js';

const R = CONFIG.render;
const el = (id) => document.getElementById(id);

// cached element refs (resolved once in init)
const D = {};

// cached last-written values, so a frame that changes nothing writes nothing
const last = {
  phase: '', levelName: '', objective: '', budget: '', budgetTotal: '',
  budgetPct: -1, budgetLow: null, timer: '', urgent: null, hint: '', hintKind: '',
  matList: '', matActive: '', matAfford: '', tool: '', undo: null, redo: null,
  speed: -1, load: '', retained: '', objPct: -1, objBad: null, release: null,
  showTimer: null, fadeL: null, fadeR: null, zoneBtn: null,
};

let lastToast = 0;
let eventToastAt = 0;

// The scene last handed to update(). The frame-build-zone button needs the LIVE
// camera and terrain, and hud.js is downstream of game.js in the import graph —
// so it borrows the scene it is already given every frame rather than importing
// its way back up.
let scene = null;

export function init() {
  const ids = [
    'hud', 'hud-top', 'hud-level', 'hud-level-name', 'hud-objective',
    'objective-meter', 'objective-fill', 'hud-timer', 'timer-text',
    'hud-right', 'hud-budget', 'budget-left', 'budget-total', 'budget-meter',
    'budget-fill', 'hud-readouts', 'stat-load', 'stat-retained', 'hud-toast',
    'toolbar', 'material-strip', 'material-bar', 'tool-group',
    'btn-tool-build', 'btn-erase', 'btn-boxdelete', 'btn-undo', 'btn-redo',
    'btn-clear', 'sim-controls', 'btn-sim-retry', 'btn-sim-edit', 'btn-release',
    'btn-hud-menu', 'build-hint',
  ];
  for (const id of ids) D[id] = el(id);

  bind(D['btn-release'], () => emit('ui:release', {}));
  bind(D['btn-sim-retry'], () => emit('ui:retry', {}));
  bind(D['btn-sim-edit'], () => emit('ui:edit', {}));
  bind(D['btn-hud-menu'], () => emit('ui:menu', {}));
  // The three MODE buttons all speak the same event; builder.setTool() treats a
  // repeat of the active non-build tool as "turn it off", which is why the
  // explicit build button exists at all — it is the one unambiguous way back.
  bind(D['btn-tool-build'], () => emit('ui:tool', { id: 'build' }));
  bind(D['btn-erase'], () => emit('ui:tool', { id: 'erase' }));
  bind(D['btn-boxdelete'], () => emit('ui:tool', { id: 'boxdelete' }));
  bind(D['btn-undo'], () => emit('ui:undo', {}));
  bind(D['btn-redo'], () => emit('ui:redo', {}));
  bind(D['btn-clear'], () => emit('ui:clear', {}));
  makeZoneButton();

  for (const b of document.querySelectorAll('.speed-btn')) {
    b.addEventListener('click', () => emit('ui:speed', { v: parseFloat(b.dataset.speed) }));
  }

  // Scroll affordance for the material strip. Measured on the events that can
  // actually change the answer — never per frame: reading scrollWidth forces a
  // layout flush, which is exactly the kind of thing that shows up as jank on a
  // phone at 60 Hz.
  const strip = D['material-strip'];
  if (strip && typeof strip.addEventListener === 'function') {
    strip.addEventListener('scroll', stripFade, { passive: true });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', stripFade);
    window.addEventListener('orientationchange', stripFade);
  }

  on('level:win', () => toast('DAM HELD', 'win'));
  on('level:fail', () => toast('DAM FAILED', 'fail'));
  on('breach', () => eventToast('BREACH'));
  on('overtop', () => eventToast('OVERTOPPING'));
  on('sim:start', () => { last.speed = -1; });
}

function bind(node, fn) {
  if (node) node.addEventListener('click', fn);
}

// ---- frame the build zone ------------------------------------------------
//
// A phone that fits the whole valley on screen puts the 0.5 m build grid at
// three or four pixels — smaller than the error in a fingertip, which is the
// real reason touch building felt hopeless before you could get close. One
// press frames the zone: the whole legal area, at a zoom where a grid cell is
// bigger than the thumb aiming at it. Built here rather than in index.html
// because it is a BUILD-phase affordance whose visibility is a function of the
// level (no build zone, no button), and hud.js is where that lives.
function makeZoneButton() {
  const group = D['tool-group'];
  if (!group || typeof document.createElement !== 'function') return;
  const b = document.createElement('button');
  b.id = 'btn-framezone';
  b.className = 'tool-btn';
  b.type = 'button';
  b.title = 'Frame the build zone — zoom in so the grid is bigger than your finger';
  if (typeof b.setAttribute === 'function') b.setAttribute('aria-label', 'Frame the build zone');
  b.textContent = '⛶';
  b.addEventListener('click', frameZone);
  group.appendChild(b);
  D['btn-framezone'] = b;
}

// camera.fitZone(x0, y0, x1, y1) frames a world rect. The y range is the LOWEST
// ground under the zone up to zoneFrameHeadroom above it: the dam is built up
// from the valley floor, so the floor is the anchor of the shot and the
// headroom is where the crest will be.
function frameZone() {
  const S = scene;
  const cam = S && S.camera;
  const bz = S && S.level && S.level.buildZone;
  if (!cam || !bz || typeof cam.fitZone !== 'function') return;
  const t = S.terrain;
  let lo = Infinity;
  if (t && typeof t.heightAt === 'function') {
    const n = Math.max(2, R.zoneFrameSamples);
    for (let i = 0; i <= n; i++) lo = Math.min(lo, t.heightAt(bz.x0 + (bz.x1 - bz.x0) * (i / n)));
  }
  if (!Number.isFinite(lo)) lo = cam.y - R.zoneFrameHeadroom * 0.5;
  cam.fitZone(bz.x0, lo - R.zoneFrameBelow, bz.x1, lo + R.zoneFrameHeadroom);
}

// A clipped material strip has to LOOK clipped, or the player concludes there
// are only three materials. Fade the edge the content is hidden behind — and
// only that edge, so the fade doubles as a direction cue.
function stripFade() {
  const s = D['material-strip'];
  if (!s) return;
  const max = s.scrollWidth - s.clientWidth;       // NaN under the test stub
  const pos = s.scrollLeft || 0;
  const l = max > 2 && pos > 2;
  const r = max > 2 && pos < max - 2;
  if (last.fadeL !== l) { last.fadeL = l; s.classList.toggle('fade-l', l); }
  if (last.fadeR !== r) { last.fadeR = r; s.classList.toggle('fade-r', r); }
}

// ---- formatting ---------------------------------------------------------

// $12,000 — hand-rolled so it never depends on the user's locale separators.
function money(v) {
  const n = Math.max(0, Math.round(v));
  let s = String(n);
  let out = '';
  while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
  return '$' + s + out;
}

function clock(t) {
  const s = Math.max(0, t);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return mm + ':' + (ss < 10 ? '0' : '') + ss;
}

const pct = (v) => Math.round(v * 100) + '%';

// Head rating (materials.js `headRating`, damage v2.1): how deep a face of this
// stuff holds before bending/creep eat it. 3 → '3', 2.5 → '2.5' — a trailing
// '.0' on a rating this coarse claims precision the number does not have.
function headM(v) {
  const n = Math.round(v * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---- toasts ------------------------------------------------------------

function toast(text, kind) {
  const host = D['hud-toast'];
  if (!host) return;
  const now = Date.now();
  if (now - lastToast < 250) return;      // never stack duplicates on one frame
  lastToast = now;
  const node = document.createElement('div');
  node.className = 'toast ' + (kind || 'info');
  node.textContent = text;
  host.appendChild(node);
  // one timer PER node: a shared timer would let a second toast cancel the
  // first one's removal and leave it on screen for the rest of the run
  setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, R.toastMs);
}

// breach/overtop repeat constantly while water flows — one toast per few seconds
function eventToast(text) {
  const now = Date.now();
  if (now - eventToastAt < R.toastMs * 2) return;
  eventToastAt = now;
  toast(text, 'info');
}

// ---- per-frame update ---------------------------------------------------

export function update(S) {
  scene = S;
  const inGame = S.phase === 'build' || S.phase === 'sim';
  if (last.phase !== S.phase) {
    D['hud'].classList.toggle('hidden', !inGame);
    if (inGame) {
      const build = S.phase === 'build';
      D['toolbar'].classList.toggle('hidden', !build);
      D['sim-controls'].classList.toggle('hidden', build);
      D['hud-readouts'].classList.toggle('hidden', build);
      D['objective-meter'].classList.toggle('hidden', build);
      // The strip has no measurable width while the toolbar is display:none, so
      // the fade has to be re-derived the moment it becomes visible again.
      if (build) stripFade();
      // updateHint() only runs in the build phase, so without this the LAST
      // build hint ("the gap between the banks is too wide…") stayed on screen
      // through the whole sim, advising the player about a dam they have already
      // released. Harmless when the hint was a floating overlay; now that it is
      // a row in the bottom stack it also costs height for nothing.
      else if (D['build-hint']) {
        D['build-hint'].classList.add('hidden');
        last.hint = null; last.hintKind = null;
      }
    }
    last.phase = S.phase;
    last.hint = null;               // force a hint refresh on phase change (any
                                    // non-string differs from every real hint)
  }
  if (!inGame || !S.level) return;

  const build = S.phase === 'build';

  set('hud-level-name', S.level.name || '', 'levelName');
  set('hud-objective', modes.objectiveText(S.level), 'objective');

  // designCost() walks every member and builds a node index, so it is called
  // ONCE per frame and the result is threaded through — budgetLeft() and
  // affordableLength() would each re-walk the whole design.
  const total = S.level.budget || 0;
  const spent = designCost(S.design);
  const left = Math.max(0, total - spent);

  updateBudget(total, spent, left);
  updateTimer(S, build);
  updateRelease(S, build);

  if (build) {
    updateMaterials(S, left);
    updateTools(S);
    updateHint(S);
  } else {
    updateSim(S);
  }
}

function set(id, value, key) {
  const k = key || id;
  if (last[k] === value) return;
  last[k] = value;
  const node = D[id];
  if (node) node.textContent = value;
}

function updateBudget(total, spent, left) {
  set('budget-left', money(left), 'budget');
  set('budget-total', money(total), 'budgetTotal');

  const frac = total > 0 ? Math.min(1, spent / total) : 0;
  const p = Math.round(frac * 100);
  if (last.budgetPct !== p) {
    last.budgetPct = p;
    if (D['budget-fill']) D['budget-fill'].style.width = p + '%';
  }
  const low = total > 0 && left / total < 0.15;
  if (last.budgetLow !== low) {
    last.budgetLow = low;
    D['hud-budget'].classList.toggle('low', low);
  }
}

function updateTimer(S, build) {
  const show = build && S.level.mode === 'countdown';
  const node = D['hud-timer'];
  if (last.showTimer !== show) {
    last.showTimer = show;
    node.classList.toggle('hidden', !show);
  }
  if (!show) return;
  const t = Math.max(0, S.buildTimer || 0);
  set('timer-text', clock(t), 'timer');
  const urgent = t <= R.timerUrgent;
  if (last.urgent !== urgent) {
    last.urgent = urgent;
    node.classList.toggle('urgent', urgent);
  }
}

function updateRelease(S, build) {
  // Countdown levels release themselves when the wave arrives; only free-build
  // levels hand the player the trigger (contract §7).
  const show = build && S.level.mode === 'freebuild';
  if (last.release !== show) {
    last.release = show;
    D['btn-release'].classList.toggle('hidden', !show);
  }
}

// ---- build phase -------------------------------------------------------

function updateMaterials(S, left) {
  const mats = (S.level.materials && S.level.materials.length)
    ? S.level.materials : Object.keys(MATERIALS);
  const key = mats.join(',');
  const bar = D['material-bar'];

  if (last.matList !== key) {
    last.matList = key;
    last.matActive = ''; last.matAfford = '';
    bar.innerHTML = '';
    mats.forEach((id, i) => {
      const mat = MATERIALS[id];
      if (!mat) return;
      // Rating is display-only and OPTIONAL: it does not exist until
      // materials.js grows headRating, and a material may legitimately have
      // none (a cable seals nothing, so it holds no head at all). No rating,
      // no line — the button keeps exactly its old three rows.
      const head = mat.headRating;
      const rated = head > 0;

      const btn = document.createElement('button');
      btn.className = 'tool-btn mat-btn';
      btn.type = 'button';
      btn.dataset.mat = id;
      btn.title = mat.name + ' — ' + (mat.blurb || '')
        + (rated ? ' Holds roughly ' + headM(head) + ' m of water head.' : '')
        + ' (' + (i + 1) + ')';

      const sw = document.createElement('i');
      sw.className = 'mat-swatch';
      sw.style.background = mat.color;

      const name = document.createElement('span');
      name.className = 'mat-name';
      name.textContent = mat.name;

      const cost = document.createElement('span');
      cost.className = 'mat-cost';
      cost.textContent = '$' + mat.costPerMeter + '/m';

      const hot = document.createElement('span');
      hot.className = 'mat-key';
      hot.textContent = String(i + 1);

      // '~3 m head', not '~3 m': these buttons already talk in metres (maxLength
      // is a metre figure too), and a bare number reads as a length limit.
      //
      // All four children stay DIRECT children of the button. A short viewport
      // folds the cost and the rating onto one line, but it does that by
      // re-laying the button out as a 2×2 grid in CSS (styles.css) rather than
      // by wrapping them in a container here: this DOM shape is part of the
      // file's contract with tests/ui-feedback.mjs, and layout is CSS's job.
      if (rated) {
        const rating = document.createElement('span');
        rating.className = 'mat-head';
        rating.textContent = '~' + headM(head) + ' m head';
        btn.append(sw, name, cost, rating, hot);
      } else {
        btn.append(sw, name, cost, hot);
      }
      btn.addEventListener('click', () => emit('ui:material', { id }));
      bar.appendChild(btn);
    });
    stripFade();      // the strip's scrollable width just changed
  }

  const active = getBuilder().material;
  if (last.matActive !== active) {
    last.matActive = active;
    for (const btn of bar.children) btn.classList.toggle('active', btn.dataset.mat === active);
  }

  // grey out anything the remaining budget can no longer buy a usable length of
  // (same test as builder.affordableLength, but without re-costing the design)
  let afford = '';
  for (const id of mats) {
    const mat = MATERIALS[id];
    const metres = mat && mat.costPerMeter ? left / mat.costPerMeter : 0;
    afford += (mat && metres >= mat.minLength) ? '1' : '0';
  }
  if (last.matAfford !== afford) {
    last.matAfford = afford;
    let i = 0;
    for (const btn of bar.children) { btn.classList.toggle('unaffordable', afford[i] === '0'); i++; }
  }
}

// The three mode buttons are a radio group in everything but markup: exactly one
// is lit, always, so "which tool am I holding" is answerable at a glance. The
// player who did not know an eraser existed was looking at a cluster that had
// scrolled off the right edge of the screen AND, when it was on screen, only
// ever lit ONE of its buttons — there was no state to read.
//
// Keyed by builder.js's B.tool values, so an unknown tool lights nothing rather
// than lighting the wrong thing.
const TOOL_BTN = { build: 'btn-tool-build', erase: 'btn-erase', boxdelete: 'btn-boxdelete' };

function updateTools(S) {
  const B = getBuilder() || {};

  // no build zone in this level, nothing to frame: the button is not a no-op,
  // it is absent
  const zone = !!(S && S.level && S.level.buildZone);
  if (last.zoneBtn !== zone) {
    last.zoneBtn = zone;
    const node = D['btn-framezone'];
    if (node) node.classList.toggle('hidden', !zone);
  }

  const tool = B.tool || 'build';
  if (last.tool !== tool) {
    last.tool = tool;
    for (const id in TOOL_BTN) {
      const node = D[TOOL_BTN[id]];
      if (node) node.classList.toggle('active', tool === id);
    }
  }
  const u = canUndo();
  if (last.undo !== u) { last.undo = u; D['btn-undo'].disabled = !u; }
  const r = canRedo();
  if (last.redo !== r) { last.redo = r; D['btn-redo'].disabled = !r; }
}

// One line, one job: a refusal always wins over teaching, a live touch chain
// outranks the level's opening advice (it is about the gesture in the player's
// hand right now), and the teaching text steps forward as they build.
function updateHint(S) {
  let text = '';
  let kind = '';

  const reason = getHint();          // '' once the refusal has gone stale
  const chain = (getBuilder() || {}).chainHead;
  if (reason) {
    text = reason.toUpperCase();
    kind = 'warn';
  } else if (chain) {
    text = 'Tap to extend — tap the glowing joint to finish';
    kind = 'info';
  } else {
    const hints = S.level.hints || [];
    const built = S.design ? S.design.members.length : 0;
    if (hints.length && built === 0) { text = hints[0]; kind = 'info'; }
    else if (hints.length > 1 && built < 3) { text = hints[1]; kind = 'info'; }
  }

  if (last.hint === text && last.hintKind === kind) return;
  last.hint = text; last.hintKind = kind;
  const node = D['build-hint'];
  node.textContent = text;
  node.classList.toggle('hidden', !text);
  node.classList.toggle('warn', kind === 'warn');
  node.classList.toggle('info', kind === 'info');
}

// ---- sim phase ---------------------------------------------------------

function updateSim(S) {
  const st = S.structure;
  const load = st ? st.maxLoad || 0 : 0;
  set('stat-load', pct(load), 'load');
  const node = D['stat-load'];
  if (node) {
    const bad = load >= 1;
    const warn = !bad && load >= R.stressBarWarn;
    node.classList.toggle('bad', bad);
    node.classList.toggle('warn', warn);
  }

  const prog = modes.getProgress();
  set('stat-retained', prog ? pct(prog.retained) : '—', 'retained');

  if (prog) {
    const p = Math.round(prog.timeFrac * 100);
    if (last.objPct !== p) {
      last.objPct = p;
      if (D['objective-fill']) D['objective-fill'].style.width = p + '%';
    }
    const bad = !prog.ok;
    if (last.objBad !== bad) {
      last.objBad = bad;
      D['objective-meter'].classList.toggle('bad', bad);
    }
  }

  if (last.speed !== S.simSpeed) {
    last.speed = S.simSpeed;
    for (const b of document.querySelectorAll('.speed-btn')) {
      b.classList.toggle('active', parseFloat(b.dataset.speed) === S.simSpeed);
    }
  }
}
