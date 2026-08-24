// Player-facing feedback for DAMAGE MODEL v2.1 (bending + creep). Opus C.
// Run directly:  node tests/ui-feedback.mjs
//
// Reuses the DOM/Canvas stubs from ui-smoke.mjs (the half above its "run"
// marker), then wraps the canvas context so the tests can read back WHAT WAS
// DRAWN: control points of quadratic curves (bows), stroke styles (the creep
// halo vs the overload flash), and the path segments inside one stroke (crack
// ticks). The renderer is called DIRECTLY rather than through game.frame(), so
// the physics cannot overwrite the member fields a test has just set.
//
// The three things that must not regress:
//   1. with the v2.1 fields UNDEFINED, output is identical to zeroed fields
//      (the mid-integration guarantee — no bow, no clustering, no pulse);
//   2. a bending bow points ALONG the water force and beats the axial bow;
//   3. "damage is growing right now" reads differently from "overloaded".

import { readFileSync } from 'fs';
const head = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8').split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const game = await import(ROOT + '/src/core/game.js');
const renderer = await import(ROOT + '/src/rendering/renderer.js');
const { emit, on } = await import(ROOT + '/src/core/events.js');
const { MATERIALS } = await import(ROOT + '/src/build/materials.js');
const modes = await import(ROOT + '/src/build/modes.js');
const { CONFIG } = await import(ROOT + '/src/config.js');

const R = CONFIG.render;
const problems = [];
function ok(cond, label, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '   ' + extra : ''));
  if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
}

// ---- canvas recording ----------------------------------------------------

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const rawMove = ctx.moveTo, rawLine = ctx.lineTo, rawQuad = ctx.quadraticCurveTo;
const rawBegin = ctx.beginPath, rawStroke = ctx.stroke;

let curves = [];      // {from, c, to} for every quadratic drawn this frame
let strokes = [];      // {style, width, alpha, segs} for every stroke this frame
let segs = [];         // straight segments in the path being built
let pen = [0, 0];

ctx.moveTo = (x, y) => { pen = [x, y]; rawMove(x, y); };
ctx.lineTo = (x, y) => { segs.push({ from: pen, to: [x, y] }); pen = [x, y]; rawLine(x, y); };
ctx.quadraticCurveTo = (cx, cy, x, y) => {
  curves.push({ from: pen, c: [cx, cy], to: [x, y] });
  pen = [x, y];
  rawQuad(cx, cy, x, y);
};
ctx.beginPath = () => { segs = []; rawBegin(); };
ctx.stroke = () => {
  strokes.push({ style: ctx.strokeStyle, width: ctx.lineWidth, alpha: ctx.globalAlpha, segs });
  rawStroke();
};

function paint() {
  curves = []; strokes = [];
  renderer.render(ctx, S.camera, S);
}

const styled = (s) => strokes.filter((k) => k.style === s);

// ---- boot ---------------------------------------------------------------

game.boot(canvas);
let now = 0;
const frames = (n) => { for (let i = 0; i < n; i++) { now += 16.7; game.frame(now); } };

// =========================================================================
// 1. HUD — material head ratings
// =========================================================================
console.log('\nHUD — material head ratings');

function matBar() {
  return document.getElementById('material-bar').children.map((btn) => ({
    mat: btn.dataset.mat,
    head: (btn.children.find((c) => c.className === 'mat-head') || {}).textContent,
    title: btn.title,
    tall: btn.children.length,
  }));
}

game.loadLevel(4);            // the first level that offers all four materials
frames(3);
let bar = matBar();
const timber = bar.find((b) => b.mat === 'timber');
const cable = bar.find((b) => b.mat === 'cable');
ok(bar.length === 4, 'all four material buttons built', bar.map((b) => b.mat).join(','));
ok(!!timber && timber.head === '~' + MATERIALS.timber.headRating + ' m head',
  'timber shows its head rating', timber && timber.head);
ok(!!timber && /m of water head/.test(timber.title), 'the rating is in the tooltip too',
  timber && timber.title);
