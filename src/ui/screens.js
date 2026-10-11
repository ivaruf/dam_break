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
import { t, getLang, setLang, paintStatic, levelName, levelSub } from '../i18n.js';

const el = (id) => document.getElementById(id);

// What show() last raised, INCLUDING `null`, which is what a run looks like:
// during build and sim no .screen is up at all and the HUD has the canvas to
// itself. The menu's Settings face is a door off wherever the player was
// standing — title, level select or result, since the corner's three bars are
// on every one of them — so BACK has to know which, and the phase cannot answer
// it: #btn-play raises the level select without ever leaving the 'title' phase.
let current = 'screen-title';
let menuReturn = null;   // the screen the Settings face was opened over
let menuInPlay = false;  // which face #screen-pause is wearing; see openMenu()
let pauseSpeed = null;   // the run's speed when the in-play menu opened

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  if (id) { const n = el(id); if (n) n.classList.remove('hidden'); }
  current = id || null;
  // Whether a panel is standing over a level in progress — the in-play
  // menu. Written HERE, the one place screens change,
  // and read by game.js and builder.js before they act on a key: a keystroke
  // meant for the menu (or a Space while it is up) must not also release the
  // flood, unpause it, or edit the dam hidden underneath.
  const scene = getScene();
  if (scene) scene.covered = !!current && (scene.phase === 'build' || scene.phase === 'sim');
  // Anything that raises another screen — a phase change, a level starting —
  // has closed the menu by hiding it, so neither the speed it was holding nor
  // the way back out of it may survive as a stale promise.
  if (current !== 'screen-pause') { pauseSpeed = null; menuReturn = null; }
}

// ---- tutorial copy (level 1 only) ---------------------------------------

// The words are src/i18n.js's tut.<n>.title / tut.<n>.text; this is only how
// many steps there are.
const TUTORIAL_STEPS = 3;

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
  if (tutStep >= TUTORIAL_STEPS) { markTutSeen(); hideTutorial(); return; }
  el('tut-step').textContent = t('tut.step', tutStep + 1, TUTORIAL_STEPS);
  el('tut-title').textContent = t('tut.' + tutStep + '.title');
  el('tut-text').textContent = t('tut.' + tutStep + '.text');
  el('btn-tut-next').textContent = t(tutStep === TUTORIAL_STEPS - 1 ? 'tut.last' : 'tut.next');

  const dots = el('tut-dots');
  if (dots.childElementCount !== TUTORIAL_STEPS) {
    dots.innerHTML = '';
    for (let i = 0; i < TUTORIAL_STEPS; i++) dots.appendChild(document.createElement('span'));
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
 * The quit buttons: one on the title screen and one in the pause menu, each at
 * the top level and last in its column (hub §2, "One button"). Never on the
 * level list or any other second panel.
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

  for (const id of ['btn-quit', 'btn-quit-pause']) {
    const button = el(id);
    if (!button) continue; // the stub DOM in tests/ carries only what it needs
    quitButtons.push(button);
    button.classList.remove('hidden');
    button.addEventListener('click', () => {
      exit.quit().then((how) => {
        // Refused: the browser will not close a window it did not open. Say so
        // where the button is rather than leaving a dead control on screen.
        if (how !== 'refused') return;
        button.dataset.refused = '1';
        button.disabled = true;
        paintQuit();
      });
    });
  }
  paintQuit();
}

const quitButtons = [];

/* The words on the way out, in the current language — run again on every
 * switch. The tab wording is unreachable behind the guard in wireQuit() and is
 * handed over anyway: verb() answers the same three cases in the same order as
 * quit(), and a label it cannot fill is an "undefined" printed on a button. */
function paintQuit() {
  const exit = globalThis.ArcadeExit;
  if (!exit || !quitButtons.length) return;
  const label = exit.verb({
    arcade: t('exit.arcade'),
    app: t('exit.close'),
    tab: t('exit.close'),
  });
  // Only the words are repainted: the back-arrow SVG beside them is markup
  // and must survive every switch of language.
  for (const b of quitButtons) {
    const words = b.querySelector ? b.querySelector('.quit-label') : null;
    (words || b).textContent = b.dataset.refused ? t('exit.refused') : label;
  }
}

/** Escape on the title screen is the way out — the same quit(), and only when
 *  the button is actually showing, so the key can never do what the screen
 *  does not offer. */
function quitFromTitle() {
  const b = el('btn-quit');
  if (!b || b.classList.contains('hidden') || b.disabled) return;
  b.click();
}

