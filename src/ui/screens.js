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

// Empty the HUD toast host. hud.js appends toast nodes with their own removal
// timers; this just makes sure none of them survive a phase change.
function clearToasts() {
  const host = el('hud-toast');
  if (!host) return;
  while (host.lastChild) host.removeChild(host.lastChild);
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

// ---- splash -------------------------------------------------------------

// The splash is inline markup + inline CSS in index.html so it paints on the
// first composited frame, before any module has loaded. Taking it down is the
// first thing that happens once the game is actually ready to draw, which is
// here: init() runs inside game.boot(), one frame before the title diorama's
// first render. Fade, then remove the node outright — a display:none overlay
// left in the tree is still a stacking context over the canvas.
function dismissSplash() {
  const n = el('splash');
  if (!n) return;
  n.classList.add('out');
  const drop = () => {
    n.style.display = 'none';
    if (n.parentNode) n.parentNode.removeChild(n);
  };
  // The stub DOM in tests/ has no setTimeout guarantees worth relying on, and a
  // player on a dead battery should not be left with a ghost overlay either:
  // remove it on the timer, and never mind if the transition was cut short.
  if (typeof setTimeout === 'function') setTimeout(drop, 320); else drop();
}

// ---- init ---------------------------------------------------------------

export function init() {
  dismissSplash();

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
      // The title diorama is the real physics engine, so it fires real 'breach'
      // and 'overtop' events, and hud.js answers those with a toast. The HUD is
      // hidden on the menus so nobody sees them — but a toast queued in the last
      // second before PLAY would still be alive when the HUD appears, and
      // "BREACH" over a level the player has not built yet is nonsense. Drop
      // anything left in the host on the way into a level.
      clearToasts();
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

// "Ten valleys. One rising river." reads better than "10 valleys." — but the
// count is derived from LEVELS now, so it has to survive someone adding a level.
const NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
  'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
function words(n) { return NUMBERS[n] !== undefined ? NUMBERS[n] : String(n); }

function badgeFor(lv) {
  if (lv.id === 'sandbox') return { cls: 'sandbox', text: 'SANDBOX' };
  if (lv.mode === 'countdown') return { cls: 'countdown', text: 'COUNTDOWN' };
  return { cls: 'freebuild', text: 'FREE BUILD' };
}

// Small helper so every element in a card is built the same way.
function span(cls, text) {
  const n = document.createElement('span');
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// A level card is a <div role="button">, not a <button>. The overflow bug that
// prompted this (subtitles painting outside the card, onto the next one) was
// actually caused by row sizing on #level-grid — see the long note in
// styles.css; the card was being clamped from outside, not failing to grow from
// inside. The div is here because the card is a five-part wrapping grid, which
// is a layout job, and <button> is the element you least want doing layout.
//
// Everything a <button> gave us for free is put back by hand: the role, a tab
// stop, Enter/Space activation, and aria-disabled for a locked level. Locked
// cards STAY focusable on purpose — the ARIA pattern for a disabled control that
// should still be discoverable — they just do not activate.
function levelCard(lv, index, locked, best) {
  const card = document.createElement('div');
  card.className = 'level-card' + (locked ? ' locked' : '') + (best ? ' done' : '');
  card.dataset.index = String(index);

  // Property assignment AND setAttribute: the reflected IDL properties are what
  // the headless test harness can read, setAttribute is what older engines
  // without ARIA reflection need. The guard is for the DOM stub in tests/.
  const attr = (k, v) => { if (typeof card.setAttribute === 'function') card.setAttribute(k, v); };
  card.role = 'button';
  attr('role', 'button');
  card.tabIndex = 0;
  attr('tabindex', '0');
  if (locked) {
    card.ariaDisabled = 'true';
    attr('aria-disabled', 'true');
  }

  const name = locked ? 'LOCKED' : (lv.name || 'Level ' + index);
  const b = badgeFor(lv);

  // Row 1 of the grid: the name, then the tag cluster. The tags live in ONE
  // flex item so the badge and the best cost wrap together instead of splitting.
  const head = span('level-head');
  head.appendChild(span('level-name', name));
  const tags = span('level-tags');
  tags.appendChild(span('badge ' + b.cls, b.text));
  if (best) tags.appendChild(span('level-best', 'BEST ' + money(best.cost)));
  // A real element, not the old absolutely-positioned ::after that sat on top
  // of the badge.
  if (locked) tags.appendChild(span('level-lock', '🔒'));
  head.appendChild(tags);

  // Row 2: the subtitle. Its own grid row, so it wraps INSIDE the card however
  // long it is and whatever else is on row 1.
  const sub = span('level-sub', locked
    ? 'Clear level ' + (index - 1) + ' to open this one.'
    : (lv.subtitle || ''));

  card.append(span('level-num', lv.id === 'sandbox' ? '∞' : String(index)), head, sub);

  // One label for assistive tech instead of five loose fragments.
  attr('aria-label', (lv.id === 'sandbox' ? 'Sandbox' : 'Level ' + index) + ': ' + name
    + (locked ? ' — locked' : '') + (best ? ' — best ' + money(best.cost) : ''));

  if (!locked) {
    const go = () => emit('ui:level', { index });
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => {
      const k = e && e.key;
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
      // Space scrolls the grid if we let it through, and Enter would re-fire on
      // key repeat.
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (e.repeat) return;
      go();
    });
  }
  return card;
}

function buildLevelGrid() {
  const grid = el('level-grid');
  grid.innerHTML = '';

  // The sandbox is not a campaign level, so it counts towards NEITHER side of
  // the progress line. Counting its best against a total of LEVELS.length - 1
  // is what printed "11 of 10 dams standing".
  const total = Math.max(0, LEVELS.length - 1);
  let cleared = 0;

  LEVELS.forEach((lv, i) => {
    const index = i + 1;
    const locked = !isUnlocked(index);
    const best = bestFor(lv.id);
    if (best && lv.id !== 'sandbox') cleared++;
    grid.appendChild(levelCard(lv, index, locked, best));
  });

  const prog = el('levels-progress');
  if (prog) {
    // Belt as well as braces: a save file from an older build (or a renamed
    // level) must still never be able to print more cleared than there are.
    const done = Math.min(cleared, total);
    prog.textContent = done > 0
      ? done + ' of ' + total + ' dams standing'
      : words(total) + ' valleys. One rising river.';
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
