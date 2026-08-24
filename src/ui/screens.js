// OPUS C owns. DOM screens: title, level select, result, first-level tutorial.
// Contract: ARCHITECTURE.md §9.
//
// Screens are plain DOM over the canvas. Only one .screen is visible at a time;
// #tutorial is deliberately NOT a .screen — it is a non-blocking card inside the
// HUD, so the player can keep building while it is up.

import { emit, on } from '../core/events.js';
import { CONFIG } from '../config.js';
import { LEVELS } from '../levels/levels.js';
import { isUnlocked, bestFor } from '../core/state.js';
import { getScene } from '../core/game.js';

const el = (id) => document.getElementById(id);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  if (id) { const n = el(id); if (n) n.classList.remove('hidden'); }
}

// ---- tutorial copy (level 1 only) ---------------------------------------

const TUTORIAL = [
  {
    title: 'Drag to build',
    text: 'Press on a yellow anchor and drag to another one. Let go to place a beam. ' +
      'Anchors are the only places a dam can grip the ground.',
  },
  {
    title: 'Triangles hold, squares fold',
    text: 'Pick a material below (or press 1–4). Every beam costs its length × its price ' +
      'per metre. Brace your wall with diagonals — a square frame just folds over.',
  },
  {
    title: 'Then release the water',
    text: 'Hit RELEASE WATER when you are ready. Watch the beams: cool blue means being ' +
      'pulled, warm orange means being crushed. Flashing with cracks means about to fail.',
  },
];

let tutStep = 0;

function tutSeen() {
  try { return localStorage.getItem(CONFIG.levels.tutorialKey) === '1'; }
  catch { return false; }
}

function markTutSeen() {
  try { localStorage.setItem(CONFIG.levels.tutorialKey, '1'); } catch { /* private mode */ }
}

function hideTutorial() {
  const n = el('tutorial');
  if (n) n.classList.add('hidden');
}

function renderTutorial() {
  const node = el('tutorial');
  if (!node) return;
  const s = TUTORIAL[tutStep];
  if (!s) { markTutSeen(); hideTutorial(); return; }
  el('tut-step').textContent = 'STEP ' + (tutStep + 1) + ' OF ' + TUTORIAL.length;
  el('tut-title').textContent = s.title;
  el('tut-text').textContent = s.text;
  el('btn-tut-next').textContent = tutStep === TUTORIAL.length - 1 ? 'BUILD IT →' : 'GOT IT →';

  const dots = el('tut-dots');
  if (dots.childElementCount !== TUTORIAL.length) {
    dots.innerHTML = '';
    for (let i = 0; i < TUTORIAL.length; i++) dots.appendChild(document.createElement('span'));
  }
  let i = 0;
  for (const d of dots.children) { d.classList.toggle('on', i === tutStep); i++; }
  node.classList.remove('hidden');
}

function maybeShowTutorial(S) {
  if (tutSeen()) { hideTutorial(); return; }
  if (S.levelIndex !== CONFIG.levels.tutorialLevel) { hideTutorial(); return; }
  tutStep = 0;
  renderTutorial();
}

// ---- init ---------------------------------------------------------------

export function init() {
  el('btn-play').addEventListener('click', () => { buildLevelGrid(); show('screen-levels'); });
  el('btn-sandbox').addEventListener('click', () => emit('ui:level', { index: LEVELS.length }));
  el('btn-levels-back').addEventListener('click', () => show('screen-title'));
  el('btn-result-retry').addEventListener('click', () => emit('ui:retry', {}));
  el('btn-result-edit').addEventListener('click', () => emit('ui:edit', {}));
  el('btn-result-menu').addEventListener('click', () => { buildLevelGrid(); show('screen-levels'); });
  el('btn-result-next').addEventListener('click', () => {
    const next = getScene().levelIndex + 1;
    if (next <= LEVELS.length && isUnlocked(next)) emit('ui:level', { index: next });
  });

  el('btn-tut-skip').addEventListener('click', () => { markTutSeen(); hideTutorial(); });
  el('btn-tut-next').addEventListener('click', () => { tutStep++; renderTutorial(); });

  on('phase:change', ({ phase }) => {
    if (phase === 'title') { hideTutorial(); show('screen-title'); }
    else if (phase === 'levelselect') { hideTutorial(); buildLevelGrid(); show('screen-levels'); }
    else if (phase === 'result') { hideTutorial(); showResult(); }
    else {
      show(null);
      if (phase === 'build') maybeShowTutorial(getScene());
      else hideTutorial();
    }
  });
}

