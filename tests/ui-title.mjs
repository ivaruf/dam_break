// Title diorama harness (src/ui/titleScene.js). Run directly:
//
//     node tests/ui-title.mjs            # assertions, exits 0/1
//     node tests/ui-title.mjs --timeline # ... and print the storyboard
//
// Reuses the DOM/Canvas stubs from ui-smoke.mjs, so the diorama runs headless
// exactly as it does in the browser minus rasterisation.
//
// WHY THIS EXISTS: the loop's drama is EMERGENT — the dam breaks when its
// accumulated damage reaches 1, not when a script says so — which means the
// storyboard in CONFIG.render.title is a claim about the physics, and claims
// rot. Tuning it by taking screenshots at guessed timestamps is hopeless; this
// prints the whole 20 s in half a second and fails if the dam stops failing.
//
// It also guards the two things that could hurt the actual game: that the
// diorama's global events do not corrupt a real level afterwards, and that the
// accumulator cannot fast-forward a burst of physics on a slow frame.

import { readFileSync } from 'fs';
const src = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8');
const head = src.split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const { CONFIG } = await import(ROOT + '/src/config.js');
const title = await import(ROOT + '/src/ui/titleScene.js');
const game = await import(ROOT + '/src/core/game.js');
const { on } = await import(ROOT + '/src/core/events.js');
const water = await import(ROOT + '/src/physics/water.js');

const T = CONFIG.render.title;
const DT = CONFIG.physics.dt;
const VERBOSE = process.argv.includes('--timeline');