// ---- the language row -----------------------------------------------------
//
// One copy, plain markup in index.html, in the menu panel the corner's three
// bars open — on the title too, through the panel's Settings face. It stood on
// the title screen itself for a day (2026-10-11) until the hub settled that
// language and sound live in that panel and nowhere else. Every [data-lang]
// button in the page is wired here; aria-pressed is the only state and CSS
// reads it.
function paintLangButtons() {
  const lang = getLang();
  for (const b of document.querySelectorAll('[data-lang]')) {
    if (typeof b.setAttribute === 'function') b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
}

function wireLang() {
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => setLang(b.dataset.lang));
  }
  paintLangButtons();

  // A switch repaints in place: no screen changes, no run is touched, the menu
  // (which paused the flood when it opened mid-run) stays open and paused.
  // i18n.js has already repainted every [data-i18n]; what is built here at
  // runtime is rebuilt here.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('arcade:lang', () => {
      paintLangButtons();
      paintQuit();
      paintMenuFace();
      paintMute();
      const tut = el('tutorial');
      if (tut && !tut.classList.contains('hidden')) renderTutorial();
      buildLevelGrid();
      if (getScene().phase === 'result') paintResult();
    });
  }
}

// ---- the faders and the mute ---------------------------------------------
//
// There is no paintCorner(), and deliberately none: #corner-tools is fixed page
// chrome that nothing here shows or hides. The speaker inside it is a live mute
// (hub §2, "three kinds of thing"), and the two faders live in the menu panel.

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
  // while it is still moving, and so does the gain — src/ui/audio.js hears
  // every write through sound.js's onVolume() and auditions the bus that moved.
  // This file knows about sliders and never learns about gain nodes.
  //
  // And it LIFTS THE MUTE (hub §2, "Dragging a slider must make a sound, and
  // must lift the mute"): a level you are setting must not be silently
  // cancelled by a speaker plate somewhere else.
  input.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Math.round(Number(input.value) || 0)));
    paint(v);
    write(v / 100);
    if (sound.muted()) { sound.setMuted(false); paintMute(); }
  });
}

/* The speaker plate's state and words, from sound.js's one flag. aria-pressed
 * is what CSS reads to swap the waves for the slash, written in the same
 * breath as the label, so the picture and what a reader hears cannot drift. */
function paintMute() {
  const b = el('btn-sound');
  if (!b || typeof b.setAttribute !== 'function') return;
  const m = sound.muted();
  const label = t(m ? 'corner.unmute' : 'corner.mute');
  b.setAttribute('aria-pressed', String(m));
  b.setAttribute('aria-label', label);
  b.title = label;
}

function wireSound() {
  wireFader('vol-music', 'vol-music-out', sound.music, sound.setMusic);
  wireFader('vol-sfx', 'vol-sfx-out', sound.sfx, sound.setSfx);

  // One tap, live: nothing opens, no run pauses, focus stays where it was.
  const mute = el('btn-sound');
  if (mute) mute.addEventListener('click', () => { sound.setMuted(!sound.muted()); paintMute(); });
  paintMute();
}

// ---- the menu ---------------------------------------------------------------
//
// ONE panel, #screen-pause, and the corner's three bars are its only door
// (Escape aside). In a level it is the in-play menu: it stops the run — speed 0
// through the same ui:speed channel the ⏸ button uses, which also freezes a
// countdown build, because build ticks on the same speed — and remembers the
// speed it found, so closing it puts the run back exactly as it was: a 2× flood
// resumes at 2×, an already-paused one stays paused. Anywhere else it is the
// Settings face of the same panel: no RESUME and no LEVELS, a BACK to the
// screen it was opened over, and nothing to pause.

function inLevel() {
  const scene = getScene();
  return !!scene && (scene.phase === 'build' || scene.phase === 'sim');
}

/* Which face the panel is wearing: the heading, and which of RESUME + LEVELS
 * or BACK is showing. Re-run on a language switch, because the heading's
 * [data-i18n] key is rewritten here rather than by paintStatic. */
function paintMenuFace() {
  const head = el('pause-heading');
  if (head) {
    const key = menuInPlay ? 'pause.title' : 'menu.settings';
    if (head.dataset) head.dataset.i18n = key;
    head.textContent = t(key);
  }
  const toggle = (id, on) => { const n = el(id); if (n) n.classList.toggle('hidden', !on); };
  toggle('btn-pause-resume', menuInPlay);
  toggle('btn-pause-levels', menuInPlay);
  toggle('btn-menu-back', !menuInPlay);
}