// ---- level select -------------------------------------------------------

function money(v) {
  const n = Math.max(0, Math.round(v));
  let s = String(n);
  let out = '';
  while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
  return '$' + s + out;
}

function badgeFor(lv) {
  if (lv.id === 'sandbox') return { cls: 'sandbox', text: 'SANDBOX' };
  if (lv.mode === 'countdown') return { cls: 'countdown', text: 'COUNTDOWN' };
  return { cls: 'freebuild', text: 'FREE BUILD' };
}

function buildLevelGrid() {
  const grid = el('level-grid');
  grid.innerHTML = '';
  let cleared = 0;

  LEVELS.forEach((lv, i) => {
    const index = i + 1;
    const locked = !isUnlocked(index);
    const best = bestFor(lv.id);
    if (best) cleared++;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'level-card' + (locked ? ' locked' : '') + (best ? ' done' : '');
    card.dataset.index = String(index);
    card.disabled = locked;

    const num = document.createElement('span');
    num.className = 'level-num';
    num.textContent = lv.id === 'sandbox' ? '∞' : String(index);

    const name = document.createElement('span');
    name.className = 'level-name';
    name.textContent = locked ? 'LOCKED' : (lv.name || 'Level ' + index);

    const sub = document.createElement('span');
    sub.className = 'level-sub';
    sub.textContent = locked
      ? 'Clear level ' + (index - 1) + ' to open this one.'
      : (lv.subtitle || '');

    const b = badgeFor(lv);
    const badge = document.createElement('span');
    badge.className = 'badge ' + b.cls;
    badge.textContent = b.text;

    const bestEl = document.createElement('span');
    bestEl.className = 'level-best';
    // the lock glyph on a locked card comes from .level-card.locked::after
    bestEl.textContent = best ? 'BEST ' + money(best.cost) : '';

    // .level-sub has flex-basis:100%, so it must come LAST or it pushes the
    // badge and best-cost onto a third row
    card.append(num, name, badge, bestEl, sub);
    if (!locked) card.addEventListener('click', () => emit('ui:level', { index }));
    grid.appendChild(card);
  });

  const prog = el('levels-progress');
  if (prog) {
    const total = LEVELS.length - 1;                 // sandbox is not a campaign level
    prog.textContent = cleared > 0
      ? cleared + ' of ' + total + ' dams standing'
      : 'Ten valleys. One rising river.';
  }
}

// ---- result -------------------------------------------------------------

// Turn a failure cause into one actionable sentence. modes.js writes causes in
// upper case with a leading keyword, which is what we match on.
function coaching(cause) {
  const c = String(cause || '').toUpperCase();
  if (c.indexOf('OVERTOP') >= 0) return 'The reservoir rose over your crest. Build higher, or give the water a spillway.';
  if (c.indexOf('BREACH') >= 0) return 'Water found a gap. Sealing beams must touch each other — cables seal nothing.';
  // The two v2.1 processes come BEFORE the axial modes: a bending or creep break
  // is not a tension/compression story, and the advice is completely different.
  if (c.indexOf('SUSTAINED') >= 0) return 'It was holding right at the edge — sustained pressure eats weak material. Add margin, or build the wet face from something stronger.';
  if (c.indexOf('MIDSPAN') >= 0) return 'Long spans snap in the middle — stand a pier under the face or use steel.';
  if (c.indexOf('TENSION') >= 0) return 'Something was pulled apart. Steel and cable are strongest in tension.';
  if (c.indexOf('COMPRESSION') >= 0) return 'Something was crushed. Shorten the span or brace it — long beams buckle.';
  if (c.indexOf('COLLAPSE') >= 0) return 'One failure took the rest with it. Triangulate so no single beam is critical.';
  if (c.indexOf('SLID') >= 0) return 'The dam moved bodily. Tie it to anchors on both banks.';
  if (c.indexOf('NOTHING WAS BUILT') >= 0) return 'Drag between two anchors to place your first beam.';
  if (c.indexOf('RETAINED') >= 0) return 'Close. Seal the leaks and raise the crest a little.';
  if (c.indexOf('FLOODED DOWNSTREAM') >= 0) return 'The village took water. Route the overflow away from it.';
  return '';
}