ok(!!cable && cable.head === undefined,
  'cable (headRating 0, seals nothing) gets NO rating line', String(cable && cable.head));

// mid-integration fallback: no headRating anywhere -> no rating line anywhere
const saved = {};
for (const id of Object.keys(MATERIALS)) { saved[id] = MATERIALS[id].headRating; delete MATERIALS[id].headRating; }
game.loadLevel(3);           // different material list, so the bar rebuilds
frames(2);
game.loadLevel(4);
frames(2);
bar = matBar();
ok(bar.every((b) => b.head === undefined), 'headRating undefined: every rating line is absent',
  bar.map((b) => b.mat + ':' + b.head).join(' '));
ok(bar.every((b) => !/water head/.test(b.title)), 'and no tooltip claims a rating');
for (const id of Object.keys(MATERIALS)) MATERIALS[id].headRating = saved[id];

// =========================================================================
// 2. RENDERER — one lone vertical member we control completely
// =========================================================================
console.log('\nRENDERER — bending bow');

game.loadLevel(1);
frames(2);
const S = game.getScene();
const anchor = S.terrain.anchors[0];
S.design.nodes.length = 0; S.design.members.length = 0;
S.design.nodes.push({ id: 'fa', x: anchor.x, y: anchor.y, anchorId: anchor.id });
S.design.nodes.push({ id: 'fb', x: anchor.x, y: anchor.y + 3, anchorId: null });
S.design.members.push({ id: 'fm', a: 'fa', b: 'fb', mat: 'timber' });
game.release();
const m = S.structure.members.find((x) => x.id === 'fm');
if (!m) { console.log('  FAIL  test member did not instantiate'); process.exit(1); }
S.simTime = 1;

const zoom = () => S.camera.zoom;
const mid = (c) => [(c.from[0] + c.to[0]) * 0.5, (c.from[1] + c.to[1]) * 0.5];
// screen offset of the control point, back in WORLD axes (screen y is flipped)
function bowWorld(c) {
  const mp = mid(c);
  return [(c.c[0] - mp[0]) / zoom(), -(c.c[1] - mp[1]) / zoom()];
}
// the member's own curve: the one whose chord matches its endpoints
function memberCurve() {
  const [ax, ay] = S.camera.worldToScreen(m.a.x, m.a.y);
  return curves.find((c) => Math.hypot(c.from[0] - ax, c.from[1] - ay) < 1.5 ||
    Math.hypot(c.to[0] - ax, c.to[1] - ay) < 1.5);
}

function reset(over) {
  m.broken = false; m.loadSign = 1; m.load = 0; m.damage = 0;
  m.bendLoad = 0; m.waterFx = 0; m.waterFy = 0; m.waterFperp = 0;
  Object.assign(m, over || {});
}

// --- the mid-integration guarantee ---
reset({ load: 0.9, loadSign: -1, damage: 0.5 });
paint();
const zeroed = curves.map((c) => c.c.map((v) => v.toFixed(2)).join()).join('|');
const zeroedStrokes = strokes.length;
delete m.bendLoad; delete m.waterFx; delete m.waterFy; delete m.waterFperp;
paint();
const absent = curves.map((c) => c.c.map((v) => v.toFixed(2)).join()).join('|');
ok(absent === zeroed && strokes.length === zeroedStrokes,
  'v2.1 fields UNDEFINED draw exactly what zeroed fields draw',
  absent === zeroed ? 'curves+strokes identical' : absent + ' vs ' + zeroed);

// --- direction: along the water force, whatever the endpoint order ---
for (const [fx, fy] of [[900, -300], [-900, 300], [-500, -800]]) {
  reset({ load: 0.9, bendLoad: 0.9, waterFx: fx, waterFy: fy });
  paint();
  const c = memberCurve();
  if (!c) { ok(false, `bending bow drawn for water force (${fx},${fy})`); continue; }
  const b = bowWorld(c);
  const dot = b[0] * fx + b[1] * fy;
  ok(dot > 0, `bow leans ALONG the water force (${fx}, ${fy})`,
    'bow=(' + b[0].toFixed(2) + ',' + b[1].toFixed(2) + ') dot=' + dot.toFixed(0));
}

