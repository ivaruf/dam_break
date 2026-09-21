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
import * as sound from './sound.js';

const el = (id) => document.getElementById(id);

// What show() last raised, INCLUDING `null`, which is what a run looks like:
// during build and sim no .screen is up at all and the HUD has the canvas to
// itself. The sound panel is a door off wherever the player was standing —
// title, level select, result, or a level in progress, since the corner speaker
// is on every one of them now — so BACK has to know which, and the phase cannot
// answer it: #btn-play raises the level select without ever leaving the 'title'
// phase.
let current = 'screen-title';
let soundReturn = null;

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  if (id) { const n = el(id); if (n) n.classList.remove('hidden'); }
  current = id || null;
  // Anything that raises another screen — a phase change, a level starting —
  // has closed the sound panel by hiding it, so the way back out of it must not
  // survive as a stale promise to return somewhere the player has left.
  if (current !== 'screen-sound') soundReturn = null;
}

// ---- tutorial copy (level 1 only) ---------------------------------------

const TUTORIAL = [
  {
    title: 'Tap an anchor, then tap in the circle',
    text: 'Every beam starts on a yellow anchor or a joint you have already built. ' +
      'Tap one and a circle appears: everywhere lit inside it is somewhere this beam ' +
      'can reach. Tap anywhere lit and the beam is built. Two taps, every time — to ' +
      'keep going, tap the joint you just made. (A drag does the same in one go.) ' +
      'Dark means the ground or the zone is in the way; amber means you cannot afford ' +
      'that far. The \u2922-style button zooms to the build site.',
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

// ---- leaving the game ---------------------------------------------------

/**
 * The quit buttons on the title and level screens.
 *
 * They stay hidden unless the arcade's exit.js is actually there to answer,
 * because it is another repository's file and is allowed to be missing — and
 * a quit button that cannot quit is worse than no quit button at all. They stay
 * hidden in a plain tab too, for the reason spelled out below. What they SAY is
 * exit.js's answer as well: inside the arcade this goes back to the floor, and
 * installed it closes the window.
 */
function wireQuit() {
  const exit = globalThis.ArcadeExit;
  if (!exit) return;

  /* Whether to draw the button at all, which is NOT the same question as
   * whether quit() could do something. In a plain tab it could — the arcade is
   * a URL and a navigation always works — but somebody who typed this game's
   * address, or followed a link to it, did not come from the arcade and may
   * never have heard of it. So: a launcher behind us, or an installed window
   * that can genuinely close itself.
   *
   * ASKED THROUGH framed()/standalone() AND NOT THROUGH offers(), even though
   * offers() exists and says exactly this. exit.js is another repository's file
   * and the copy that answers may be OLDER than this code: it is fetched from
   * ../arcade/ and a service worker on this origin can hand back a version
   * cached long before offers() was written. A guard built on the new name
   * fails CLOSED when that happens — the way out simply disappears, inside the
   * arcade, where it is the one control that matters. These two predicates have
   * been in exit.js since the file existed. */
  if (!(exit.framed() || exit.standalone())) return;

  // The tab wording is unreachable behind the guard above and is handed over
  // anyway: verb() answers the same three cases in the same order as quit(),
  // and a label it cannot fill is an "undefined" printed on a button.
  const label = exit.verb({
    arcade: '◂ BACK TO ARCADE',
    app: '✕ CLOSE',
    tab: '✕ CLOSE',
  });

  for (const id of ['btn-quit', 'btn-quit-levels']) {
    const button = el(id);
    if (!button) continue; // the stub DOM in tests/ carries only what it needs
    button.textContent = label;
    button.classList.remove('hidden');
    button.addEventListener('click', () => {
      exit.quit().then((how) => {
        // Refused: the browser will not close a window it did not open. Say so
        // where the button is rather than leaving a dead control on screen.
        if (how !== 'refused') return;
        button.textContent = 'CLOSE THIS TAB YOURSELF';
        button.disabled = true;
      });
    });
  }
}

// ---- the sound panel ----------------------------------------------------
//
// There is no paintCorner() any more, and deliberately none: #corner-tools is
// fixed page chrome that nothing here shows or hides. It used to be taken away
// for build and sim — index.html and styles.css both carry the reasoning for
// why it is not, and why ☰ LEVELS moved one row down instead.

/**
 * One fader. src/ui/sound.js owns the value and the storage; this owns nothing
 * but the widget.
 *
 * Stored 0..1, displayed 0..100 — a slider the player drags wants whole
 * numbers and a gain wants a fraction, and doing the conversion once here is
 * better than doing it at every future call site.
 */
function wireFader(inputId, outId, read, write) {
  const input = el(inputId);
  if (!input) return;                    // the stub DOM in tests/ is sparse
  const out = el(outId);

  const paint = (pct) => { if (out) out.textContent = String(pct); };

  const start = Math.round(read() * 100);
  input.value = String(start);
  paint(start);

  // 'input', not 'change': the number beside the fader has to track the thumb
  // while it is still moving. It is also the hook the day this game gets audio
  // — hearing the level you are setting is the whole point of a volume
  // control, and sound.js's onVolume() is where that listens.
  input.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Math.round(Number(input.value) || 0)));
    paint(v);
    write(v / 100);
  });
}

/**
 * Open the sound panel from wherever the player pressed the corner speaker.
 *
 * The speaker is on every screen now, so "back to the title" is only the right
 * answer when the title is where they were: the screen showing at the moment
 * the door opened is remembered instead, and `null` — a level in progress, with
 * no .screen up at all — is a perfectly good thing to remember and return to.
 *
 * AND MID-RUN IT STOPS THE WATER. A menu that leaves the flood rising behind it
 * is a menu that costs the player the level for looking at it: the valley does
 * not pause itself the way a screen change pauses maxgear's, so opening this
 * from 'sim' asks for speed 0 through the same ui:speed channel the ⏸ button
 * uses, and leaves it there. Coming back lands on a stopped sim with ⏸ lit,
 * never on a run that has been going without anybody watching — the player
 * restarts it themselves with 1× or the spacebar. Build has nothing to stop.
 */
function openSound() {
  if (current === 'screen-sound') return;
  soundReturn = current;
  if (getScene().phase === 'sim') emit('ui:speed', { v: 0 });
  show('screen-sound');
}

/** The one way out of the panel, so BACK and Escape cannot leave by different
 *  doors. Returns whether there was anything to close — game.js asks. */
export function closeSound() {
  if (current !== 'screen-sound') return false;
  show(soundReturn);   // null means the run it was opened over
  return true;
}

function wireSound() {
  wireFader('vol-music', 'vol-music-out', sound.music, sound.setMusic);
  wireFader('vol-sfx', 'vol-sfx-out', sound.sfx, sound.setSfx);

  const open = el('btn-sound');
  if (open) open.addEventListener('click', openSound);
  const back = el('btn-sound-back');
  if (back) back.addEventListener('click', closeSound);
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

  wireQuit();
  wireSound();

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
  'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
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
  if (c.indexOf('NOTHING WAS BUILT') >= 0) return 'Tap an anchor, then tap inside the circle to place your first beam.';
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