function statRow(host, key, value, cls) {
  const k = document.createElement('div');
  k.className = 'stat-k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'stat-v' + (cls ? ' ' + cls : '');
  v.textContent = value;
  host.append(k, v);
}

function showResult() {
  const S = getScene();
  const st = S.stats || {};
  const win = !!st.win;
  const level = S.level || {};
  const obj = level.objective || {};

  const head = el('result-heading');
  head.textContent = win ? 'DAM HELD' : 'DAM FAILED';
  head.classList.toggle('win', win);
  head.classList.toggle('fail', !win);

  const cause = el('result-cause');
  cause.textContent = st.cause || '';
  cause.classList.toggle('hidden', win || !st.cause);

  const note = el('result-note');
  let noteText = '';
  if (win) {
    const best = bestFor(level.id);
    const next = S.levelIndex + 1;
    if (best && st.cost !== undefined && Math.round(best.cost) >= Math.round(st.cost)) {
      noteText = 'New best cost: ' + money(st.cost) + '.';
    }
    if (next <= LEVELS.length && isUnlocked(next) && LEVELS[next - 1]) {
      noteText += (noteText ? ' ' : '') + 'Unlocked: ' + LEVELS[next - 1].name + '.';
    }
  } else {
    noteText = coaching(st.cause);
  }
  note.textContent = noteText;
  note.classList.toggle('hidden', !noteText);

  const host = el('result-stats');
  host.innerHTML = '';

  const need = obj.minRetention;
  const retained = st.retained !== undefined ? st.retained : 1;
  statRow(host, 'Water retained', Math.round(retained * 100) + '%',
    need !== undefined ? (retained >= need ? 'good' : 'bad') : '');
  if (need !== undefined) statRow(host, 'Retention needed', Math.round(need * 100) + '%');
  statRow(host, 'Peak reservoir depth', (st.peakDepth || 0).toFixed(1) + ' m');
  statRow(host, 'Maximum stress', Math.round((st.maxLoad || 0) * 100) + '%',
    (st.maxLoad || 0) >= 1 ? 'bad' : (st.maxLoad || 0) >= CONFIG.render.stressBarWarn ? 'warn' : 'good');
  statRow(host, 'Members broken', String(st.brokenCount || 0),
    (st.brokenCount || 0) > 0 ? 'warn' : 'good');
  statRow(host, 'Construction cost', money(st.cost || 0));
  statRow(host, 'Survival time', (st.survivalTime || 0).toFixed(1) + ' s'
    + (obj.duration ? ' / ' + obj.duration + ' s' : ''));

  const next = S.levelIndex + 1;
  const canNext = next <= LEVELS.length && isUnlocked(next);
  const nextBtn = el('btn-result-next');
  nextBtn.disabled = !canNext;
  nextBtn.textContent = canNext && LEVELS[next - 1]
    ? 'NEXT: ' + LEVELS[next - 1].name.toUpperCase() + ' →'
    : 'NEXT LEVEL →';

  // a win makes RETRY the secondary action and NEXT the obvious one
  el('btn-result-retry').classList.toggle('big-btn', !win);
  el('btn-result-retry').classList.toggle('small-btn', win);
  nextBtn.classList.toggle('big-btn', win && canNext);
  nextBtn.classList.toggle('small-btn', !(win && canNext));

  show('screen-result');
}