// --- magnitude: sagitta from bendLoad, capped, scaled by span ---
reset({ load: 0.9, bendLoad: 0.9, waterFx: 900, waterFy: 0 });
paint();
{
  const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
  const want = Math.min(
    R.bendBowMax * Math.min(R.bendBowCap, 0.9) * Math.min(R.bendBowLenMax, len / R.bendBowRefLen),
    len * R.bendBowLenFrac);
  const got = Math.hypot(...bowWorld(memberCurve())) * 0.5;   // control point = 2× sagitta
  ok(Math.abs(got - want) < 0.01, 'sagitta matches bendLoad × span, capped',
    'got ' + got.toFixed(3) + ' m, want ' + want.toFixed(3) + ' m');
}

// --- a huge bendLoad is still capped, and below the cue there is no bow ---
reset({ load: 4, bendLoad: 4, waterFx: 900, waterFy: 0 });
paint();
{
  const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
  const got = Math.hypot(...bowWorld(memberCurve())) * 0.5;
  ok(got <= len * R.bendBowLenFrac + 1e-6, 'runaway bendLoad cannot draw a banana',
    got.toFixed(3) + ' m ≤ ' + (len * R.bendBowLenFrac).toFixed(3) + ' m');
}
reset({ load: R.bendBowFrom - 0.01, bendLoad: R.bendBowFrom - 0.01, waterFx: 900 });
paint();
ok(!memberCurve(), 'bendLoad under the cue threshold draws no bow');

// A force PARALLEL to the member has no lateral component, so there is nothing
// to bow — and no side to bow towards. (stress.js would report bendLoad 0 here;
// this only pins down what the renderer does with an inconsistent pair.)
reset({ load: 0.9, bendLoad: 0.9, waterFx: 0, waterFy: 900 });   // member is vertical
paint();
ok(!memberCurve(), 'a purely axial water force draws no lateral bow');

// --- bending beats the axial compression bow (they must not fight) ---
reset({ load: 0.9, loadSign: -1, bendLoad: 0.9, waterFx: 900, waterFy: 0 });
paint();
{
  const b = bowWorld(memberCurve());
  const axialSag = R.bowMax * 0.9 * 2;      // what the compression bow would have drawn
  ok(b[0] > 0 && Math.abs(Math.hypot(...b) - axialSag) > 0.05,
    'when bending governs its bow WINS over the axial one',
    'bow=(' + b[0].toFixed(2) + ',' + b[1].toFixed(2) + ')');
}
// ... and a compressed member with no bending still bows the old way
reset({ load: 0.9, loadSign: -1 });
paint();
ok(!!memberCurve(), 'plain axial compression still bows');

// =========================================================================
// 3. RENDERER — crack ticks cluster at midspan under bending
// =========================================================================
console.log('\nRENDERER — crack ticks');

// t along the member for each tick centre, from the crack-coloured stroke
function tickTs() {
  const crack = styled(R.crackColor)[0];
  if (!crack) return [];
  const [ax, ay] = S.camera.worldToScreen(m.a.x, m.a.y);
  const [bx, by] = S.camera.worldToScreen(m.b.x, m.b.y);
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  return crack.segs.map((s) => {
    const cx = (s.from[0] + s.to[0]) * 0.5, cy = (s.from[1] + s.to[1]) * 0.5;
    return ((cx - ax) * dx + (cy - ay) * dy) / l2;
  });
}

reset({ load: 0.9, loadSign: -1, damage: 1 });
paint();
const axialTs = tickTs();
reset({ load: 0.9, bendLoad: 0.9, damage: 1, waterFx: 900 });
paint();
const bendTs = tickTs();
const spread = (ts) => (ts.length ? Math.max(...ts.map((t) => Math.abs(t - 0.5))) : -1);
ok(bendTs.length > 1 && spread(bendTs) <= R.bendCrackSpread / 2 + 1e-6,
  'bending-governed ticks cluster at MIDSPAN',
  bendTs.map((t) => t.toFixed(2)).join(' '));
