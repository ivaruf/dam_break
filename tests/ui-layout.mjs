// Layout + containment regression harness for the mobile UX overhaul.
// Run directly:  node tests/ui-layout.mjs
//
// WHY THIS EXISTS. The three bugs this suite guards were all invisible to the
// existing tests, because they are not about behaviour — they are about whether
// a box contains its own contents:
//
//   1. "11 of 10 dams standing" — the level-select counter added a sandbox best
//      to a total that excluded the sandbox.
//   2. Level-card subtitles painting OUTSIDE their card, onto the gap and the
//      card below (root cause: #level-grid's auto rows were shrunk to the
//      card's min-height because the grid is a scroll container with a definite
//      height, and align-items:stretch then clamped every card to that).
//   3. The in-game tool cluster (erase/box-delete/undo/redo/clear) scrolled
//      clean off the right edge of a phone, so players did not know the eraser
//      existed.
//
// Real geometry needs a real browser (tools/drive.mjs does that interactively).
// What a headless run CAN pin down is everything that is a rule rather than a
// pixel — the counter arithmetic, the DOM structure and ARIA of a card, the
// tool-button state machine, the marquee draw path — plus a static audit of the
// markup and stylesheet invariants those pixels depend on. That is this file.
//
// Reuses the DOM/Canvas stubs from ui-smoke.mjs.

import { readFileSync } from 'fs';
const src = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8');
await import('data:text/javascript,' + encodeURIComponent(src.split('// ---- run --')[0]));

const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const HERE = new URL('../', import.meta.url);

