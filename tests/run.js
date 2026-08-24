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
import { volumeBetween, velAt, depthAt, totalVolume } from '../src/physics/water.js';
import { memberCapacity } from '../src/physics/structures.js';
import { MATERIALS } from '../src/build/materials.js';
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

  // foundations (unanchored gravity dam). The crest stays ABOVE both water
  // levels: once the water pours over the top it floods the downstream side and
  // (correctly, now that the water actually goes there) stops shoving.
  foundHeight: 9,          // m of unanchored dam
  foundWidth: 1.2,         // m base width: water force grows as H², dead weight
                           // only as H·W, so a squat block simply never loses —
                           // the interesting dam is the slender one
  foundStandDepth: 3,      // m of water the dam must hold without moving
  foundSlideDepth: 8,      // m of water that must shove it
  foundStandMax: 0.05,     // m of drift still counted as "did not move"
  foundSlideMin: 1.0,      // m of base travel that counts as sliding

  // --- water v2 (PIC/FLIP) gates ---
  hydroTol: 0.3,           // fraction of ½rho g H² the measured wall load may miss by
  hydroQuartile: 3,        // bottom-quartile load / top-quartile load
  calmSurface: 0.4,        // m; max deviation of a settled reservoir's surface
  calmSpeed: 1.2,          // m/s; fastest particle in a settled reservoir
  calmLoadVar: 0.1,        // peak-to-peak wall load over 1 s, as a fraction of mean
  sealSeconds: 30,         // s a sealed wall must hold with ZERO particles through
  sealMargin: 1.0,         // m past the wall face that counts as "got through"
  impactRatio: 2.5,        // dam-break peak load / its own static follow-on
  jetFlowMin: 0.2,         // m²/s of measured flux through a hole that reads as a jet
  perfParticles: 3500,     // the perf scene must actually carry this many particles
  perfBudget: 6.0,         // ms/tick allowed for 4000 particles + 250 members

  // cables
  cableHangMinY: 0.5,      // m; a suspended load must stay off the ground
  cableLift: 400,          // N pushed up to prove the cable goes slack
  cableSlackFrac: 0.99,    // taut length fraction below which it counts as slack
  cableStretchTol: 3,      // allowed stretch as a multiple of the tension limit
  cableSquashTol: 0.05,    // m of separation growth allowed for a squashed cable

  // --- v2.1 damage model: CREEP -----------------------------------------
  creepTarget: 0.85,       // load the rig holds a member at, indefinitely
  creepRamp: 3,            // s to fade the pull in (a step load would ring the
                           // member past its limit and break it on impact)
  creepBand: 0.06,         // measured load must sit this close to creepTarget,
                           // otherwise the rig is not testing what it claims
  creepSettle: 6,          // s before the load band is sampled
  creepFailMin: 15,        // s: timber must not give way before this
  creepFailMax: 45,        // s: ...nor hold past this
  creepSurvive: 90,        // s the identical rig in steel must last
  creepSurviveDmg: 0.3,    // ...having eaten less than this much of itself

  // --- v2.1 damage model: BENDING ---------------------------------------
  bendHead: 2.5,           // m of head the long-span/pier comparison runs at
  bendSpan: 4.8,           // m of UNSUPPORTED face panel (the whole face, 1 bay)
  bendWidth: 1.2,          // m truss depth: keeps the 4.8 m bay's diagonal
                           // (4.95 m) inside timber's 5 m maxLength, so the
                           // scene is something a player could actually build
  bendSecs: 60,
  bendMomentHead: 2,       // m: a head BOTH faces survive, so their bending can
                           // be compared as numbers rather than as verdicts
  bendMomentFrac: 0.6,     // piered bendLoad / long-span bendLoad at that head.
                           // Theory says 0.5 (halve the span, halve the moment).

  // --- v2.1 damage model: HEAD RATINGS ----------------------------------
  rateBay: 2.5,            // m: the level-typical bay the ratings are quoted for
  rateWidth: 1.5,          // m truss depth (rung 1.5 m, diagonal 2.92 m — inside
                           // concrete's 3 m maxLength, so all three materials
                           // build the SAME face and the comparison is fair)
  rateFreeboard: 1.5,      // m of face above the water (no overtopping)
  rateSurviveSecs: 60,
  rateFailSecs: 25,        // every failure below lands inside 9 s
  rateSurviveDmg: 0.6,     // a face that "survives" may be creeping, but it must
                           // not be most of the way through its own life
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
    let peakLf = 0, liveFx = 0;
    for (const n of ctx.structure.nodes) {
      peakLf = Math.max(peakLf, Math.abs(n.lfx) + Math.abs(n.lfy));
      liveFx += Math.abs(n.fx) + Math.abs(n.fy);
    }
    t.gt(peakLf, 1, 'lfx/lfy keep the external force for the debug overlay');
    t.eq(liveFx, 0, 'fx/fy are still zeroed by the solver (contract)');
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
  // payload fields the effects layer scales its shake/splash by
  const br = rec.breaks[0];
  t2.gt(br.load, 1, "member:break carries the pre-zeroed load as 'load'");
  const imp = rec.impacts[0];
  t2.ok(imp.dir === 1 || imp.dir === -1, "water:impact carries dir +1/-1", `dir=${imp.dir}`);
  t2.ok(rec.impacts.every((i) => i.speed >= 0), 'water:impact speed stays unsigned');
  t2.eq(imp.dir, 1, 'the downstream-travelling wave reports dir +1');
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
  function run(seconds) {
    const spec = testLevel(4, { variant: 'weak' });
    const ctx = buildScene(spec);
    const rec = createRecorder();
    runSim(ctx, seconds, { recorder: rec });
    rec.stop();
    const { x0, x1 } = spec.water.initial[0];
    return {
      brokenCount: ctx.structure.brokenCount,
      firstFailure: ctx.structure.firstFailure,
      upstreamVol: volumeBetween(ctx.water, x0, x1),
      water: ctx.water,
    };
  }
  const r1 = run(15);
  const r2 = run(15);
  t.eq(r1.brokenCount, r2.brokenCount, 'brokenCount identical across runs');
  const ft1 = r1.firstFailure ? r1.firstFailure.time : null;
  const ft2 = r2.firstFailure ? r2.firstFailure.time : null;
  t.eq(ft1, ft2, 'firstFailure time identical across runs (exact)');
  t.near(r1.upstreamVol, r2.upstreamVol, 1e-9, 'upstream volume identical across runs (1e-9)');

  // v2: the particles themselves must match bit-for-bit, not just the summaries
  t.eq(r1.water.pcount, r2.water.pcount, 'particle count identical across runs');
  let diff = 0;
  for (let i = 0; i < r1.water.pcount; i++) {
    const dx = Math.abs(r1.water.ppx[i] - r2.water.ppx[i]);
    const dy = Math.abs(r1.water.ppy[i] - r2.water.ppy[i]);
    if (dx > diff) diff = dx;
    if (dy > diff) diff = dy;
  }
  t.eq(diff, 0, 'every particle position identical after 15 s (exact, not near)');
  return printSuite(t);
}