ok(axialTs.length > 1 && spread(axialTs) > R.bendCrackSpread / 2,
  'axial ticks stay spread along the member',
  axialTs.map((t) => t.toFixed(2)).join(' '));

// =========================================================================
// 4. RENDERER — the creep pulse
// =========================================================================
console.log('\nRENDERER — creep pulse');

const pulses = () => styled(R.creepPulseColor).length;
const flashes = () => styled('#ffffff').length;

reset({ load: 0.5, damage: 0.30 });          // well under stressWarn: no flash
S.simTime = 2.0; paint();                     // first sample — nothing to compare to
ok(pulses() === 0, 'a single frame of damage is not yet "creeping"');
m.damage = 0.31;
S.simTime = 2.1; paint();
ok(pulses() > 0, 'damage GROWING draws the creep halo');
ok(flashes() === 0, 'and it is not the overload flash (load 0.5 < stressWarn)');
S.simTime = 2.2; paint();                     // static, still inside creepHold
ok(pulses() > 0, 'the cue holds briefly so quantised damage cannot strobe it');
S.simTime = 2.1 + R.creepHold + 0.05; paint();
ok(pulses() === 0, 'and stops once the damage has actually stopped growing');

// the two warnings are visually separable: different colour, and the halo is
// slow where the flash is fast
m.damage = 0.4; S.simTime += 0.1; paint();
const holdT = S.simTime;
reset({ load: 1.1, damage: 0.4 });            // now BOTH cues at once
S.simTime = holdT + 0.05; paint();
ok(pulses() > 0 && flashes() > 0, 'a member that is overloaded AND creeping shows both cues');
ok(R.creepPulseHz < R.flashHz * 0.5, 'the creep pulse is slow where the flash is fast',
  R.creepPulseHz + ' Hz vs ' + R.flashHz + ' Hz');

// deterministic: same sim time, same pixels
reset({ load: 0.9, bendLoad: 0.9, damage: 0.5, waterFx: 900 });
S.simTime = 7.5; paint();
const shotA = JSON.stringify(strokes.map((s) => [s.style, +s.alpha.toFixed(4)]));
S.simTime = 7.5; paint();
const shotB = JSON.stringify(strokes.map((s) => [s.style, +s.alpha.toFixed(4)]));
ok(shotA === shotB, 'the whole pass is deterministic at a given sim time');

// =========================================================================
// 5. MODES + SCREENS — the two new failure stories
// =========================================================================
console.log('\nMODES — cause lines, SCREENS — coaching');

let lastCause = '';
on('level:fail', ({ cause }) => { lastCause = cause; });

function failWith(ff, breakPayload) {
  game.loadLevel(1);
  frames(2);
  const Sc = game.getScene();
  Sc.design.nodes.length = 0; Sc.design.members.length = 0;
  Sc.design.nodes.push({ id: 'ca', x: anchor.x, y: anchor.y, anchorId: anchor.id });
  Sc.design.nodes.push({ id: 'cb', x: anchor.x + 4.6, y: anchor.y, anchorId: null });
  Sc.design.members.push({ id: 'cm', a: 'ca', b: 'cb', mat: 'timber' });
  game.release();
  lastCause = '';
  if (breakPayload) emit('member:break', breakPayload);
  Sc.structure.firstFailure = ff;
  const live = modes.getStats();          // scene.stats is null until the run ends
  live.peakDepth = 3.2;
  live.maxLoad = 0.9;
  // a retain objective that cannot be met, decided on the next tick: the cause
  // builder then runs down the firstFailure branch with nothing racing it
  Sc.level.objective = { type: 'retain', minRetention: 1.1, duration: 0.001 };
  frames(4);
  return lastCause;
}

const mid4 = { memberId: 'cm', mode: 'bending', time: 12.3, x: anchor.x + 2.3, y: anchor.y };
let cause = failWith(mid4, null);
ok(/^SNAPPED AT MIDSPAN — 4\.6 m SPAN OF TIMBER UNDER 3\.2 m OF WATER at 12\.3s$/.test(cause),
  'bending cause line reads as a midspan snap of a measured span', cause);