const fails = [];
const notes = [];
function ok(cond, label, detail) {
  (cond ? notes : fails).push((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  return !!cond;
}

// ---- 1. one full loop, measured ------------------------------------------

const events = { breaks: [], breach: 0, overtop: 0, impact: 0 };
on('member:break', (p) => events.breaks.push({ t: round(title._diorama().t), ...p }));
on('breach', () => events.breach++);
on('overtop', () => events.overtop++);
on('water:impact', () => events.impact++);

const round = (v) => Math.round(v * 100) / 100;

const D = title._make();
ok(D && D.structure && D.structure.members.length > 0, 'the diorama builds a structure',
  D && D.structure.members.length + ' members');
ok(D && D.water && D.water.pcount > 0, 'and a pre-filled reservoir',
  D && D.water.pcount + ' particles');
ok(D.terrain.anchors.length === 0,
  'its terrain carries NO anchors (no editor dots on the title screen)');
ok(D.structure.nodes.filter((n) => n.anchored).length === 2,
  'but both feet are pinned', D.structure.nodes.filter((n) => n.anchored).length + ' anchored');

const steps = Math.round(T.loop / DT);
let peakParticles = 0;
let peakBend = 0;
let firstBreakAt = -1;
const t0 = process.hrtime.bigint();
for (let i = 0; i < steps; i++) {
  const before = events.breaks.length;
  title._step(DT);
  if (events.breaks.length > before && firstBreakAt < 0) firstBreakAt = D.t;
  if (D.water.pcount > peakParticles) peakParticles = D.water.pcount;
  for (const m of D.structure.members) if (m.bendLoad > peakBend) peakBend = m.bendLoad;
  if (VERBOSE && i % 30 === 0) {
    const face = D.structure.members[0];
    console.log(`  t=${D.t.toFixed(1).padStart(4)} p=${String(D.water.pcount).padStart(4)}`
      + ` surf=${water.surfaceAt(D.water, 28).toFixed(2)}`
      + ` faceLoad=${face.broken ? '  X ' : face.load.toFixed(2)}`
      + ` dmg=${face.damage.toFixed(2)} broken=${D.structure.brokenCount}`);
  }
}
const simMs = Number(process.hrtime.bigint() - t0) / 1e6;
const loopBreaks = events.breaks.length;   // snapshot: later runs share the recorder

if (VERBOSE) {
  console.log('\n  events:');
  for (const b of events.breaks) {
    console.log(`    t=${b.t}  BREAK ${b.id} ${b.mode} load=${round(b.load)} sustained=${b.sustained}`);
  }
  console.log(`    breach x${events.breach}  overtop x${events.overtop}  impact x${events.impact}\n`);
}

// ---- 2. the storyboard still holds --------------------------------------

ok(loopBreaks >= 3, 'the dam breaks, and keeps breaking', loopBreaks + ' members');
ok(firstBreakAt > 8 && firstBreakAt < T.loop - 3.5,
  'the first break lands in the back half of the loop, with time to wash out',
  't=' + round(firstBreakAt));
ok(D.structure.firstFailure && D.structure.firstFailure.mode === 'bending',
  'it fails in BENDING — the water pushing a long unbraced span, not gravity',
  D.structure.firstFailure && D.structure.firstFailure.mode);
ok(peakBend > 1.0 && peakBend < 2.6,
  'the face is JUST weak enough: peak bendLoad past 1.0 but not absurd',
  round(peakBend));
ok(peakParticles > 800 && peakParticles < 2000,
  'particle count stays inside the ~1-2k budget', peakParticles + ' particles');
ok(simMs / steps < 3, 'physics cost per tick leaves room for the render',
  (simMs / steps).toFixed(3) + ' ms/tick over ' + steps + ' ticks');

// ---- 3. every cycle is identical ----------------------------------------
// The loop rebuilds fresh instances rather than resetting live ones precisely so
// that this holds. If it ever stops holding, something is carrying state across
// the cut and cycle 2 will drift away from cycle 1 on screen.

function fingerprint(d) {
  let h = 2166136261;
  const acc = (v) => { h ^= Math.round(v * 4096) | 0; h = Math.imul(h, 16777619); };
  for (let i = 0; i < d.water.pcount; i++) { acc(d.water.ppx[i]); acc(d.water.ppy[i]); }
  for (const m of d.structure.members) { acc(m.load); acc(m.damage); acc(m.broken ? 1 : 0); }
  return (h >>> 0).toString(16);
}

function runTo(seconds) {
  const d = title._make();
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) title._step(DT);
  return fingerprint(d);
}

const fpA = runTo(15);
const fpB = runTo(15);
ok(fpA === fpB, 'two cycles are bit-identical at t=15 (deterministic loop)', fpA + ' / ' + fpB);

// ---- 4. the accumulator cannot burst -----------------------------------

title._reset();
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
title.render(ctx, 0.016, 'title');
const tAfterFirst = title._diorama().t;
title.render(ctx, 5.0, 'title');            // a 5-second stall (tab was hidden)
const jumped = title._diorama().t - tAfterFirst;
ok(jumped <= T.maxTicks * DT + 1e-9,
  'a 5 s stall advances the sim by at most maxTicks, never 5 s of catch-up',
  jumped.toFixed(4) + 's <= ' + (T.maxTicks * DT).toFixed(4) + 's');

const stat = title.stats();
ok(stat.stage !== 'disabled', 'render() did not throw itself into the disabled state', stat.stage);
ok(stat.particles > 0, 'and it reports a live particle count', String(stat.particles));

// ---- 5. level select framing --------------------------------------------

title.render(ctx, 0.016, 'levelselect');
ok(title.stats().stage !== 'disabled', 'the levelselect framing renders too');

// ---- 6. NO STATE LEAKAGE ------------------------------------------------
// The diorama emits real 'member:break' / 'breach' / 'overtop' events on the
// global bus while it runs. This is the check that says so harmlessly: break the
// title dam, THEN play a level, and require the level to behave.

title._reset();
const dam = title._make();
for (let i = 0; i < Math.round(16 / DT); i++) title._step(DT);
ok(dam.structure.brokenCount > 0, 'setup: the title dam has broken before we start a level',
  dam.structure.brokenCount + ' broken');

game.boot(canvas);
game.loadLevel(1);
const S = game.getScene();
ok(S.phase === 'build' && !!S.terrain, 'a level still loads after a title-screen breach', S.phase);
ok(S.structure === null, 'and starts with no structure of its own');
ok(S.camera.shakeX === 0 && S.camera.shakeY === 0,
  'the GAME camera has no leftover shake from the diorama',
  S.camera.shakeX + ',' + S.camera.shakeY);

// build a real dam and run it
const A = S.terrain.anchors;
S.design.nodes.push({ id: 'L0', x: A[0].x, y: A[0].y, anchorId: A[0].id });
S.design.nodes.push({ id: 'R0', x: A[1].x, y: A[1].y, anchorId: A[1].id });
S.design.nodes.push({ id: 'L1', x: A[0].x, y: A[0].y + 2.4, anchorId: null });
S.design.nodes.push({ id: 'R1', x: A[1].x, y: A[1].y + 2.4, anchorId: null });
for (const [id, a, b] of [['g1', 'L0', 'L1'], ['g2', 'R0', 'R1'], ['g3', 'L1', 'R1'], ['g4', 'L0', 'R1']]) {
  S.design.members.push({ id, a, b, mat: 'timber' });
}
game.release();
ok(S.phase === 'sim' && S.structure && S.structure.members.length === 4,
  'the level simulates its OWN structure', S.structure && S.structure.members.length + ' members');

const waterBefore = S.water;
const titleBefore = title._diorama();
let t = 1000;
for (let i = 0; i < 200; i++) { t += 16.7; game.frame(t); }

ok(S.simTime > 0.5, 'the level accumulates sim time', S.simTime.toFixed(2) + 's');
ok(S.water === waterBefore, 'the level kept its own water instance');
ok(S.water.stats.totalIn > 0, 'and its own inflow bookkeeping', round(S.water.stats.totalIn));
ok(title._diorama() === titleBefore,
  'the diorama did NOT step while a level was playing (game.js gates it on phase)');
ok(Number.isFinite(S.structure.maxLoad) && S.structure.maxLoad >= 0,
  'the level structure has sane loads', round(S.structure.maxLoad));

const modes = await import(ROOT + '/src/build/modes.js');
const st = modes.getStats();
ok(st && Number.isFinite(st.retained),
  'modes.js is tracking the LEVEL, not the diorama', st && round(st.retained));

// and back to the title: the diorama must pick up where it left off, not burst
game.getScene().phase = 'title';
title.render(ctx, 0.016, 'title');
ok(title._diorama() && Math.abs(title._diorama().t - titleBefore.t) < 0.05,
  'returning to the title resumes the diorama without a catch-up burst',
  round(title._diorama().t) + ' vs ' + round(titleBefore.t));

// ---- report -------------------------------------------------------------

for (const n of notes) console.log(n);
for (const f of fails) console.log(f);
console.log(`\nfirst break t=${round(firstBreakAt)}  breaks=${loopBreaks}`
  + `  peakParticles=${peakParticles}  peakBend=${round(peakBend)}`
  + `  ${(simMs / steps).toFixed(3)} ms/tick`);
console.log(`\n${notes.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