/** What the three-bar plate does: the in-play menu over a level, the Settings
 *  face anywhere else, and — pressed again while the panel is up — the same as
 *  Escape, closing it. */
export function openMenu() {
  if (current === 'screen-pause') { closeMenu(); return; }
  if (!current && inLevel()) { openPause(); return; }
  menuInPlay = false;
  menuReturn = current;
  paintMenuFace();
  show('screen-pause');
  const back = el('btn-menu-back');
  if (back && typeof back.focus === 'function') back.focus();
}

export function openPause() {
  const scene = getScene();
  if (!inLevel()) return;
  if (current === 'screen-pause') return;
  pauseSpeed = scene.simSpeed;
  menuInPlay = true;
  paintMenuFace();
  emit('ui:speed', { v: 0 });
  emit('ui:pause', {});   // builder.js drops any drag in flight
  show('screen-pause');
  const resume = el('btn-pause-resume');
  if (resume && typeof resume.focus === 'function') resume.focus();
}

/** The one way out of the panel, either face, so RESUME, BACK, the plate and
 *  Escape cannot leave by different doors. Returns whether there was anything
 *  to close — escape() asks. */
export function closeMenu() {
  if (current !== 'screen-pause') return false;
  if (menuInPlay) {
    const speed = pauseSpeed;
    show(null);
    if (speed !== null) emit('ui:speed', { v: speed });
  } else {
    show(menuReturn || 'screen-title');
  }
  return true;
}

/**
 * Escape, the whole ladder, in one place (hub §2, "Escape goes one step back,
 * and from the start screen that step is the arcade"). game.js calls this and
 * nothing else on Escape; input.js has already swallowed the key's default.
 *
 *   menu (either face)    → close it: the run carries on, or BACK to where
 *                           the Settings face was opened from
 *   level list            → its BACK, to the title
 *   result card           → LEVELS, the card's own way back
 *   a level, nothing open → open the in-play menu (and pause)
 *   title, nothing open   → the way out, only if that button is showing
 *
 * So no single press ever throws a run away, and Escape, Escape from anywhere
 * lands on the title, which has the way out on it.
 */
export function escape() {
  if (closeMenu()) return;
  if (current === 'screen-levels') { show('screen-title'); return; }
  if (current === 'screen-result') { buildLevelGrid(); show('screen-levels'); return; }
  if (!current && inLevel()) { openPause(); return; }
  if (current === 'screen-title') quitFromTitle();
}

function wirePause() {
  const resume = el('btn-pause-resume');
  if (resume) resume.addEventListener('click', closeMenu);
  const back = el('btn-menu-back');
  if (back) back.addEventListener('click', closeMenu);
  // Leaving the level is a deliberate tap here, never a keystroke — the same
  // destination the menu plate used to jump straight to.
  const levels = el('btn-pause-levels');
  if (levels) levels.addEventListener('click', () => emit('ui:levels', {}));
}

// ---- init ---------------------------------------------------------------

export function init() {
  // Words before curtain: the static markup is painted in the stored language
  // while the splash still covers it, so nothing is ever seen in the wrong one.
  paintStatic(document);
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
  wirePause();
  wireSound();
  wireLang();

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

function badgeFor(lv) {
  if (lv.id === 'sandbox') return { cls: 'sandbox', text: t('badge.sandbox') };
  if (lv.mode === 'countdown') return { cls: 'countdown', text: t('badge.countdown') };
  return { cls: 'freebuild', text: t('badge.freebuild') };
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

  const name = locked ? t('levels.locked') : (levelName(lv) || t('levels.level', index));
  const b = badgeFor(lv);

  // Row 1 of the grid: the name, then the tag cluster. The tags live in ONE
  // flex item so the badge and the best cost wrap together instead of splitting.
  const head = span('level-head');
  head.appendChild(span('level-name', name));
  const tags = span('level-tags');
  tags.appendChild(span('badge ' + b.cls, b.text));
  if (best) tags.appendChild(span('level-best', t('levels.best', money(best.cost))));
  // A real element, not the old absolutely-positioned ::after that sat on top
  // of the badge.
  if (locked) tags.appendChild(span('level-lock', '🔒'));
  head.appendChild(tags);

  // Row 2: the subtitle. Its own grid row, so it wraps INSIDE the card however
  // long it is and whatever else is on row 1.
  const sub = span('level-sub', locked
    ? t('levels.unlockHint', index - 1)
    : levelSub(lv));

  card.append(span('level-num', lv.id === 'sandbox' ? '∞' : String(index)), head, sub);

  // One label for assistive tech instead of five loose fragments.
  attr('aria-label', (lv.id === 'sandbox' ? t('levels.sandbox') : t('levels.level', index)) + ': ' + name
    + (locked ? t('levels.ariaLocked') : '') + (best ? t('levels.ariaBest', money(best.cost)) : ''));

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
    // "Ten valleys. One rising river." reads better than "10 valleys." — the
    // count is derived from LEVELS, so i18n.js spells it from a table.
    prog.textContent = done > 0 ? t('levels.progress', done, total) : t('levels.intro', total);
  }
}