let note = document.getElementById('result-note').textContent;
ok(/Long spans snap in the middle/.test(note), 'and the result screen coaches bending', note);

cause = failWith(
  { memberId: 'cm', mode: 'bending', time: 28.4, x: anchor.x + 2.3, y: anchor.y, sustained: true },
  { id: 'cm', x: 0, y: 0, mode: 'bending', matId: 'timber', load: 0.87, sustained: true });
ok(/^GAVE WAY UNDER SUSTAINED LOAD — HELD AT 87% FOR \d+ s$/.test(cause),
  'creep cause line reports the load it held and for how long', cause);
note = document.getElementById('result-note').textContent;
ok(/sustained pressure eats weak material/.test(note), 'and the result screen coaches creep', note);

// the axial stories must be untouched
cause = failWith({ memberId: 'cm', mode: 'tension', time: 5.5, x: anchor.x, y: anchor.y }, null);
ok(/TENSION LIMIT EXCEEDED at 5\.5s$/.test(cause), 'tension cause line unchanged', cause);
note = document.getElementById('result-note').textContent;
ok(/strongest in tension/.test(note), 'tension coaching unchanged', note);

// =========================================================================
// 6. The mid-integration guarantee, over a WHOLE dam under real physics
// =========================================================================
console.log('\nWHOLE-FRAME fallback (a real dam, real loads)');

game.loadLevel(3);
frames(2);
{
  const Sc = game.getScene();
  const as = [...Sc.terrain.anchors].sort((p, q) => p.x - q.x);
  const xs = [as[0].x, (as[0].x + as[as.length - 1].x) / 2, as[as.length - 1].x];
  const ids = [as[0].id, null, as[as.length - 1].id];
  Sc.design.nodes.length = 0; Sc.design.members.length = 0;
  let u = 0;
  const N = (x, y, anchorId) => {
    const id = 'wn' + (++u);
    Sc.design.nodes.push({ id, x, y, anchorId: anchorId || null });
    return id;
  };
  const Mk = (a, b) => Sc.design.members.push({ id: 'wm' + (++u), a, b, mat: 'timber' });
  const base = Math.max(...xs.map((x) => Sc.terrain.heightAt(x)));
  const grid = xs.map((x, c) => {
    let prev = N(x, Sc.terrain.heightAt(x), ids[c]);
    const col = [prev];
    for (let r = 1; r <= 2; r++) { const n = N(x, base + r * 2.6); Mk(prev, n); prev = n; col[r] = n; }
    return col;
  });
  for (let r = 1; r <= 2; r++) for (let c = 0; c + 1 < 3; c++) Mk(grid[c][r], grid[c + 1][r]);

  game.release();
  frames(1200);                       // ~20 s of sim: real water, real bending, real damage
  const ms = game.getScene().structure.members;

  const trace = () => {
    paint();
    return JSON.stringify([
      curves.map((c) => c.c.map((v) => v.toFixed(2))),
      strokes.map((s) => [s.style, +s.alpha.toFixed(4), +s.width.toFixed(2), s.segs.length]),
    ]);
  };

  const live = trace();
  const bowingNow = ms.filter((k) => !k.broken && k.bendLoad > R.bendBowFrom).length;
  for (const k of ms) { k.bendLoad = 0; k.waterFx = 0; k.waterFy = 0; k.waterFperp = 0; }
  const zero = trace();
  for (const k of ms) { delete k.bendLoad; delete k.waterFx; delete k.waterFy; delete k.waterFperp; }
  const gone = trace();

  ok(zero === gone, 'whole frame: undefined v2.1 fields === zeroed v2.1 fields',
    ms.length + ' members, ' + JSON.parse(zero)[1].length + ' strokes compared');
  ok(bowingNow === 0 || live !== zero, 'and the cues really are doing something when present',
    bowingNow + ' members over the bow threshold');
}

console.log('\nPROBLEMS:', problems.length);
for (const p of problems) console.log(' -', p);
process.exit(problems.length ? 1 : 0);