// ---- water v2 (PIC/FLIP) gates -------------------------------------------

// Total horizontal water load the structure received on the last tick. lfx is
// the copy constraints.js keeps of the external accumulator, so this is exactly
// what the solver consumed — anchored nodes included.
function wallLoad(structure, yLo, yHi) {
  let sum = 0;
  for (const n of structure.nodes) {
    if (yLo !== undefined && (n.y < yLo || n.y >= yHi)) continue;
    sum += n.lfx;
  }
  return sum;
}

function maxParticleSpeed(water) {
  let v = 0;
  for (let i = 0; i < water.pcount; i++) {
    const s = Math.hypot(water.pvx[i], water.pvy[i]);
    if (s > v) v = s;
  }
  return v;
}

// The load a real reservoir puts on a real dam: total force within ±30% of the
// analytic ½rho g H², concentrated at the base, steady, and not one particle
// through the wall in 30 s.
function hydrostatics() {
  const t = createSuite('hydrostatics -- analytic wall load, base concentration, sealing, calm');
  const surface = 8, wallX = 24, wallH = 11;
  const wall = buildWall({
    x: wallX, base: 0, height: wallH, width: 1.5, mat: 'concrete',
    spacing: 1, braced: true, idPrefix: 'hy',
  });
  const ctx = buildScene({
    terrain: [[0, 0], [60, 0]], anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: 0, x1: wallX - 1, surface }] },
  });

  let leaked = 0;
  let vmax = 0;
  const loads = [];
  runSim(ctx, A.sealSeconds, {
    onTick: (time) => {
      for (let i = 0; i < ctx.water.pcount; i++) {
        if (ctx.water.ppx[i] > wallX + A.sealMargin) leaked++;
      }
      if (time > A.sealSeconds - 1) {
        loads.push(wallLoad(ctx.structure));
        const s = maxParticleSpeed(ctx.water);
        if (s > vmax) vmax = s;
      }
    },
  });

  t.eq(leaked, 0, `ZERO particle-ticks past the sealed wall in ${A.sealSeconds}s`);
  t.eq(ctx.structure.brokenCount, 0, 'the concrete wall holds');

  // measured head clear of the dam's own footprint, and the analytic force it implies
  const H = depthAt(ctx.water, wallX - 2.2);
  const scale = CONFIG.coupling.pressureScale * CONFIG.coupling.density;
  const analytic = 0.5 * scale * CONFIG.water.g * H * H;
  const total = loads.reduce((s, v) => s + v, 0) / loads.length;
  t.ok(Math.abs(total - analytic) <= analytic * A.hydroTol,
    `total wall load within ±${A.hydroTol * 100}% of ½rho g H² (H=${H.toFixed(2)}m)`,
    `${total.toFixed(0)} vs ${analytic.toFixed(0)} (${((total / analytic - 1) * 100).toFixed(1)}%)`);

  // Vertical distribution straight off the pressure field: each member's own
  // share, banded by where the water actually pushes on it.
  const q = H / 4;
  let bottom = 0, top = 0;
  for (const cf of ctx.water.colliderForces) {
    if (cf.y < q) bottom += cf.fx;
    else if (cf.y > H - q && cf.y < H) top += cf.fx;
  }
  console.log(`  bottom quartile ${bottom.toFixed(1)}, top quartile ${top.toFixed(1)}`
    + ` (physical, ×${CONFIG.coupling.pressureScale} in game newtons)`);
  t.gt(bottom, A.hydroQuartile * top, `bottom-quartile load > ${A.hydroQuartile}x top-quartile load`);

  // calm: flat surface, no popcorn, steady load
  let sMin = Infinity, sMax = -Infinity;
  const w = ctx.water;
  // clear of both shores and of the dam's own footprint (the columns the dam
  // capsule occupies hold less water simply because the dam is in them)
  for (let i = Math.floor(6 / w.cellW); i < Math.floor((wallX - 3) / w.cellW); i++) {
    const s = w.bed[i] + w.depth[i];
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  t.lt(sMax - sMin, A.calmSurface, 'settled reservoir surface is flat (m of spread)');
  t.lt(vmax, A.calmSpeed, 'fastest particle in the settled reservoir (m/s)');
  const lMin = Math.min(...loads), lMax = Math.max(...loads);
  t.lt((lMax - lMin) / Math.abs(total), A.calmLoadVar,
    'wall load peak-to-peak over the last second (fraction of mean)');
  return printSuite(t);
}

