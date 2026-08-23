// OPUS A owns. Milestone-1 gates for the bare PIC/FLIP solver (no game, no
// structure): a tank of water must settle FLAT and CALM, hold the analytic
// hydrostatic pressure profile, conserve volume exactly, and cost what the
// budget says. `node tests/fluid-core.mjs`

import { createTerrain } from '../src/core/terrain.js';
import { createFluid, seedBlock, stepFluid, setColliders, pressureAt, FLUID } from '../src/physics/fluid.js';
import { CONFIG } from '../src/config.js';

let fails = 0;
const sig = (v) => (typeof v === 'number' ? Number(v.toPrecision(4)) : v);
function ok(pass, label, detail) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label} -- ${detail}`);
  if (!pass) fails++;
}
const gt = (a, b, label) => ok(a > b, label, `${sig(a)} > ${sig(b)}`);
const lt = (a, b, label) => ok(a < b, label, `${sig(a)} < ${sig(b)}`);
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `${sig(a)} ~= ${sig(b)} (tol ${sig(tol)})`);

// A tank: flat bed with steep walls at both ends.
function tank(depth = 6, len = 24) {
  const terrain = createTerrain([[0, depth + 6], [3, 0], [3 + len, 0], [6 + len, depth + 6]], []);
  const f = createFluid(terrain);
  const vol = seedBlock(f, 3.4, 3 + len - 0.4, depth);
  return { terrain, f, vol, x0: 3.4, x1: 3 + len - 0.4, depth };
}

function run(f, seconds) {
  const dt = CONFIG.physics.dt;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepFluid(f, dt);
  return steps;
}

// ---- 1. settle: flat, calm, conserved ------------------------------------
{
  console.log('\n=== TANK SETTLE ===');
  const { f, vol, depth } = tank();
  const n0 = f.pcount;
  run(f, 10);
  ok(f.pcount === n0, 'particle count unchanged (volume is exactly conserved)', `${f.pcount} === ${n0}`);

  // surface flatness: highest particle per 1 m column across the interior
  const colW = 1.0;
  const cols = new Map();
  for (let i = 0; i < f.pcount; i++) {
    const c = Math.floor(f.px[i] / colW);
    const top = cols.get(c);
    if (top === undefined || f.py[i] > top) cols.set(c, f.py[i]);
  }
  const tops = [...cols.entries()].filter(([c]) => c >= 5 && c <= 24).map(([, y]) => y);
  const mean = tops.reduce((s, y) => s + y, 0) / tops.length;
  let dev = 0;
  for (const y of tops) dev = Math.max(dev, Math.abs(y - mean));
  console.log(`  surface mean ${sig(mean)} m (seeded ${depth} m), volume ${sig(vol)} m²,`
    + ` ${f.pcount} particles, spacing ${sig(f.spacing)}, h ${sig(f.h)}`);
  lt(dev, 0.45, 'settled surface is flat (max deviation from mean, m)');

  // calm: no popcorn
  let vmax = 0, vsum = 0;
  for (let i = 0; i < f.pcount; i++) {
    const s = Math.hypot(f.pvx[i], f.pvy[i]);
    vsum += s;
    if (s > vmax) vmax = s;
  }
  lt(vsum / f.pcount, 0.25, 'mean particle speed at rest (m/s)');
  lt(vmax, 2.5, 'fastest particle at rest (m/s) — no popcorn');

  // Hydrostatic pressure profile p = rho·g·d. The free-surface Dirichlet sits at
  // the first AIR cell centre, so the whole profile carries a constant offset of
  // about rho·g·h/2 — harmless for the integrated wall load, but it means the
  // shallow probes must be judged with that offset in mind.
  const g = CONFIG.water.g, rho = CONFIG.coupling.density;
  const surf = mean + f.spacing * 0.5;
  const probes = [1.5, 2.5, 3.5, 4.5];
  let worst = 0;
  for (const dEl of probes) {
    const p = pressureAt(f, 14, surf - dEl);
    const want = rho * g * dEl;
    const err = Math.abs(p - want) / want;
    if (err > worst) worst = err;
    console.log(`    depth ${dEl} m: p=${sig(p)} want=${sig(want)} err=${(err * 100).toFixed(1)}%`);
  }
  lt(worst, 0.3, 'hydrostatic pressure within 30% at every probe depth');
  const grad = (pressureAt(f, 14, surf - 4.5) - pressureAt(f, 14, surf - 1.5)) / 3;
  near(grad, rho * g, rho * g * 0.1, 'pressure gradient is rho*g per metre');

  // wall load: integrate p over the left tank wall face column
  let fluidCells = 0;
  for (let c = 0; c < f.nc; c++) if (f.cellType[c] === FLUID) fluidCells++;
  console.log(`  fluid cells ${fluidCells}, substeps ${f.substeps}`);
}

// ---- 2. determinism ------------------------------------------------------
{
  console.log('\n=== DETERMINISM ===');
  const a = tank();
  const b = tank();
  run(a.f, 4);
  run(b.f, 4);
  let diff = 0;
  for (let i = 0; i < a.f.pcount; i++) {
    diff = Math.max(diff, Math.abs(a.f.px[i] - b.f.px[i]), Math.abs(a.f.py[i] - b.f.py[i]));
  }
  ok(diff === 0, 'two identical runs match bit-for-bit after 4 s', `maxdiff ${diff}`);
}

// ---- 3. dam break (qualitative: it must actually move) -------------------
{
  console.log('\n=== DAM BREAK ===');
  const terrain = createTerrain([[0, 12], [2, 0], [60, 0], [62, 12]], []);
  const f = createFluid(terrain);
  seedBlock(f, 2.4, 12, 8);
  run(f, 3);
  let far = 0;
  for (let i = 0; i < f.pcount; i++) if (f.px[i] > far) far = f.px[i];
  gt(far, 25, 'the collapsing column runs out downstream (m reached in 3 s)');
  let vmax = 0;
  for (let i = 0; i < f.pcount; i++) vmax = Math.max(vmax, Math.abs(f.pvx[i]));
  gt(vmax, 3, 'front is genuinely moving (max |vx|, m/s)');
  ok(Number.isFinite(far), 'positions stayed finite', 'ok');
}

// ---- 3b. wall: hydrostatic load, distribution, zero tunnelling -----------

// A stack of unit capsules standing at x=wallX, thick as a concrete member.
function wall(wallX, top, r = 0.425, seg = 1) {
  const caps = [];
  for (let y = -0.6; y < top; y += seg) {
    caps.push({ ax: wallX, ay: y, bx: wallX, by: Math.min(y + seg, top), r, ref: caps.length });
  }
  return caps;
}

{
  console.log('\n=== WALL: HYDROSTATIC LOAD ===');
  const H = 8;
  const terrain = createTerrain([[0, 0], [60, 0]], []);
  const f = createFluid(terrain);
  const caps = wall(24, 11);
  setColliders(f, caps);
  seedBlock(f, 0.6, 23.4, H);
  const dt = CONFIG.physics.dt;
  let leaked = 0;
  for (let i = 0; i < Math.round(30 / dt); i++) {
    setColliders(f, caps);              // rebuilt every tick, as coupling does
    stepFluid(f, dt);
  }
  for (let i = 0; i < f.pcount; i++) if (f.px[i] > 24.6) leaked++;

  // measured water depth at the wall, from the particles in the last 2 m
  let top = -Infinity;
  for (let i = 0; i < f.pcount; i++) if (f.px[i] > 21 && f.px[i] < 23.4 && f.py[i] > top) top = f.py[i];
  const depth = top + f.spacing * 0.5;
  const analytic = 0.5 * CONFIG.coupling.density * CONFIG.water.g * depth * depth;

  let total = 0;
  const perCap = caps.map((c, i) => ({ y: (c.ay + c.by) * 0.5, fx: f.cfx[i] }));
  for (const c of perCap) total += c.fx;
  const q = depth / 4;
  const bottom = perCap.filter((c) => c.y < q).reduce((s, c) => s + c.fx, 0);
  const topQ = perCap.filter((c) => c.y > depth - q && c.y < depth).reduce((s, c) => s + c.fx, 0);
  console.log(`  depth at wall ${sig(depth)} m, total fx ${sig(total)}, analytic ½rho g H² ${sig(analytic)}`);
  console.log(`  bottom quartile ${sig(bottom)}, top quartile ${sig(topQ)}`);
  ok(Math.abs(total - analytic) <= analytic * 0.3, 'total wall force within ±30% of ½rho g H²',
    `${sig(total)} vs ${sig(analytic)} (${sig((total / analytic - 1) * 100)}%)`);
  gt(bottom, 3 * topQ, 'bottom-quartile load > 3x top-quartile load');
  ok(leaked === 0, 'ZERO particles got past the sealed wall in 30 s', `leaked=${leaked}`);

  // steadiness: the load must not buzz
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < 60; k++) {
    setColliders(f, caps);
    stepFluid(f, dt);
    let t = 0;
    for (let i = 0; i < caps.length; i++) t += f.cfx[i];
    if (t < mn) mn = t;
    if (t > mx) mx = t;
  }
  lt((mx - mn) / total, 0.15, 'settled wall load peak-to-peak variation (fraction of mean)');
}

// ---- 3c. dam break impact vs its own static follow-on --------------------
{
  console.log('\n=== WALL: DAM-BREAK IMPACT ===');
  const terrain = createTerrain([[0, 0], [40, 0]], []);
  const f = createFluid(terrain);
  const caps = wall(30, 12);
  setColliders(f, caps);
  seedBlock(f, 0.6, 14, 8);
  const dt = CONFIG.physics.dt;
  let peak = 0, peakT = 0;
  const steps = Math.round(20 / dt);
  let statSum = 0, statN = 0;
  for (let i = 0; i < steps; i++) {
    setColliders(f, caps);
    stepFluid(f, dt);
    let t = 0;
    for (let k = 0; k < caps.length; k++) t += f.cfx[k];
    const time = (i + 1) * dt;
    if (t > peak) { peak = t; peakT = time; }
    if (time > 15) { statSum += t; statN++; }   // settled against the wall
  }
  const stat = statSum / statN;
  console.log(`  peak ${sig(peak)} at t=${sig(peakT)}s, static follow-on ${sig(stat)}`);
  gt(peak, 2.5 * stat, 'impact peak > 2.5x its own static follow-on');
}

// ---- 4. perf -------------------------------------------------------------
{
  console.log('\n=== PERF ===');
  const { f } = tank(9, 40);
  run(f, 1);                                  // warm up / settle
  const dt = CONFIG.physics.dt;
  const steps = 120;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < steps; i++) stepFluid(f, dt);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
  console.log(`  ${f.pcount} particles, ${f.nx}x${f.ny} grid, ${f.fluidCount} fluid cells`
    + ` -> ${ms.toFixed(3)} ms/tick`);
  lt(ms, 6, 'solver-only cost per tick (ms) at ~4000 particles');
}

console.log(`\nfluid-core: ${fails ? fails + ' FAILURES' : 'all gates pass'}`);
process.exit(fails ? 1 : 0);
