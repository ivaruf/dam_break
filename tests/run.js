// OPUS A owns. `node tests/run.js [sceneNum ...]` — physics test scenes 1-8.
// Prints PASS/FAIL per assertion, a per-scene verdict, then determinism and
// performance checks. Assumes src/physics/*.js implement the documented
// contract (ARCHITECTURE.md) — it is fine/expected for this to fail while
// that rewrite is in progress.

import { testLevel, SCENE_COUNT, SCENE2, buildWall, P } from './scenes.js';
import {
  buildScene, createRecorder, runSim, createSuite,
  avgLoad, memberById,
} from './harness.js';
import { volumeBetween, velAt, totalVolume } from '../src/physics/water.js';
import { LEVELS } from '../src/levels/levels.js';
import { CONFIG } from '../src/config.js';

// Tunable pass/fail thresholds. Opus A retunes these against the real sim.
const A = {
  scene2Push: 40,          // N applied every tick to the truss/frame top nodes
  scene5DrainMargin: 0.05, // m^2 volume margin distinguishing sealed vs holed
  scene6WaveSpeed: 3.0,    // m/s peak velocity near the dam that counts as "a wave hit"
  scene6ProbeBack: 3,      // m upstream of the dam to sample approach velocity
  scene7Downstream: 0.2,   // m^2 downstream volume growth required past t=5s
  scene8Spread: 0.5,       // s minimum time between first and last break (progressive, not instant)

  // foundations (unanchored gravity dam)
  foundStandDepth: 3,      // m of water the dam must hold without moving
  foundSlideDepth: 7,      // m of water that must shove it
  foundStandMax: 0.05,     // m of drift still counted as "did not move"
  foundSlideMin: 1.0,      // m of base travel that counts as sliding

  // cables
  cableHangMinY: 0.5,      // m; a suspended load must stay off the ground
  cableLift: 400,          // N pushed up to prove the cable goes slack
  cableSlackFrac: 0.99,    // taut length fraction below which it counts as slack
  cableStretchTol: 3,      // allowed stretch as a multiple of the tension limit
  cableSquashTol: 0.05,    // m of separation growth allowed for a squashed cable
};