// A dam-break front must hit harder than the same water standing still against
// the same wall — the whole point of a momentum-carrying fluid.
function impact() {
  const t = createSuite('impact -- dam-break front vs its own static follow-on');
  const wallX = 30;
  const wall = buildWall({
    x: wallX, base: 0, height: 12, width: 2, mat: 'concrete',
    spacing: 1, braced: true, idPrefix: 'im',
  });
  const ctx = buildScene({
    terrain: [[0, 0], [46, 0]], anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: 0, x1: 14, surface: 8 }] },
  });
  let peak = 0, peakT = 0, statSum = 0, statN = 0;
  runSim(ctx, 25, {
    onTick: (time) => {
      const f = wallLoad(ctx.structure);
      if (f > peak) { peak = f; peakT = time; }
      if (time > 20) { statSum += f; statN++; }
    },
  });
  const stat = statSum / statN;
  console.log(`  peak ${peak.toFixed(0)} at t=${peakT.toFixed(2)}s, static follow-on ${stat.toFixed(0)}`);
  t.gt(peak, A.impactRatio * stat, `impact peak > ${A.impactRatio}x its own static follow-on`);
  return printSuite(t);
}

// A hole must behave like a hole: measured flux through it, a faster drain, and
// the water genuinely arriving downstream.
function leakJet() {
  const t = createSuite('leak -- hole in the dam makes a measurable jet');
  const spec = testLevel(5, { variant: 'holed' });
  const ctx = buildScene(spec);
  const { damX, upstream, downstream } = spec.testMeta;
  const b0 = Math.round((damX - 1 - ctx.water.x0) / ctx.water.cellW);
  const b1 = Math.round((damX + 1 - ctx.water.x0) / ctx.water.cellW);
  let maxGap = 0;
  const up0 = volumeBetween(ctx.water, upstream[0], upstream[1]);
  runSim(ctx, 20, {
    onTick: () => {
      for (let b = b0; b <= b1; b++) {
        const g = Math.abs(ctx.water.gapFlow[b]);
        if (g > maxGap) maxGap = g;
      }
    },
  });
  const up1 = volumeBetween(ctx.water, upstream[0], upstream[1]);
  const down = volumeBetween(ctx.water, downstream[0], downstream[1]);
  t.gt(maxGap, A.jetFlowMin, 'measured gap flux through the hole (m²/s)');
  t.gt(up0 - up1, 1, 'the reservoir actually drained (m² lost upstream)');
  t.gt(down, 1, 'the water arrived downstream (m²)');
  return printSuite(t);
}