// ---- result -------------------------------------------------------------

// One actionable sentence under the cause line. modes.js names the advice that
// goes with each cause (causeMsg.coach); the words are in src/i18n.js.
function coaching(msg) {
  return msg && msg.coach ? t(msg.coach) : '';
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
  paintResult();
  show('screen-result');
}

// Everything on the result card, in the current language. Separate from
// showResult() so a language switch can repaint the card where it stands —
// including while the menu's Settings face is open over it — without raising anything.
function paintResult() {
  const S = getScene();
  const st = S.stats || {};
  const win = !!st.win;
  const level = S.level || {};
  const obj = level.objective || {};

  const head = el('result-heading');
  head.textContent = t(win ? 'result.held' : 'result.failed');
  head.classList.toggle('win', win);
  head.classList.toggle('fail', !win);

  const cause = el('result-cause');
  const causeText = st.causeMsg ? t(st.causeMsg.key, ...st.causeMsg.args) : (st.cause || '');
  cause.textContent = causeText;
  cause.classList.toggle('hidden', win || !causeText);

  const note = el('result-note');
  let noteText = '';
  if (win) {
    const best = bestFor(level.id);
    const next = S.levelIndex + 1;
    if (best && st.cost !== undefined && Math.round(best.cost) >= Math.round(st.cost)) {
      noteText = t('result.newBest', money(st.cost));
    }
    if (next <= LEVELS.length && isUnlocked(next) && LEVELS[next - 1]) {
      noteText += (noteText ? ' ' : '') + t('result.unlocked', levelName(LEVELS[next - 1]));
    }
  } else {
    noteText = coaching(st.causeMsg);
  }
  note.textContent = noteText;
  note.classList.toggle('hidden', !noteText);

  const host = el('result-stats');
  host.innerHTML = '';

  const need = obj.minRetention;
  const retained = st.retained !== undefined ? st.retained : 1;
  statRow(host, t('stat.retained'), Math.round(retained * 100) + '%',
    need !== undefined ? (retained >= need ? 'good' : 'bad') : '');
  if (need !== undefined) statRow(host, t('stat.needed'), Math.round(need * 100) + '%');
  statRow(host, t('stat.depth'), (st.peakDepth || 0).toFixed(1) + ' m');
  statRow(host, t('stat.stress'), Math.round((st.maxLoad || 0) * 100) + '%',
    (st.maxLoad || 0) >= 1 ? 'bad' : (st.maxLoad || 0) >= CONFIG.render.stressBarWarn ? 'warn' : 'good');
  statRow(host, t('stat.broken'), String(st.brokenCount || 0),
    (st.brokenCount || 0) > 0 ? 'warn' : 'good');
  statRow(host, t('stat.cost'), money(st.cost || 0));
  statRow(host, t('stat.time'), (st.survivalTime || 0).toFixed(1) + ' s'
    + (obj.duration ? ' / ' + obj.duration + ' s' : ''));

  const next = S.levelIndex + 1;
  const canNext = next <= LEVELS.length && isUnlocked(next);
  const nextBtn = el('btn-result-next');
  nextBtn.disabled = !canNext;
  nextBtn.textContent = canNext && LEVELS[next - 1]
    ? t('result.nextNamed', levelName(LEVELS[next - 1]).toUpperCase())
    : t('result.next');

  // a win makes RETRY the secondary action and NEXT the obvious one
  el('btn-result-retry').classList.toggle('big-btn', !win);
  el('btn-result-retry').classList.toggle('small-btn', win);
  nextBtn.classList.toggle('big-btn', win && canNext);
  nextBtn.classList.toggle('small-btn', !(win && canNext));
}