function printSuite(t) {
  console.log(`\n${t.name}`);
  let pass = true;
  for (const r of t.results()) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.label} -- ${r.detail}`);
    if (!r.pass) pass = false;
  }
  return pass;
}

function driftOf(structure, initial, id) {
  const n = structure.nodes.find((x) => x.id === id);
  const p0 = initial.get(id);
  return Math.hypot(n.x - p0.x, n.y - p0.y);
}

function scene1() {
  const spec = testLevel(1);
  const ctx = buildScene(spec);
  const t = createSuite('Scene 1 -- gravity beam falls and rests');
  let minY = Infinity;
  runSim(ctx, 5, {
    onTick: () => {
      for (const n of ctx.structure.nodes) minY = Math.min(minY, n.y);
    },
  });
  t.gt(5 - minY, 4, 'min y dropped more than 4m during the fall');
  for (const n of ctx.structure.nodes) {
    t.ok(n.y <= 0.35 && n.y >= -0.05, `node ${n.id} rests near ground`, `y=${n.y.toFixed(4)}`);
    const speed = Math.abs(n.x - n.px) / CONFIG.physics.dt;
    t.lt(speed, 0.15, `node ${n.id} residual speed`);
  }
  t.ok(!ctx.structure.members[0].broken, 'beam member intact');
  return printSuite(t);
}

function scene2() {
  const spec = testLevel(2);
  const ctx = buildScene(spec);
  const t = createSuite('Scene 2 -- truss vs frame under lateral push');
  const initial = new Map(ctx.structure.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  runSim(ctx, 6, {
    onTick: () => {
      const tri = ctx.structure.nodes.find((n) => n.id === SCENE2.triangleTop);
      tri.fx += A.scene2Push;
      for (const id of SCENE2.frameTops) {
        ctx.structure.nodes.find((n) => n.id === id).fx += A.scene2Push;
      }
    },
  });
  const triDrift = driftOf(ctx.structure, initial, SCENE2.triangleTop);
  const frameDrift = Math.max(...SCENE2.frameTops.map((id) => driftOf(ctx.structure, initial, id)));
  t.lt(triDrift, 0.05, 'triangle top drift stays small');
  t.gt(frameDrift, 3 * triDrift, 'frame top drift exceeds 3x triangle top drift');
  for (const id of SCENE2.anchoredIds) {
    t.eq(driftOf(ctx.structure, initial, id), 0, `anchored node ${id} drift exactly 0`);
  }
  return printSuite(t);
}

function scene3() {
  const spec = testLevel(3);
  const ctx = buildScene(spec);
  const { x0, x1 } = spec.water.initial[0];
  const v0 = volumeBetween(ctx.water, x0, x1);
  const t = createSuite('Scene 3 -- shallow water');
  runSim(ctx, 20);
  t.eq(ctx.structure.brokenCount, 0, 'no members break');
  t.lt(ctx.structure.maxLoad, 0.8, 'max load stays under 0.8');
  const v1 = volumeBetween(ctx.water, x0, x1);
  t.gt(v1 / v0, 0.97, 'upstream volume retained > 0.97 of initial');
  return printSuite(t);
}

function scene4() {
  let allPass = true;

  {
    const spec = testLevel(4, { variant: 'weak' });
    const ctx = buildScene(spec);
    const t = createSuite('Scene 4 -- deep water (weak wall)');
    runSim(ctx, 15);
    t.gt(ctx.structure.brokenCount, 0, 'weak wall breaks under deep water');
    t.ok(ctx.structure.firstFailure !== null, 'firstFailure recorded');
    allPass = printSuite(t) && allPass;
  }

  {
    const spec = testLevel(4, { variant: 'strong' });
    const ctx = buildScene(spec);
    const { bottomMembers, topMembers } = spec.testMeta;
    const t = createSuite('Scene 4 -- deep water (strong wall)');
    let sample = null;
    runSim(ctx, 15, {
      onTick: (time) => {
        if (!sample && time >= 2) {
          sample = { bottom: avgLoad(ctx.structure, bottomMembers), top: avgLoad(ctx.structure, topMembers) };
        }
      },
    });
    t.eq(ctx.structure.brokenCount, 0, 'strong wall does not break');
    t.gt(sample.bottom, 2 * sample.top, 'bottom-bay load > 2x top-bay load at t=2s (settled)');
    const endBottom = avgLoad(ctx.structure, bottomMembers);
    const endTop = avgLoad(ctx.structure, topMembers);
    t.gt(endBottom, 2 * endTop, 'bottom-bay load > 2x top-bay load at end');
    allPass = printSuite(t) && allPass;
  }

  return allPass;
}

function scene5() {
  const sealedSpec = testLevel(5, { variant: 'sealed' });
  const sealedCtx = buildScene(sealedSpec);
  const { upstream, downstream } = sealedSpec.testMeta;
  const initialUp = volumeBetween(sealedCtx.water, upstream[0], upstream[1]);
  const sealedRec = createRecorder();
  runSim(sealedCtx, 20, { recorder: sealedRec });
  sealedRec.stop();

  const holedSpec = testLevel(5, { variant: 'holed' });
  const holedCtx = buildScene(holedSpec);
  const holedRec = createRecorder();
  runSim(holedCtx, 20, { recorder: holedRec });
  holedRec.stop();

  const t = createSuite('Scene 5 -- hole in dam, sealed vs holed');
  const sealedUp = volumeBetween(sealedCtx.water, upstream[0], upstream[1]);
  const holedUp = volumeBetween(holedCtx.water, upstream[0], upstream[1]);
  const sealedDown = volumeBetween(sealedCtx.water, downstream[0], downstream[1]);
  const holedDown = volumeBetween(holedCtx.water, downstream[0], downstream[1]);

  t.gt(sealedUp - holedUp, A.scene5DrainMargin, 'sealed retains more upstream volume than holed');
  t.gt(holedDown, sealedDown + A.scene5DrainMargin, 'holed drains more into downstream than sealed');
  t.gt(sealedUp / initialUp, 0.98, 'sealed retains > 0.98 of initial upstream volume');
  t.gt(holedRec.breaches.length, 0, 'holed dam emits breach events');
  t.eq(sealedRec.breaches.length, 0, 'sealed dam emits no breach');
  t.eq(sealedRec.overtops.length, 0, 'sealed dam emits no overtop');
  const by = holedRec.breaches[0] ? holedRec.breaches[0].y : -1;
  t.ok(by > P.scene5.holeY0 - 1 && by < P.scene5.holeY1 + 1,
    'breach is reported at the hole, not somewhere else', `y=${by.toFixed(2)}`);
  return printSuite(t);
}

function scene6() {
  const staticSpec = testLevel(6, { variant: 'static' });
  const staticCtx = buildScene(staticSpec);
  const t1 = createSuite('Scene 6 -- flood wave (static pond)');
  runSim(staticCtx, 20);
  t1.eq(staticCtx.structure.brokenCount, 0, 'static pond does not break the wall');
  const passStatic = printSuite(t1);

  const waveSpec = testLevel(6, { variant: 'wave' });
  const waveCtx = buildScene(waveSpec);
  const rec = createRecorder();
  const { damX } = waveSpec.testMeta;
  let peakVel = 0;
  runSim(waveCtx, 20, {
    recorder: rec,
    onTick: () => {
      // sample clear of the dam's own sealed footprint: right at a sealed
      // boundary the water has (correctly) already stopped
      const v = Math.abs(velAt(waveCtx.water, damX - A.scene6ProbeBack));
      if (v > peakVel) peakVel = v;
    },
  });
  rec.stop();
  const t2 = createSuite('Scene 6 -- flood wave (moving wave, equal volume)');
  t2.gt(waveCtx.structure.brokenCount, 0, 'the moving wave breaks the wall');
  t2.gt(rec.impacts.length, 0, 'at least one water:impact recorded');
  t2.gt(peakVel, A.scene6WaveSpeed, 'peak velocity near the dam exceeds threshold');
  const passWave = printSuite(t2);

  return passStatic && passWave;
}

function scene7() {
  const spec = testLevel(7);
  const ctx = buildScene(spec);
  const rec = createRecorder();
  const { damX, downstream } = spec.testMeta;
  const b = Math.round((damX - ctx.water.x0) / ctx.water.cellW);
  let downAt5 = null;
  let maxWeir = 0;
  runSim(ctx, 30, {
    recorder: rec,
    onTick: (time) => {
      if (downAt5 === null && time >= 5) downAt5 = volumeBetween(ctx.water, downstream[0], downstream[1]);
      const wf = Math.abs(ctx.water.weirFlow[b]);
      if (wf > maxWeir) maxWeir = wf;
    },
  });
  rec.stop();
  const t = createSuite('Scene 7 -- overtopping');
  t.eq(ctx.structure.brokenCount, 0, 'wall does not break');
  t.gt(rec.overtops.length, 0, 'at least one overtop event recorded');
  t.gt(maxWeir, 0, 'weir flow at the dam boundary > 0');
  const downEnd = volumeBetween(ctx.water, downstream[0], downstream[1]);
  t.gt(downEnd, downAt5 + A.scene7Downstream, 'downstream volume grows past its t=5s baseline');
  return printSuite(t);
}

function scene8() {
  const spec = testLevel(8);
  const ctx = buildScene(spec);
  const rec = createRecorder();
  const { downstream } = spec.testMeta;
  const samples = [];
  runSim(ctx, 30, {
    recorder: rec,
    onTick: (time) => {
      samples.push({ time, vol: volumeBetween(ctx.water, downstream[0], downstream[1]) });
    },
  });
  rec.stop();
  const t = createSuite('Scene 8 -- progressive collapse');
  t.ok(ctx.structure.brokenCount >= 3, 'at least 3 members break', `brokenCount=${ctx.structure.brokenCount}`);
  const breakTimes = rec.breaks.map((br) => br.time);
  if (breakTimes.length >= 1) {
    const firstBreak = Math.min(...breakTimes);
    const lastBreak = Math.max(...breakTimes);
    t.gt(lastBreak - firstBreak, A.scene8Spread, 'breaks spread over time, not instantaneous');
    const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x.vol, 0) / arr.length : 0);
    const pre = avg(samples.filter((s) => s.time >= firstBreak - 3 && s.time < firstBreak));
    const post = avg(samples.filter((s) => s.time >= firstBreak && s.time < firstBreak + 3));
    t.gt(post, pre, 'downstream volume grows in the 3s after the first break vs the 3s before');
  } else {
    t.ok(false, 'at least one break recorded to evaluate spread/downstream growth');
  }
  return printSuite(t);
}

function determinism() {
  // the WEAK variant is the meaningful one here: it actually breaks members, so
  // brokenCount and firstFailure.time have something to be identical about
  const t = createSuite('determinism -- scene 4 (weak) run twice from scratch');
  function run() {
    const spec = testLevel(4, { variant: 'weak' });
    const ctx = buildScene(spec);
    const rec = createRecorder();
    runSim(ctx, 15, { recorder: rec });
    rec.stop();
    const { x0, x1 } = spec.water.initial[0];
    return {
      brokenCount: ctx.structure.brokenCount,
      firstFailure: ctx.structure.firstFailure,
      upstreamVol: volumeBetween(ctx.water, x0, x1),
    };
  }
  const r1 = run();
  const r2 = run();
  t.eq(r1.brokenCount, r2.brokenCount, 'brokenCount identical across runs');
  const ft1 = r1.firstFailure ? r1.firstFailure.time : null;
  const ft2 = r2.firstFailure ? r2.firstFailure.time : null;
  t.eq(ft1, ft2, 'firstFailure time identical across runs (exact)');
  t.near(r1.upstreamVol, r2.upstreamVol, 1e-9, 'upstream volume identical across runs (1e-9)');
  return printSuite(t);
}

// Foundations must matter: an UNANCHORED heavy gravity dam should stand on
// friction alone, yet slide once the water shoves harder than mu*N. Squat and
// wide so it slides rather than overturns (a tall thin one tips first, which is
// also correct, just a different failure).
function foundations() {
  const t = createSuite('foundations -- unanchored gravity dam, weight vs sliding');
  function run(surface) {
    const wall = buildWall({
      x: 24, base: 0, height: 4, width: 2.8, mat: 'concrete',
      spacing: 1, braced: true, anchorBase: false, idPrefix: 'g',
    });
    const ctx = buildScene({
      terrain: [[0, 0], [60, 0]], anchors: [],
      testDesign: { nodes: wall.nodes, members: wall.members },
      water: { initial: [{ x0: 0, x1: 22, surface }] },
    });
    const base = ctx.structure.nodes.filter((n) => /_[LR]0$/.test(n.id));
    const x0 = base.map((n) => n.x);
    runSim(ctx, 20);
    return Math.max(...base.map((n, i) => Math.abs(n.x - x0[i])));
  }
  const dry = run(0);
  const held = run(A.foundStandDepth);
  const shoved = run(A.foundSlideDepth);
  t.lt(dry, A.foundStandMax, 'no water: dam does not drift');
  t.lt(held, A.foundStandMax, `stands unanchored under ${A.foundStandDepth} m of water`);
  t.gt(shoved, A.foundSlideMin, `slides when pushed by ${A.foundSlideDepth} m of water`);
  t.gt(shoved, held * 100, 'sliding is decisively worse than standing');
  return printSuite(t);
}

// Cables are tension-only: they hold a hanging load, and carry nothing at all
// once slack (no compression resistance, they collapse freely).
function cables() {
  const t = createSuite('cables -- tension only');
  const ctx = buildScene({
    terrain: [[0, 6], [9, 6], [11, 0], [60, 0]],
    anchors: [[8, 6]],
    testDesign: {
      nodes: [
        { id: 'top', x: 8, y: 6, anchorId: 'a0' },
        { id: 'load', x: 13, y: 3, anchorId: null },
      ],
      members: [{ id: 'c0', a: 'top', b: 'load', mat: 'cable' }],
    },
    water: {},
  });
  const cable = memberById(ctx.structure, 'c0');
  const load = ctx.structure.nodes.find((n) => n.id === 'load');
  const rest = cable.restLength;
  // Sample invariants every tick: a swinging tie-back passes through taut and
  // slack phases, and the contract must hold in both, whatever the phase.
  let maxTension = 0, maxSlackLoad = 0, minLen = Infinity, maxLen = 0;
  const sample = () => {
    const len = Math.hypot(cable.b.x - cable.a.x, cable.b.y - cable.a.y);
    minLen = Math.min(minLen, len);
    maxLen = Math.max(maxLen, len);
    if (cable.strain > 0) maxTension = Math.max(maxTension, cable.load);
    else maxSlackLoad = Math.max(maxSlackLoad, cable.load);
  };
  runSim(ctx, 6, { onTick: sample });
  t.gt(maxTension, 0, 'cable carries load while taut');
  t.eq(maxSlackLoad, 0, 'cable reports exactly zero load whenever slack');
  t.lt(minLen, rest * A.cableSlackFrac, 'cable goes genuinely slack (collapses freely)');
  t.lt(maxLen, rest * (1 + cable.mat.tensionLimit * A.cableStretchTol), 'taut cable restrains the load');
  t.gt(load.y, A.cableHangMinY, 'load stays suspended, not dumped on the ground');
  t.ok(!cable.broken, 'cable survives the hanging load');

  // Direct check that a cable cannot push: put its two nodes far closer than the
  // rest length and confirm the solver never drives them apart. A rigid member
  // in the same situation would shove them straight back out.
  const squash = buildScene({
    terrain: [[0, 0], [20, 0]], anchors: [],
    testDesign: {
      nodes: [{ id: 'p', x: 8, y: 6, anchorId: null }, { id: 'q', x: 14, y: 6, anchorId: null }],
      members: [
        { id: 'cab', a: 'p', b: 'q', mat: 'cable' },
        { id: 'rod', a: 'p', b: 'q', mat: 'steel' },
      ],
    },
    water: {},
  });
  for (const id of ['cab', 'rod']) {
    const m = memberById(squash.structure, id);
    const other = memberById(squash.structure, id === 'cab' ? 'rod' : 'cab');
    other.broken = true;                    // exercise one member at a time
    m.broken = false;
    m.a.x = 10; m.a.px = 10; m.b.x = 12; m.b.py = 6; m.b.px = 12;
    m.a.y = 6; m.a.py = 6; m.b.y = 6;
    runSim(squash, 0.2);
    const gap = Math.abs(m.b.x - m.a.x);
    if (id === 'cab') t.lt(gap, 2 + A.cableSquashTol, 'squashed cable does not push its nodes apart');
    else t.gt(gap, 2 + A.cableSquashTol, 'a rigid member in the same state does push back (control)');
    t.eq(m.load, id === 'cab' ? 0 : m.load, `${id} load reporting consistent with its sign rule`);
  }
  return printSuite(t);
}

// Broken members must become debris the water can carry off.
function debris() {
  const t = createSuite('debris -- broken members become pieces the water carries');
  const spec = testLevel(8);
  const ctx = buildScene(spec);
  const damX = spec.testMeta.damX;
  runSim(ctx, 25);
  const st = ctx.structure;
  t.gt(st.debris.length, 0, 'debris spawned');
  t.eq(st.debris.length, Math.min(st.brokenCount, CONFIG.physics.maxDebris), 'one piece per broken member');
  let maxX = -Infinity;
  let moved = 0;
  for (const d of st.debris) {
    maxX = Math.max(maxX, d.a.x, d.b.x);
    if (Math.hypot(d.a.x - d.b.x, d.a.y - d.b.y) > 0) moved++;
  }
  t.eq(moved, st.debris.length, 'every piece kept its length (own verlet nodes solve)');
  t.gt(maxX, damX, 'at least one piece was washed downstream of the dam');
  for (const d of st.debris) {
    t.ok(Number.isFinite(d.a.x) && Number.isFinite(d.a.y), `piece ${d.id} stayed finite`);
  }
  return printSuite(t);
}

// The game happily releases the water with nothing built, and levels get retried
// mid-collapse. Neither may produce NaN or lose water.
function robustness() {
  const t = createSuite('robustness -- empty design, real levels, mass conservation');
  for (const spec of LEVELS) {
    const ctx = buildScene({ ...spec, testDesign: { nodes: [], members: [] } });
    const v0 = totalVolume(ctx.water);
    const inBefore = ctx.water.stats.totalIn;
    runSim(ctx, 8);
    const added = ctx.water.stats.totalIn - inBefore;
    const v1 = totalVolume(ctx.water);
    const finite = ctx.water.depth.every((d) => Number.isFinite(d) && d >= 0);
    t.ok(finite, `${spec.id}: every water cell stayed finite and non-negative`);
    t.near(v1, v0 + added, Math.max(1e-4, (v0 + added) * 1e-5), `${spec.id}: water is conserved`);
    t.eq(ctx.structure.brokenCount, 0, `${spec.id}: empty structure breaks nothing`);
  }
  return printSuite(t);
}

// Real-scale budget check: ~150 m of terrain at cellW 0.4 and a 200+ member dam.
function performance() {
  // three stacked bays of dense truss = 200+ members, on a 150 m level at
  // cellW 0.4 (~375 water cells): the worst case the game is meant to carry.
  const nodes = [];
  const members = [];
  const anchors = [];
  for (let k = 0; k < 3; k++) {
    const w = buildWall({
      x: 68 + k * 2.5, base: 0, height: 12, width: 2.5, mat: 'concrete',
      spacing: 0.6, braced: true, idPrefix: 'p' + k, anchorIdOffset: anchors.length,
    });
    nodes.push(...w.nodes);
    members.push(...w.members);
    anchors.push(...w.anchorPoints);
  }
  const spec = {
    terrain: [[0, 0], [150, 0]], anchors,
    testDesign: { nodes, members },
    water: { initial: [{ x0: 0, x1: 66, surface: 10 }], flood: { x: 4, rate: 4, duration: 60, delay: 0 } },
  };
  const dt = CONFIG.physics.dt;
  for (const label of ['scene 4 (strong)', 'full scale']) {
    const ctx = label === 'full scale' ? buildScene(spec) : buildScene(testLevel(4, { variant: 'strong' }));
    const steps = Math.round(10 / dt);
    const start = process.hrtime.bigint();
    runSim(ctx, 10);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const budget = (1000 / 60).toFixed(2);
    console.log(`  ${label}: ${ctx.water.n} cells, ${ctx.structure.members.length} members,`
      + ` ${ctx.structure.nodes.length} nodes -> ${(ms / steps).toFixed(4)} ms/tick`
      + ` (${((ms / steps) / (1000 / 60) * 100).toFixed(1)}% of the ${budget}ms frame budget)`);
  }
}

const runners = { 1: scene1, 2: scene2, 3: scene3, 4: scene4, 5: scene5, 6: scene6, 7: scene7, 8: scene8 };

const argvFilter = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
const only = argvFilter.length ? new Set(argvFilter) : null;

const wallStart = Date.now();
let scenesRun = 0;
let scenesPassed = 0;

for (let i = 1; i <= SCENE_COUNT; i++) {
  if (only && !only.has(i)) continue;
  console.log(`\n=== SCENE ${i} ===`);
  scenesRun++;
  let pass = false;
  try {
    pass = runners[i]();
  } catch (err) {
    console.log(`  FAIL (threw) -- ${err && err.stack ? err.stack : err}`);
    pass = false;
  }
  console.log(`SCENE ${i}: ${pass ? 'PASS' : 'FAIL'}`);
  if (pass) scenesPassed++;
}

const extras = [
  ['ROBUSTNESS', robustness],
  ['FOUNDATIONS', foundations],
  ['CABLES', cables],
  ['DEBRIS', debris],
];
let extrasFailed = 0;
if (!only) {
  for (const [label, fn] of extras) {
    console.log(`\n=== ${label} ===`);
    let pass = false;
    try {
      pass = fn();
    } catch (err) {
      console.log(`  FAIL (threw) -- ${err && err.stack ? err.stack : err}`);
    }
    console.log(`${label}: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) extrasFailed++;
  }
}

console.log('\n=== DETERMINISM ===');
let determinismPass = false;
try {
  determinismPass = determinism();
} catch (err) {
  console.log(`  FAIL (threw) -- ${err && err.stack ? err.stack : err}`);
}
console.log(`DETERMINISM: ${determinismPass ? 'PASS' : 'FAIL'}`);

console.log('\n=== PERFORMANCE ===');
try {
  performance();
} catch (err) {
  console.log(`  performance check threw -- ${err && err.stack ? err.stack : err}`);
}

const wallMs = Date.now() - wallStart;
const failures = (scenesRun - scenesPassed) + (determinismPass ? 0 : 1) + extrasFailed;
console.log(`\n${scenesPassed}/${scenesRun} scenes passed, ${extras.length - extrasFailed}/${only ? 0 : extras.length} extra checks passed,`
  + ` determinism ${determinismPass ? 'PASS' : 'FAIL'}, wall time ${wallMs}ms`);
process.exit(failures ? 1 : 0);