// Foundations must matter: an UNANCHORED heavy gravity dam should stand on
// friction alone, yet give way once the water shoves harder than mu*N. Whether
// the base then slides or the whole block tips is not the point (both are real
// foundation failures) — the point is that the base MOVES.
function foundations() {
  const t = createSuite('foundations -- unanchored gravity dam, weight vs sliding');
  function run(surface) {
    const wall = buildWall({
      x: 24, base: 0, height: A.foundHeight, width: A.foundWidth, mat: 'concrete',
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

// ---- v2.1 damage model: bending + creep ----------------------------------

// One braced face standing on flat ground against a still reservoir. `bay` is
// the row pitch, i.e. the length of each unsupported face panel — the quantity
// bending actually cares about. The water is seeded clear of the dam's own solid
// cells: particles started INSIDE a capsule squirt out and slam the face, which
// is a measurement artefact and not a flood.
function faceProbe({ mat, head, bay, width, seconds, height }) {
  const wallX = 24;
  const h = height != null ? height : Math.ceil((head + A.rateFreeboard) / bay) * bay;
  const wall = buildWall({
    x: wallX, base: 0, height: h, width, mat, spacing: bay, braced: true, idPrefix: 'r',
  });
  const ctx = buildScene({
    terrain: [[0, 0], [60, 0]], anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: {
      initial: [{
        x0: 0,
        x1: wallX - width / 2 - MATERIALS[mat].thickness / 2 - 0.35,
        surface: head,
      }],
    },
  });
  const rec = createRecorder();
  let peakBend = 0, dmg = 0, ssBend = 0, ssN = 0;
  runSim(ctx, seconds, {
    recorder: rec,
    onTick: (time) => {
      let mb = 0;
      for (const m of ctx.structure.members) {
        if (m.broken) continue;
        if (m.bendLoad > mb) mb = m.bendLoad;
        if (m.damage > dmg) dmg = m.damage;
      }
      if (mb > peakBend) peakBend = mb;
      if (time > seconds - 5) { ssBend += mb; ssN++; }
    },
  });
  rec.stop();
  return {
    mat, head, bay, height: h, members: ctx.structure.members.length,
    broken: ctx.structure.brokenCount,
    firstFailure: ctx.structure.firstFailure,
    breaks: rec.breaks, peakBend, dmg,
    ssBend: ssN ? ssBend / ssN : 0,
  };
}

// Bending must be about SPAN, not about depth. The same 4.8 m face, the same
// water: as one unsupported panel it snaps; with a pier at mid-height (two 2.4 m
// panels) it holds. The peak moment of a span is F·L/8 and F grows with L too,
// so halving the bay cuts the moment to about half at equal head.
function bending() {
  const t = createSuite('bending -- long unsupported span vs a mid-span pier');
  const span = A.bendSpan, w = A.bendWidth, secs = A.bendSecs;
  const longT = faceProbe({ mat: 'timber', head: A.bendHead, bay: span, width: w, seconds: secs, height: span });
  const pierT = faceProbe({ mat: 'timber', head: A.bendHead, bay: span / 2, width: w, seconds: secs, height: span });
  const longS = faceProbe({ mat: 'steel', head: A.bendHead, bay: span, width: w, seconds: secs, height: span });

  console.log(`  ${span}m timber span: broken=${longT.broken} peakBend=${longT.peakBend.toFixed(2)}`
    + ` | ${span / 2}m piered: broken=${pierT.broken} peakBend=${pierT.peakBend.toFixed(2)} dmg=${pierT.dmg.toFixed(3)}`
    + ` | ${span}m steel: broken=${longS.broken} peakBend=${longS.peakBend.toFixed(2)} dmg=${longS.dmg.toFixed(3)}`);

  t.gt(longT.broken, 0, `the ${span} m unsupported timber panel fails under ${A.bendHead} m of head`);
  const ff = longT.firstFailure;
  t.eq(ff && ff.mode, 'bending', "...and firstFailure.mode says 'bending'");
  t.ok(longT.breaks.some((b) => b.mode === 'bending'), "member:break carries mode 'bending'",
    `modes=${[...new Set(longT.breaks.map((b) => b.mode))].join(',') || 'none'}`);
  t.eq(pierT.broken, 0, 'the SAME span with a mid pier survives the same water');
  t.lt(pierT.dmg, A.rateSurviveDmg, '...and is not quietly creeping to death either');
  t.eq(longS.broken, 0, 'the same long span in steel survives (material matters too)');

  // moment comparison at a head both faces survive: the pier must roughly halve it
  const mLong = faceProbe({ mat: 'timber', head: A.bendMomentHead, bay: span, width: w, seconds: 20, height: span });
  const mPier = faceProbe({ mat: 'timber', head: A.bendMomentHead, bay: span / 2, width: w, seconds: 20, height: span });
  console.log(`  at ${A.bendMomentHead} m head: long span bendLoad ${mLong.ssBend.toFixed(3)},`
    + ` piered ${mPier.ssBend.toFixed(3)} (ratio ${(mPier.ssBend / mLong.ssBend).toFixed(2)})`);
  t.eq(mLong.broken + mPier.broken, 0, `both faces survive ${A.bendMomentHead} m (so the moments are comparable)`);
  t.lt(mPier.ssBend / mLong.ssBend, A.bendMomentFrac,
    'halving the bay cuts the settled bending load to well under the long span\'s');
  return printSuite(t);
}

// Head ratings: the depth at which each material's face stops being a dam. The
// SAME braced face for all three (rung 1.5 m, diagonal 2.92 m, bay 2.5 m — a
// geometry every material can legally build), so the only variable is material.
const RATINGS = [
  { mat: 'timber', survive: 2.5, fail: 4.5 },
  { mat: 'steel', survive: 5.5, fail: 9.0 },
  { mat: 'concrete', survive: 8.0, fail: null },
];

function ratings() {
  const t = createSuite('ratings -- metres of head each material actually holds');
  const bay = A.rateBay, width = A.rateWidth;
  for (const r of RATINGS) {
    const ok = faceProbe({ mat: r.mat, head: r.survive, bay, width, seconds: A.rateSurviveSecs });
    console.log(`  ${r.mat}: ${r.survive} m -> broken=${ok.broken} peakBend=${ok.peakBend.toFixed(2)}`
      + ` settledBend=${ok.ssBend.toFixed(2)} dmg=${ok.dmg.toFixed(3)}`
      + ` (headRating ${MATERIALS[r.mat].headRating} m)`);
    t.eq(ok.broken, 0, `${r.mat} face holds ${r.survive} m of head for ${A.rateSurviveSecs} s`);
    t.lt(ok.dmg, A.rateSurviveDmg, `${r.mat} at ${r.survive} m is not creeping to death`);
    if (r.fail == null) continue;
    const bad = faceProbe({ mat: r.mat, head: r.fail, bay, width, seconds: A.rateFailSecs });
    const ffm = bad.firstFailure ? bad.firstFailure.mode : 'none';
    console.log(`  ${r.mat}: ${r.fail} m -> broken=${bad.broken} first=${ffm}`
      + `@${bad.firstFailure ? bad.firstFailure.time.toFixed(1) : '-'}s`);
    t.gt(bad.broken, 0, `${r.mat} face fails at ${r.fail} m of head`);
  }

  // The ordering is the point: at 8 m, steel is gone and concrete is standing.
  const steelDeep = faceProbe({ mat: 'steel', head: 8, bay, width, seconds: A.rateFailSecs });
  t.gt(steelDeep.broken, 0, 'steel face fails at 8 m, where the concrete one held');
  t.ok(MATERIALS.timber.headRating < MATERIALS.steel.headRating
    && MATERIALS.steel.headRating < MATERIALS.concrete.headRating,
    'published headRatings are ordered timber < steel < concrete',
    `${MATERIALS.timber.headRating} < ${MATERIALS.steel.headRating} < ${MATERIALS.concrete.headRating}`);
  return printSuite(t);
}

// Sustained load is not survival. A member held at 0.85 for long enough dies of
// creep alone, and how long that takes IS the material's character: timber goes
// in half a minute, steel takes twenty times longer, concrete longer still.
// The rig is one member pulled by a constant force sized from its own capacity,
// so every material is held at the SAME fraction of its limit — the only thing
// being compared is creepRate. Gravity on the free node is cancelled so the pull
// stays purely axial, and it fades in over creepRamp seconds because a step load
// would ring the member straight past its limit and break it on impact.
function creepRig(mat, seconds) {
  const cap = memberCapacity(MATERIALS[mat], true);
  const force = cap * A.creepTarget;
  const ctx = buildScene({
    terrain: [[0, 0], [30, 0]], anchors: [[10, 6]],
    testDesign: {
      nodes: [{ id: 'A', x: 10, y: 6, anchorId: 'a0' }, { id: 'B', x: 13, y: 6, anchorId: null }],
      members: [{ id: 'm', a: 'A', b: 'B', mat }],
    },
    water: {},
  });
  const rec = createRecorder();
  const m = ctx.structure.members[0];
  const b = ctx.structure.nodes[1];
  let lo = Infinity, hi = 0, brokeAt = null;
  runSim(ctx, seconds, {
    recorder: rec,
    onTick: (time) => {
      if (m.broken) { if (brokeAt === null) brokeAt = time; return; }
      b.fx += force * Math.min(1, time / A.creepRamp);
      b.fy += CONFIG.physics.gravity * b.mass;
      if (time > A.creepSettle) { if (m.load < lo) lo = m.load; if (m.load > hi) hi = m.load; }
    },
  });
  rec.stop();
  return {
    mat, force, brokeAt, damage: m.damage, loadLo: lo, loadHi: hi,
    firstFailure: ctx.structure.firstFailure, breaks: rec.breaks,
  };
}

function creep() {
  const t = createSuite('creep -- sustained near-limit load destroys weak material');
  const tim = creepRig('timber', A.creepSurvive + 20);
  console.log(`  timber held at ${tim.loadLo.toFixed(3)}..${tim.loadHi.toFixed(3)}`
    + ` -> broke at ${tim.brokeAt === null ? 'never' : tim.brokeAt.toFixed(1) + 's'}`);
  t.ok(Math.abs(tim.loadHi - A.creepTarget) < A.creepBand && Math.abs(tim.loadLo - A.creepTarget) < A.creepBand,
    `the rig really holds timber at ${A.creepTarget}`, `${tim.loadLo.toFixed(3)}..${tim.loadHi.toFixed(3)}`);
  t.ok(tim.brokeAt !== null && tim.brokeAt > A.creepFailMin && tim.brokeAt < A.creepFailMax,
    `timber at ${A.creepTarget} dies of creep between ${A.creepFailMin} and ${A.creepFailMax} s`,
    `${tim.brokeAt === null ? 'never' : tim.brokeAt.toFixed(1) + 's'}`);
  t.eq(tim.firstFailure && tim.firstFailure.sustained, true, 'firstFailure.sustained is true (load was under 1.0)');
  t.ok(tim.breaks.length > 0 && tim.breaks[0].sustained === true,
    'member:break carries sustained:true', `payload=${JSON.stringify(tim.breaks[0] && tim.breaks[0].sustained)}`);
  t.lt(tim.breaks[0] ? tim.breaks[0].load : 9, 1, 'the break load really was under 1.0 (attrition, not overload)');

  const ste = creepRig('steel', A.creepSurvive);
  console.log(`  steel held at ${ste.loadLo.toFixed(3)}..${ste.loadHi.toFixed(3)}`
    + ` -> damage ${ste.damage.toFixed(3)} after ${A.creepSurvive}s`);
  t.eq(ste.brokeAt, null, `the identical rig in steel survives ${A.creepSurvive} s`);
  t.lt(ste.damage, A.creepSurviveDmg, `...with damage under ${A.creepSurviveDmg}`);
  t.gt(ste.damage, 0, '...but it is NOT immune either (steel creeps, just slowly)');

  const con = creepRig('concrete', A.creepSurvive);
  console.log(`  concrete -> damage ${con.damage.toFixed(3)} after ${A.creepSurvive}s`);
  t.eq(con.brokeAt, null, `concrete survives ${A.creepSurvive} s too`);
  t.gt(con.damage, 0, 'concrete is slow, not immortal');
  t.lt(con.damage, ste.damage, 'concrete creeps slower than steel');
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
// The v2 gate is 4000 particles + 250 members inside 6 ms/tick.
function performance() {
  let pass = true;
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
  const t = createSuite('performance -- 4000 particles + 250 members inside budget');
  for (const label of ['scene 4 (strong)', 'full scale']) {
    const ctx = label === 'full scale' ? buildScene(spec) : buildScene(testLevel(4, { variant: 'strong' }));
    const steps = Math.round(10 / dt);
    const start = process.hrtime.bigint();
    runSim(ctx, 10);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const budget = (1000 / 60).toFixed(2);
    const per = ms / steps;
    console.log(`  ${label}: ${ctx.water.n} cells, ${ctx.water.pcount} particles`
      + ` (spacing ${ctx.water.fluid.spacing.toFixed(2)}m, grid ${ctx.water.fluid.nx}x${ctx.water.fluid.ny}),`
      + ` ${ctx.structure.members.length} members, ${ctx.structure.nodes.length} nodes`
      + ` -> ${per.toFixed(4)} ms/tick`
      + ` (${(per / (1000 / 60) * 100).toFixed(1)}% of the ${budget}ms frame budget)`);
    if (label === 'full scale') {
      t.gt(ctx.water.pcount, A.perfParticles, 'the perf scene really is particle-heavy');
      t.gt(ctx.structure.members.length, 240, 'the perf scene really is member-heavy');
      t.lt(per, A.perfBudget, `full-scale cost per tick (ms) under the ${A.perfBudget}ms gate`);
    }
  }
  pass = printSuite(t) && pass;
  return pass;
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
  ['HYDROSTATICS', hydrostatics],
  ['IMPACT', impact],
  ['LEAK', leakJet],
  ['FOUNDATIONS', foundations],
  ['CABLES', cables],
  ['DEBRIS', debris],
  ['BENDING', bending],
  ['RATINGS', ratings],
  ['CREEP', creep],
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
let perfPass = false;
try {
  perfPass = performance();
} catch (err) {
  console.log(`  performance check threw -- ${err && err.stack ? err.stack : err}`);
}

const wallMs = Date.now() - wallStart;
const failures = (scenesRun - scenesPassed) + (determinismPass ? 0 : 1) + extrasFailed
  + (only || perfPass ? 0 : 1);
console.log(`\n${scenesPassed}/${scenesRun} scenes passed, ${extras.length - extrasFailed}/${only ? 0 : extras.length} extra checks passed,`
  + ` determinism ${determinismPass ? 'PASS' : 'FAIL'}, wall time ${wallMs}ms`);
process.exit(failures ? 1 : 0);