const fails = [];
const notes = [];
function ok(cond, label, detail) {
  (cond ? notes : fails).push((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  return !!cond;
}
function eq(got, want, label) {
  return ok(got === want, label, got === want ? String(want) : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const HTML = readFileSync(new URL('index.html', HERE), 'utf8');
const CSS = readFileSync(new URL('styles.css', HERE), 'utf8');

// ---- 1. the progress counter --------------------------------------------
//
// Seeded through localStorage BEFORE state.js is imported, because state.js
// reads the save file exactly once at module load.

const SAVE = 'dam-builder-save-v1';
const best = (cost) => ({ cost, retained: 1, broken: 0 });

// Every campaign level cleared AND the sandbox — the exact save file that used
// to print "11 of 10".
const seeded = { unlocked: 99, best: { sandbox: best(42) }, prefs: { showHints: true } };
for (let i = 1; i <= 10; i++) seeded.best['level-' + String(i).padStart(2, '0')] = best(1000 + i);
// the campaign levels past 10 carry named ids, not numbered ones
for (const id of ['patch-job', 'quarry', 'aftershock']) seeded.best[id] = best(2000);
localStorage.setItem(SAVE, JSON.stringify(seeded));

const { LEVELS } = await import(ROOT + '/src/levels/levels.js');
const { emit, on } = await import(ROOT + '/src/core/events.js');
const game = await import(ROOT + '/src/core/game.js');
const builder = await import(ROOT + '/src/build/builder.js');

const canvas = document.getElementById('game');
game.boot(canvas);

const CAMPAIGN = LEVELS.length - 1;
const sandboxes = LEVELS.filter((l) => l.id === 'sandbox').length;
eq(sandboxes, 1, 'exactly one level is the sandbox');

// phase:change → levelselect is what rebuilds the grid.
function openLevels() { emit('phase:change', { phase: 'levelselect' }); }

openLevels();
const progress = () => document.getElementById('levels-progress').textContent;
const grid = () => document.getElementById('level-grid');

eq(progress(), CAMPAIGN + ' of ' + CAMPAIGN + ' dams standing',
  'a fully cleared save + a sandbox best reads "' + CAMPAIGN + ' of ' + CAMPAIGN + '"');

// The invariant, stated as an invariant: parse the numbers back out and check
// the left one can never exceed the right one.
const m = /^(\d+) of (\d+)/.exec(progress());
ok(m && parseInt(m[1], 10) <= parseInt(m[2], 10),
  'cleared never exceeds total', m ? m[1] + ' <= ' + m[2] : 'unparsable: ' + progress());
eq(m && parseInt(m[2], 10), CAMPAIGN, 'the total excludes the sandbox');

eq(grid().children.length, LEVELS.length, 'every level including the sandbox gets a card');

// The two cases that actually PROVE the sandbox is excluded rather than merely
// clamped away. buildLevelGrid() also clamps cleared to total as a belt against
// a stale save file, and that clamp alone would hide the bug at a full save:
// 11 clamped to 10 still reads "10 of 10". These do not clamp.
const state0 = await import(ROOT + '/src/core/state.js');
const setSave = (bestMap) => {
  state0.save.unlocked = 99;
  state0.save.best = bestMap;
  openLevels();
};

// (a) ONLY the sandbox cleared. Buggy code: "1 of 10". Correct: no dams yet.
setSave({ sandbox: best(42) });
eq(progress(), 'Thirteen valleys. One rising river.',
  'a sandbox best alone counts as ZERO dams standing');

// (b) Nine campaign levels + the sandbox. Buggy code: "10 of 10" — a lie the
// clamp cannot catch, because 10 is a legal number here.
const nine = { sandbox: best(42) };
for (let i = 1; i <= 9; i++) nine['level-' + String(i).padStart(2, '0')] = best(1000 + i);
setSave(nine);
eq(progress(), '9 of ' + CAMPAIGN + ' dams standing',
  'nine campaign levels + a sandbox best reads "9 of ' + CAMPAIGN + '"');

// Restore the fully-cleared save for the card-structure checks below.
setSave(JSON.parse(JSON.stringify(seeded.best)));

// ---- 2. the level card: structure, ARIA, keyboard -----------------------

const cards = grid().children;
const card0 = cards[0];
const sandboxCard = cards[LEVELS.length - 1];

eq(card0.tagName, 'DIV', 'a level card is a DIV, not a BUTTON');
eq(card0.role, 'button', 'it carries role=button');
eq(card0.tabIndex, 0, 'it is a tab stop');
ok(!card0.ariaDisabled, 'an unlocked card is not aria-disabled');

// The card must be exactly three children — num, head, sub — with the subtitle
// as a REAL sibling in its own grid row. The old card appended five loose flex
// items and relied on level-sub having flex-basis:100% and coming last.
const clsOf = (n) => Array.from(n.children).map((c) => c.className);
const kids = clsOf(card0);
eq(kids.length, 3, 'a card has three grid children');
ok(kids[0] === 'level-num', 'child 1 is .level-num', kids[0]);
ok(kids[1] === 'level-head', 'child 2 is .level-head', kids[1]);
ok(kids[2] === 'level-sub', 'child 3 is .level-sub (its own grid row)', kids[2]);
ok(card0.children[2].textContent.length > 0, 'the subtitle actually has text');

const head = clsOf(card0.children[1]);
ok(head[0] === 'level-name', '.level-head opens with the name', head[0]);
ok(head.indexOf('level-tags') === 1, 'then a single .level-tags flex item', head.join('|'));
const tags = clsOf(card0.children[1].children[1]);
ok(tags.some((c) => c.indexOf('badge') === 0), '.level-tags holds the badge', tags.join('|'));
ok(tags.indexOf('level-best') >= 0, 'and the BEST cost — INSIDE the card', tags.join('|'));
ok(tags.indexOf('level-lock') < 0, 'an unlocked card has no padlock');

// Nothing inside the card may be interactive: a nested control inside a
// role=button is invalid and swallows the activation.
let nested = 0;
(function walk(n) { for (const c of n.children) { if (c.tagName === 'BUTTON' || c.tagName === 'A') nested++; walk(c); } })(card0);
eq(nested, 0, 'a card contains no nested button/link');

eq(sandboxCard.children[0].textContent, '∞', 'the sandbox card is numbered ∞');

// Locked card semantics. Re-seed with a fresh save so level 2+ are locked.
localStorage.setItem(SAVE, JSON.stringify({ unlocked: 1, best: {}, prefs: {} }));
const state = await import(ROOT + '/src/core/state.js');
state.save.unlocked = 1;
state.save.best = {};
openLevels();

eq(progress(), 'Thirteen valleys. One rising river.', 'a fresh save shows the tagline, not "0 of 10"');

const locked = grid().children[1];
ok(locked._cls.has('locked'), 'level 2 is marked .locked');
eq(locked.ariaDisabled, 'true', 'and aria-disabled=true');
eq(locked.tabIndex, 0, 'but stays focusable so it can be discovered');
ok(clsOf(locked.children[1].children[1]).indexOf('level-lock') >= 0,
  'the padlock is a real element in .level-tags, not an absolute ::after');

// Keyboard activation, both directions.
const fired = [];
const offLevel = on('ui:level', (p) => fired.push(p.index));
const key = (node, k) => {
  for (const fn of node._handlers.keydown || []) fn({ key: k, repeat: false, preventDefault() {} });
};
const unlockedCard = grid().children[0];
key(unlockedCard, 'Enter');
key(unlockedCard, ' ');
eq(fired.length, 2, 'Enter and Space both activate an unlocked card');
ok(fired.every((i) => i === 1), 'and both pass its own index', fired.join(','));

fired.length = 0;
key(locked, 'Enter');
ok(!(locked._handlers.keydown || []).length, 'a locked card has no keydown handler at all');
locked.click();
eq(fired.length, 0, 'and neither key nor click can start a locked level');

fired.length = 0;
key(unlockedCard, 'Tab');
eq(fired.length, 0, 'an unrelated key does nothing');

// Key repeat must not re-fire (holding Enter would queue a level load a frame).
for (const fn of unlockedCard._handlers.keydown || []) fn({ key: 'Enter', repeat: true, preventDefault() {} });
eq(fired.length, 0, 'a repeat keydown is ignored');
if (typeof offLevel === 'function') offLevel();

// ---- 3. the tool cluster state machine ----------------------------------

const el = (id) => document.getElementById(id);
const active = (id) => el(id)._cls.has('active');
const litTools = () => ['btn-tool-build', 'btn-erase', 'btn-boxdelete'].filter(active);

state.save.unlocked = 99;
game.loadLevel(2);
const frame = (() => { let t = 0; return (n = 2) => { for (let i = 0; i < n; i++) { t += 16.7; game.frame(t); } }; })();
frame(3);

eq(litTools().join(','), 'btn-tool-build', 'build is lit by default');

emit('ui:tool', { id: 'erase' }); frame();
eq(litTools().join(','), 'btn-erase', 'the eraser lights alone');
emit('ui:tool', { id: 'erase' }); frame();
eq(litTools().join(','), 'btn-tool-build', 're-pressing it toggles back to build');

emit('ui:tool', { id: 'boxdelete' }); frame();
eq(litTools().join(','), 'btn-boxdelete', 'box-delete lights alone');
eq(builder.getBuilder().tool, 'boxdelete', 'and the builder really is in that tool');
emit('ui:tool', { id: 'boxdelete' }); frame();
eq(litTools().join(','), 'btn-tool-build', 're-pressing box-delete toggles back');

emit('input:key', { key: 'x' }); frame();
eq(litTools().join(','), 'btn-boxdelete', 'the X hotkey lights the same button');
emit('input:key', { key: 'e' }); frame();
eq(litTools().join(','), 'btn-erase', 'E switches straight across to the eraser');
emit('input:key', { key: 'b' }); frame();
eq(litTools().join(','), 'btn-tool-build', 'B returns to build');

ok(litTools().length === 1, 'exactly one mode button is ever lit');

// Undo/redo disable state still tracks the stacks.
eq(el('btn-undo').disabled, true, 'undo starts disabled');
eq(el('btn-redo').disabled, true, 'redo starts disabled');

// The material button's four spans stay DIRECT children of the button: the
// short-viewport fold (cost beside the head rating instead of under it) is a
// grid-template-areas reflow in CSS, not a different DOM shape. That split of
// responsibility is what keeps this markup compatible with ui-feedback.mjs,
// which resolves .mat-head as an immediate child.
const matBtns = el('material-bar').children;
ok(matBtns.length > 0, 'the material bar is populated', matBtns.length + ' buttons');
const matKids = Array.from(matBtns[0].children).map((c) => c.className);
for (const cls of ['mat-swatch', 'mat-name', 'mat-cost']) {
  ok(matKids.indexOf(cls) >= 0, '.' + cls + ' is a direct child of the material button', matKids.join('|'));
}
const rated = Array.from(matBtns).find((b) => Array.from(b.children).some((c) => c.className === 'mat-head'));
ok(!!rated, 'a rated material gets a .mat-head line');
if (rated) {
  const headSpan = Array.from(rated.children).find((c) => c.className === 'mat-head');
  ok(/^~[\d.]+ m head$/.test(headSpan.textContent),
    'and its text is the full "~N m head" in ONE text node (the fold is CSS)', headSpan.textContent);
  ok(headSpan.children.length === 0, 'with no nested markup to go stale');
}

// stripFade() reads scrollWidth/clientWidth, which the stub does not have. It
// must degrade to "no fade" rather than throwing or latching a class on.
const strip = el('material-strip');
ok(!strip._cls.has('fade-l') && !strip._cls.has('fade-r'),
  'the scroll fade stays off when the strip cannot be measured');

// ---- 4. marquee rendering ----------------------------------------------

const ctx = canvas.getContext();
const counts = { strokeRect: 0, fillRect: 0, setLineDash: 0, fillText: 0 };
for (const name of Object.keys(counts)) {
  const orig = ctx[name];
  ctx[name] = (...a) => { counts[name]++; return orig.apply(ctx, a); };
}
const snap = () => Object.assign({}, counts);
const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));

game.loadLevel(2);
const S = game.getScene();
const A = S.terrain.anchors;
// Build two members so there is something for the box to catch.
for (let k = 0; k + 1 < Math.min(A.length, 3); k++) {
  const a = A[k], b = A[k + 1];
  emit('input:down', { x: a.x, y: a.y, px: 100, py: 100, id: 1, button: 0, cancel: false });
  emit('input:move', { x: b.x, y: b.y, px: 200, py: 100, id: 1, button: 0, cancel: false });
  frame(2);
  emit('input:up', { x: b.x, y: b.y, px: 200, py: 100, id: 1, button: 0, cancel: false });
}
const built = S.design.members.length;
ok(built > 0, 'the harness managed to build something to delete', built + ' members');

const B = builder.getBuilder();
const idle = snap();
frame(1);
const noBox = delta(idle, snap());
ok(B.marquee === null || B.marquee === undefined, 'no marquee while idle');

// A live marquee over the whole design.
const xs = S.design.nodes.map((n) => n.x), ys = S.design.nodes.map((n) => n.y);
B.tool = 'boxdelete';
B.marquee = { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
B.marqueeHits = S.design.members.map((mm) => mm.id);
const before = snap();
frame(1);
const withBox = delta(before, snap());
ok(withBox.strokeRect > noBox.strokeRect, 'a live marquee strokes a rect',
  withBox.strokeRect + ' vs ' + noBox.strokeRect);
ok(withBox.fillRect > noBox.fillRect, 'and fills it');
ok(withBox.setLineDash > noBox.setLineDash, 'and it is dashed');
ok(withBox.fillText > noBox.fillText, 'and labels the count');

// A degenerate (sub-pixel) box must not draw — that gesture is a tap, not a box.
B.marquee = { x0: 10, y0: 5, x1: 10, y1: 5 };
const tiny0 = snap();
frame(1);
const tiny = delta(tiny0, snap());
eq(tiny.strokeRect, 0, 'a zero-area marquee draws nothing');

// Garbage in the contract fields must not crash or draw.
for (const bad of [{ x0: NaN, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: Infinity, y1: 1 }, {}]) {
  B.marquee = bad;
  let threw = null;
  try { frame(1); } catch (e) { threw = e; }
  ok(!threw, 'a malformed marquee is ignored, not thrown on', JSON.stringify(bad));
}

// And back to nothing — the hit highlight must clear with it.
B.marquee = null; B.marqueeHits = [];
let threw = null;
try { frame(2); } catch (e) { threw = e; }
ok(!threw, 'clearing the marquee mid-frame is safe');

// The whole point of the danger colour: it must not be the same as anything
// else the build phase draws.
const { CONFIG } = await import(ROOT + '/src/config.js');
const R = CONFIG.render;
for (const k of ['marqueeFill', 'marqueeLine', 'marqueeHitColor', 'marqueeDash',
  'marqueeHitAlpha', 'marqueeCursorPx', 'marqueeMinPx']) {
  ok(R[k] !== undefined, 'CONFIG.render.' + k + ' exists');
}
ok(R.marqueeLine !== R.ghostOk && R.marqueeLine !== R.buildZoneLine,
  'the marquee outline is not the ghost or build-zone colour');

// ---- 5. static markup invariants ---------------------------------------
//
// The bottom stack is the fix for the toolbar bug, and it is a STRUCTURAL fix:
// if any of these five ever leaves #hud-bottom it can overlap the others again,
// and no unit test of behaviour would notice.

function block(html, id) {
  const open = html.indexOf('id="' + id + '"');
  if (open < 0) return null;
  const start = html.lastIndexOf('<', open);
  const tag = /^<([a-z-]+)/.exec(html.slice(start))[1];
  let i = start, depth = 0;
  const openRe = new RegExp('<' + tag + '[\\s>]', 'g');
  const closeRe = new RegExp('</' + tag + '>', 'g');
  // Simple depth walk over the two tag forms; the markup here is well formed.
  const rest = html.slice(start);
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos; closeRe.lastIndex = pos;
    const o = openRe.exec(rest), c = closeRe.exec(rest);
    if (!c) return rest;
    if (o && o.index < c.index) { depth++; pos = o.index + 1; continue; }
    depth--;
    pos = c.index + 1;
    if (depth === 0) return rest.slice(0, c.index + tag.length + 3);
  }
}

const bottom = block(HTML, 'hud-bottom');
ok(bottom !== null, '#hud-bottom exists in the markup');
for (const id of ['tutorial', 'build-hint', 'toolbar', 'sim-controls',
  'material-strip', 'material-bar', 'tool-group', 'btn-release']) {
  ok(bottom && bottom.indexOf('id="' + id + '"') >= 0, '#' + id + ' lives inside #hud-bottom');
}
const strip2 = block(HTML, 'material-strip');
ok(strip2 && strip2.indexOf('id="material-bar"') >= 0, '#material-strip wraps #material-bar');

const group = block(HTML, 'tool-group');
for (const id of ['btn-tool-build', 'btn-erase', 'btn-boxdelete', 'btn-undo', 'btn-redo', 'btn-clear']) {
  ok(group && group.indexOf('id="' + id + '"') >= 0, '#' + id + ' is in the fixed tool cluster');
}
ok(group && group.indexOf('id="btn-release"') < 0,
  'RELEASE WATER is NOT inside the tool cluster (it must never share its flex weight)');
ok(/title="[^"]*\(E\)"/.test(group || ''), 'the eraser advertises its E hotkey');
ok(/title="[^"]*\(X\)"/.test(group || ''), 'box-delete advertises its X hotkey');
// Every tool button needs an accessible name: three of them are icon-only SVG.
for (const seg of (group || '').split('<button').slice(1)) {
  const id = (/id="([^"]+)"/.exec(seg) || [])[1] || '?';
  ok(/aria-label="/.test(seg), '#' + id + ' has an aria-label');
}

// Ids the rest of the codebase resolves by getElementById — a rename here is a
// silent null everywhere else.
for (const id of ['splash', 'game', 'hud', 'hud-top', 'hud-toast', 'btn-hud-menu',
  'screen-title', 'screen-levels', 'screen-result', 'level-grid', 'levels-progress',
  'btn-play', 'btn-sandbox', 'btn-levels-back', 'btn-update', 'game-version',
  'tut-step', 'tut-title', 'tut-text', 'tut-dots', 'btn-tut-skip', 'btn-tut-next',
  'result-heading', 'result-cause', 'result-note', 'result-stats',
  'btn-result-retry', 'btn-result-edit', 'btn-result-next', 'btn-result-menu']) {
  ok(HTML.indexOf('id="' + id + '"') >= 0, 'id ' + id + ' survives the reshuffle');
}
// The splash work that shipped just before this must be untouched.
ok(HTML.indexOf('sp-word') >= 0 && HTML.indexOf('sp-rule') >= 0 && HTML.indexOf('sp-water') >= 0,
  'the inline splash (word + broken rule + water) is intact');

// ---- 6. static stylesheet invariants -----------------------------------

// The selector must START a line, or '.level-card {' also matches the tail of
// the shared '.big-btn, …, .level-card {' rule and reads the wrong block.
// Comments are stripped: these blocks explain themselves at length, and a
// declaration NAMED in a comment must not read as a declaration MADE.
function rule(css, selector) {
  const i = css.indexOf('\n' + selector + ' {');
  if (i < 0) return null;
  return css.slice(i + 1, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
}

const gridRule = rule(CSS, '#level-grid');
ok(gridRule && /grid-auto-rows:\s*max-content/.test(gridRule),
  '#level-grid pins grid-auto-rows: max-content — THE overflow fix');
ok(gridRule && /minmax\(min\(100%/.test(gridRule),
  'and its columns use minmax(min(100%, …)) so 320px still yields one column');

const cardRule = rule(CSS, '.level-card');
ok(cardRule && /display:\s*grid/.test(cardRule), '.level-card is a grid, not a wrapping flex row');
ok(cardRule && !/overflow:\s*hidden/.test(cardRule),
  '.level-card does NOT clip its own content (that trades bleeding for clipping)');

// The card is a div now, so :disabled cannot match it anywhere.
const disabledOnCard = /\.level-card[^,{}]*:disabled/.test(CSS);
ok(!disabledOnCard, 'no rule still tries to match .level-card:disabled');
ok(/\.level-card\[aria-disabled="true"\]/.test(CSS), 'the ARIA disabled state is styled instead');

const tbRule = rule(CSS, '#toolbar');
ok(tbRule && !/position:\s*absolute/.test(tbRule),
  '#toolbar is no longer absolutely positioned (it is a row in the stack)');
ok(tbRule && !/max-width:\s*calc\(100vw/.test(tbRule),
  'and it no longer reserves a magic pixel width for the release button');

const stackRule = rule(CSS, '#hud-bottom');
ok(stackRule && /flex-direction:\s*column/.test(stackRule), '#hud-bottom is a flex column');
ok(stackRule && /pointer-events:\s*none/.test(stackRule),
  'and is pointer-transparent so drags fall through to the canvas');

// The flex weights ARE the guarantee that the tools never get squeezed out.
ok(/#material-strip\s*\{[^}]*flex:\s*0 1 auto/.test(CSS.replace(/\n/g, ' '))
  || /#material-strip\s*\{\s*flex:\s*0 1 auto/.test(CSS),
  'in row mode only #material-strip may shrink');
ok(/#tool-group\s*\{[^}]*flex:\s*0 0 auto/.test(CSS.replace(/\n/g, ' ')),
  'the tool cluster is flex: 0 0 auto — unshrinkable');

// The 6-button cluster has to fit a 320px viewport without scrolling.
ok(/@media \(max-width: 379px\)/.test(CSS), 'there is a very-narrow tightening pass');
ok(/@media \(max-height: 520px\)/.test(CSS), 'and a short-viewport compact pass');
ok(/grid-template-areas:\s*"sw name" "cost head"/.test(CSS),
  'the compact pass folds the head rating onto the cost line as a 2x2 grid');
ok(/justify-content:\s*safe center/.test(CSS),
  '.screen centres SAFELY so a tall card is never cut off at the top');
// #material-strip is the one scroll container left; it must advertise itself.
ok(/#material-strip\.fade-r/.test(CSS) && /#material-strip\.fade-l/.test(CSS),
  'a clipped material strip gets a fade affordance on the clipped side');

// The HUD top row: the two rules that stop it colliding with the menu button
// one row below it.
ok(/\.hud-label \{[^}]*white-space: nowrap/.test(CSS),
  '.hud-label never wraps ("LEFT OF $5,470" broke onto three lines and the third landed on the menu button)');
const right = rule(CSS, '#hud-right');
ok(right && /min-width:\s*min-content/.test(right),
  '#hud-right holds its min-content, so only #hud-level (which ellipsises) loses width');
ok(/--hud-menu-gap/.test(CSS) && /var\(--hud-menu-gap\)/.test(CSS),
  'the menu gutter is one token shared by the button and the readouts, not two magic numbers');

// Canvas captions live under the DOM HUD, so their offset is a shared constant.
ok(R.zoneLabelTopPx >= 60,
  'CONFIG.render.zoneLabelTopPx clears the HUD top row', String(R.zoneLabelTopPx));
const rsrc = readFileSync(new URL('src/rendering/renderer.js', HERE), 'utf8');
ok(!/labelAt\(ctx, '(BUILD ZONE|PROTECT)'[^)]*22 \* dpr/.test(rsrc),
  'no zone caption is still pinned at the old 22px, under the HUD');
ok((rsrc.match(/zoneLabelY\(\)/g) || []).length >= 2,
  'both zone captions read the shared offset');

// Touch minimum, stated once and not undone anywhere.
ok(/min-height:\s*44px/.test(CSS), 'the 44px touch minimum is declared');
const compact = CSS.slice(CSS.indexOf('@media (max-height: 520px)'));
ok(!/\.tool-btn[^{]*\{[^}]*(width|height):\s*(3\d|2\d)px/.test(compact),
  'and the compact pass never shrinks a tool button below it');

// ---- report -------------------------------------------------------------

if (process.argv.includes('--verbose')) for (const n of notes) console.log(n);
console.log('\nui-layout: ' + notes.length + ' passed, ' + fails.length + ' failed');
for (const f of fails) console.log(' - ' + f);
process.exit(fails.length ? 1 : 0);
