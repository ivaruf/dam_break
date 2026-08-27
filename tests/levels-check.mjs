// Independent validator for the campaign data. Checks the things that make a
// level UNWINNABLE rather than merely hard, using the real terrain, water and
// modes code paths.
// Repo root as a file: URL, derived from this file's own location, so the
// harness runs from any cwd.
const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');

const { LEVELS } = await import(ROOT + '/src/levels/levels.js');
const { loadLevelSpec, seedDesign } = await import(ROOT + '/src/levels/levelLoader.js');
const { CONFIG } = await import(ROOT + '/src/config.js');
const { MATERIALS } = await import(ROOT + '/src/build/materials.js');
const waterSim = await import(ROOT + '/src/physics/water.js');

let fails = 0, warns = 0;
const bad = (id, m) => { console.log('  FAIL ' + id + ': ' + m); fails++; };
const warn = (id, m) => { console.log('  warn ' + id + ': ' + m); warns++; };

const longest = Math.max(...Object.values(MATERIALS).map((m) => m.maxLength));

console.log('levels:', LEVELS.length, ' longest material:', longest + 'm\n');

for (let i = 0; i < LEVELS.length; i++) {
  const spec = LEVELS[i];
  const idx = i + 1;
  const { terrain, level } = loadLevelSpec(spec);
  const id = level.id || 'level#' + idx;
  const o = level.objective || {};
  const bz = level.buildZone;
  const damX = o.type === 'protect' ? o.x0
    : bz ? bz.x1
      : terrain.minX + (terrain.maxX - terrain.minX) * CONFIG.build.modes.damLineFrac;

  // ---- terrain shape
  const pts = level.terrain;
  for (let k = 1; k < pts.length; k++) {
    if (pts[k][0] <= pts[k - 1][0]) bad(id, 'terrain x not strictly ascending at index ' + k);
  }
  if (Math.abs(terrain.minX) > 1e-9) warn(id, 'terrain does not start at x=0 (minX=' + terrain.minX + ')');
  if (terrain.maxX - damX < CONFIG.levels.minRunout) {
    bad(id, 'downstream runout ' + (terrain.maxX - damX).toFixed(1) + 'm < ' + CONFIG.levels.minRunout + 'm');
  }
  // runout must actually fall away so escaped water leaves
  const hDam = terrain.heightAt(damX);
  const hEnd = terrain.heightAt(terrain.maxX);
  if (hEnd >= hDam) bad(id, 'runout does not descend (dam ' + hDam.toFixed(1) + 'm -> end ' + hEnd.toFixed(1) + 'm)');

  // ---- basin must actually be a basin (upstream floor lower than both sides)
  let floor = Infinity, floorX = 0;
  for (let x = terrain.minX; x <= damX; x += 0.5) {
    const h = terrain.heightAt(x);
    if (h < floor) { floor = h; floorX = x; }
  }
  const leftRim = terrain.heightAt(terrain.minX);
  if (leftRim <= floor + 0.5) bad(id, 'no upstream rim: basin cannot hold water (left ' + leftRim.toFixed(1) + ' vs floor ' + floor.toFixed(1) + ')');

  // ---- anchors
  const A = terrain.anchors;
  if (!A.length) bad(id, 'no anchors');
  for (const a of A) {
    const d = a.y - terrain.heightAt(a.x);
    if (Math.abs(d) > 0.25) bad(id, 'anchor ' + a.id + ' is ' + d.toFixed(2) + 'm off the ground');
    if (a.x < terrain.minX || a.x > terrain.maxX) bad(id, 'anchor ' + a.id + ' outside terrain');
  }
  const sorted = A.slice().sort((p, q) => p.x - q.x);
  const mats = level.materials.map((m) => MATERIALS[m]).filter(Boolean);
  if (mats.length !== level.materials.length) bad(id, 'unknown material id in ' + JSON.stringify(level.materials));
  const reach = Math.max(...mats.map((m) => m.maxLength));
  // A gap WIDER than any material can span is deliberate on the later levels:
  // it is what forces a pier founded on the channel bed between the anchors.
  // What must hold is that such a gap has buildable ground inside the build
  // zone to stand that pier on — otherwise the level really is impossible.
  for (let k = 1; k < sorted.length; k++) {
    const a0 = sorted[k - 1], a1 = sorted[k];
    const g = Math.hypot(a1.x - a0.x, a1.y - a0.y);
    if (g <= reach) continue;
    const piers = Math.ceil(g / reach) - 1;
    const step = (a1.x - a0.x) / (piers + 1);
    for (let j = 1; j <= piers; j++) {
      const px = a0.x + step * j;
      if (!bz || px < bz.x0 - 0.01 || px > bz.x1 + 0.01) {
        bad(id, 'a pier is needed at x=' + px.toFixed(1) + ' (anchor gap ' +
          g.toFixed(1) + 'm > ' + reach + 'm reach) but that is outside the build zone');
      }
      const gy = terrain.heightAt(px);
      if (!Number.isFinite(gy)) bad(id, 'no ground under the required pier at x=' + px.toFixed(1));
    }
  }
  // anchors should be inside the build zone, or they cannot be used
  if (bz) {
    const inZone = A.filter((a) => a.x >= bz.x0 - 0.01 && a.x <= bz.x1 + 0.01).length;
    if (inZone < 2) bad(id, 'only ' + inZone + ' anchor(s) inside buildZone [' + bz.x0 + ',' + bz.x1 + ']');
  }

  // ---- water placement vs the dam line (the retention trap)
  // every source counts: `flood` plus any extra pulses in `floods`
  const srcs = [level.water.flood, ...(level.water.floods || [])].filter(Boolean);
  const f = srcs[0] || null;
  if (o.type !== 'protect') {
    for (const s of srcs) {
      if (s.x >= damX) bad(id, 'flood source x=' + s.x + ' is NOT upstream of damX=' + damX);
    }
    for (const p of level.water.initial) {
      if (p.x1 > damX + 0.01) bad(id, 'initial pond [' + p.x0 + ',' + p.x1 + '] crosses damX=' + damX);
    }
  }
  for (const p of level.water.initial) {
    // a pond whose surface is below the local bed adds nothing
    let anyDepth = 0;
    for (let x = p.x0; x <= p.x1; x += 0.5) anyDepth = Math.max(anyDepth, p.surface - terrain.heightAt(x));
    if (anyDepth <= 0.05) bad(id, 'initial pond [' + p.x0 + ',' + p.x1 + '] surface ' + p.surface + ' is at/below the bed');
  }

  // ---- capacity vs inflow, measured on the real grid
  const w = waterSim.createWater(terrain, CONFIG.water);
  const crestGuess = Math.max(...A.map((a) => a.y)) + 6;     // a plausible dam crest
  for (const p of level.water.initial) waterSim.addWater(w, p);
  const preFilled = w.stats.totalIn;
  // basin capacity up to the crest, upstream of the dam line
  let cap = 0;
  for (let ci = 0; ci < w.n; ci++) {
    const x = w.x0 + (ci + 0.5) * w.cellW;
    if (x > damX) break;
    cap += Math.max(0, crestGuess - w.bed[ci]) * w.cellW;
  }
  const inflow = srcs.reduce((s, x) => s + x.rate * x.duration, 0) + preFilled;
  const ratio = cap > 0 ? inflow / cap : Infinity;
  if (o.type === 'retain' && ratio > 1.6) {
    warn(id, 'inflow ' + inflow.toFixed(0) + 'm2 is ' + ratio.toFixed(2) + '× basin capacity to a plausible crest — likely always overtops');
  }
  if (o.type === 'retain' && ratio < 0.15) {
    warn(id, 'inflow ' + inflow.toFixed(0) + 'm2 is only ' + ratio.toFixed(2) + '× capacity — reservoir may never reach the dam');
  }

  // ---- countdown timing
  if (level.mode === 'countdown') {
    if (!(level.countdown > 0)) bad(id, 'countdown mode with no countdown value');
    if (!f) bad(id, 'countdown mode with no flood source');
    else {
      const travel = (damX - f.x) / 3;                        // ~3 m/s front
      const arrive = (f.delay || 0) + travel;
      const skew = level.countdown - arrive;
      if (skew < -8) warn(id, 'wave arrives ' + (-skew).toFixed(0) + 's BEFORE the timer ends (timer is decorative)');
      if (skew > 25) warn(id, 'timer ends ' + skew.toFixed(0) + 's before the wave is near — anticlimax');
    }
  } else if (level.countdown) {
    warn(id, 'freebuild level carries a countdown value');
  }

  // ---- protect zone
  if (o.type === 'protect') {
    if (!(o.x1 > o.x0)) bad(id, 'protect zone x1 <= x0');
    if (bz && bz.x1 > o.x0 + 0.01) bad(id, 'buildZone overlaps the protected zone');
    if (o.x1 > terrain.maxX) bad(id, 'protect zone extends past the terrain');
    if (o.maxDepth === undefined) warn(id, 'protect objective without maxDepth');
  }

  // ---- objective sanity
  if (!['retain', 'survive', 'protect'].includes(o.type)) bad(id, 'unknown objective type ' + o.type);
  if (!(level.budget > 0)) bad(id, 'no budget');
  if (o.duration !== undefined && (o.duration < 10 || o.duration > 180)) warn(id, 'objective duration ' + o.duration + 's is outside 10..180');

  // ---- prebuilt design (repair levels): must itself be player-buildable
  if (level.prebuilt) {
    const seed = seedDesign(level, terrain);
    if (!seed.members.length) bad(id, 'prebuilt declared but seeds no members');
    const byId = new Map(seed.nodes.map((n) => [n.id, n]));
    let seedCost = 0;
    for (const m of seed.members) {
      const a = byId.get(m.a), b = byId.get(m.b);
      const mat = MATERIALS[m.mat];
      if (!a || !b) { bad(id, 'prebuilt member ' + m.id + ' points at a missing node'); continue; }
      if (!mat) { bad(id, 'prebuilt member ' + m.id + ' uses unknown material ' + m.mat); continue; }
      if (!level.materials.includes(m.mat)) bad(id, 'prebuilt uses ' + m.mat + ' which the level does not offer');
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < mat.minLength - 1e-6 || len > mat.maxLength + 1e-6) {
        bad(id, 'prebuilt member ' + m.id + ' is ' + len.toFixed(2) + 'm — outside ' +
          m.mat + "'s " + mat.minLength + '..' + mat.maxLength + 'm');
      }
      seedCost += len * mat.costPerMeter;
    }
    for (const n of seed.nodes) {
      if (n.y < terrain.heightAt(n.x) - CONFIG.build.groundTol - 1e-6) {
        bad(id, 'prebuilt node ' + n.id + ' is underground at (' + n.x + ',' + n.y + ')');
      }
      if (bz && (n.x < bz.x0 - 0.01 || n.x > bz.x1 + 0.01)) {
        bad(id, 'prebuilt node ' + n.id + ' outside the buildZone');
      }
    }
    if (seedCost > level.budget) bad(id, 'prebuilt costs $' + Math.round(seedCost) + ' — over the whole budget');
    else if (seedCost > level.budget * 0.8) {
      warn(id, 'prebuilt costs ' + Math.round((seedCost / level.budget) * 100) + '% of budget — little left to repair with');
    }
  }

  // ---- props
  for (const p of level.props || []) {
    if (!['pine', 'tree', 'rock', 'house', 'sign'].includes(p.type)) bad(id, 'unknown prop type ' + p.type);
    if (!isFinite(p.x) || !isFinite(p.y)) bad(id, 'prop with non-finite position');
    if (bz && p.x > bz.x0 && p.x < bz.x1) warn(id, 'prop inside the buildZone at x=' + p.x);
  }

  const summary = [
    String(idx).padStart(2),
    id.padEnd(10),
    level.mode.padEnd(9),
    o.type.padEnd(7),
    ('damX ' + damX.toFixed(0)).padEnd(9),
    ('span ' + terrain.minX + '-' + terrain.maxX).padEnd(12),
    ('$' + level.budget).padEnd(8),
    ('in ' + inflow.toFixed(0) + '/' + cap.toFixed(0) + 'm2').padEnd(16),
    level.materials.join('+'),
  ].join(' ');
  console.log(summary);
}

console.log('\nFAILS ' + fails + '   warns ' + warns);
process.exit(fails ? 1 : 0);
