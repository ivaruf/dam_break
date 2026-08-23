// OPUS B — headless tests for src/build/*.  Run: node tests/build.test.js
// Covers: snap priority, validate reasons, budget math, place/delete/undo/redo,
// hit tests, and objective/retention evaluation against a fake water object.
// (Opus A owns tests/run.js + tests/scenes.js — this file is separate.)

import { CONFIG } from '../src/config.js';
import { emit, on } from '../src/core/events.js';
import { createTerrain } from '../src/core/terrain.js';
import { snapPoint, validate, hitTestMember, hitTestMembersAlong, hitTol } from '../src/build/snapping.js';
import { MATERIALS } from '../src/build/materials.js';
import * as builder from '../src/build/builder.js';
import * as modes from '../src/build/modes.js';
import { getScene } from '../src/core/game.js';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra ? '   → ' + extra : '')); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(actual, expected, tol, name) {
  ok(Math.abs(actual - expected) <= tol, name, `got ${actual} want ${expected}±${tol}`);
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- fixtures --

const TERRAIN = createTerrain(
  [[0, 12], [14, 7], [24, 3], [34, 3], [44, 3.5], [60, 2.5]],
  [[26, 3], [29, 3], [32, 3]],
);

function level(over) {
  return Object.assign({
    id: 'test', name: 'Test', mode: 'freebuild',
    buildZone: { x0: 24, x1: 34 },
    budget: 3000,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.7, duration: 40 },
  }, over || {});
}

function emptyDesign() { return { nodes: [], members: [] }; }

// Fake water shaped like the contract's water object; the real water helpers
// (volumeBetween / depthAt) operate on it unchanged.
function fakeWater({ n = 20, cellW = 1, x0 = 0, totalIn = 0, depthAtCell = () => 0 } = {}) {
  const depth = new Float32Array(n);
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) depth[i] = depthAtCell(i);
  return { x0, cellW, n, bed, depth, vel: new Float32Array(n + 1), blocked: [], stats: { totalIn } };
}

// ------------------------------------------------------------- 1. snapping --

section('1. SNAPPING PRIORITY');
{
  const design = {
    nodes: [
      { id: 'n1', x: 5, y: 5, anchorId: null },
      { id: 'n2', x: 26, y: 3, anchorId: 'a0' },
    ],
    members: [],
  };

  const s1 = snapPoint(5.2, 5.05, design, TERRAIN);
  eq(s1.nodeId, 'n1', 'node snap wins inside nodeSnap radius');
  eq(s1.kind, 'node', 'node snap reports kind=node');
  near(s1.x, 5, 1e-9, 'node snap returns the node position');

  // 0.75 m from the anchored node: outside nodeSnap (0.6), inside anchorSnap (0.9)
  const s2 = snapPoint(29.75, 3, design, TERRAIN);
  eq(s2.anchorId, 'a1', 'anchor snap wins outside nodeSnap');
  eq(s2.kind, 'anchor', 'anchor snap reports kind=anchor');
  near(s2.x, 29, 1e-9, 'anchor snap returns the anchor position');

  // an anchor that already carries a design node resolves to that node
  const s3 = snapPoint(26.75, 3, design, TERRAIN);
  eq(s3.nodeId, 'n2', 'anchor snap reuses the node already on that anchor');
  eq(s3.anchorId, 'a0', 'reused anchor node keeps its anchorId');

  const s4 = snapPoint(7.3, 4.4, design, TERRAIN);
  eq(s4.kind, 'grid', 'far from everything falls through to grid');
  near(s4.x, 7.5, 1e-9, 'grid snap rounds x to gridSnap');
  near(s4.y, 4.5, 1e-9, 'grid snap rounds y to gridSnap');

  // chain building: the node just placed gets an enlarged radius
  const far = snapPoint(5.9, 5, design, TERRAIN);
  eq(far.kind, 'grid', 'node 0.9 m away is out of normal snap range');
  const chained = snapPoint(5.9, 5, design, TERRAIN, { chainNodeId: 'n1' });
  eq(chained.nodeId, 'n1', 'chain node snaps from further out (chainSnapMul)');

  // nearest node wins when two are in range
  const two = {
    nodes: [{ id: 'a', x: 10, y: 10, anchorId: null }, { id: 'b', x: 10.4, y: 10, anchorId: null }],
    members: [],
  };
  eq(snapPoint(10.35, 10, two, TERRAIN).nodeId, 'b', 'nearest node wins over first found');
}

// ------------------------------------------------------------- 2. validate --

section('2. VALIDATE REASONS');
{
  const L = level();
  const timber = MATERIALS.timber;
  const cable = MATERIALS.cable;
  const P = (x, y, extra) => Object.assign({ x, y, nodeId: null, anchorId: null }, extra || {});

  eq(validate(P(26, 4), P(29, 4), timber, emptyDesign(), TERRAIN, L, 9999).ok, true,
    'a plain 3 m timber member inside the zone is valid');

  eq(validate(P(26, 4), P(26.2, 4), timber, emptyDesign(), TERRAIN, L, 9999).reason, 'too short',
    'below minLength → "too short"');
  eq(validate(P(26, 4), P(32, 4), timber, emptyDesign(), TERRAIN, L, 9999).reason, 'too long',
    'above maxLength → "too long"');
  eq(validate(P(26, 4), P(29, 4), timber, emptyDesign(), TERRAIN, L, 10).reason, 'over budget',
    'cost above remaining budget → "over budget"');
  eq(validate(P(20, 8), P(23, 8), timber, emptyDesign(), TERRAIN, L, 9999).reason, 'outside build zone',
    'endpoint left of buildZone → "outside build zone"');
  eq(validate(P(26, 4), P(35, 4), cable, emptyDesign(), TERRAIN, L, 9999).reason, 'outside build zone',
    'endpoint right of buildZone → "outside build zone"');
  eq(validate(P(26, 1), P(29, 4), timber, emptyDesign(), TERRAIN, L, 9999).reason, 'underground',
    'endpoint below terrain → "underground"');
  eq(validate(P(26, 3), P(29, 3), timber, emptyDesign(), TERRAIN, L, 9999).ok, true,
    'a member lying on flat ground is allowed to touch it');
  eq(validate(P(26, 4), P(29, 4), timber, emptyDesign(), TERRAIN,
    level({ materials: ['steel'] }), 9999).reason, 'not available here',
    'material outside level.materials → "not available here"');

  // interior cutting through a hill
  const hill = createTerrain([[0, 0], [5, 6], [10, 0]], []);
  eq(validate(P(0, 0.2), P(10, 0.2), MATERIALS.cable, emptyDesign(), hill, null, 9999).reason,
    'through the ground', 'interior sample under terrain → "through the ground"');

  // duplicates + near-parallel duplicates at a shared node
  const d = {
    nodes: [
      { id: 'n1', x: 26, y: 4, anchorId: null },
      { id: 'n2', x: 29, y: 4, anchorId: null },
    ],
    members: [{ id: 'm1', a: 'n1', b: 'n2', mat: 'timber' }],
  };
  eq(validate(P(26, 4, { nodeId: 'n1' }), P(29, 4, { nodeId: 'n2' }), timber, d, TERRAIN, L, 9999).reason,
    'already built', 'second member between the same nodes → "already built"');
  eq(validate(P(29, 4, { nodeId: 'n2' }), P(26, 4, { nodeId: 'n1' }), timber, d, TERRAIN, L, 9999).reason,
    'already built', 'duplicate detection is direction-independent');
  eq(validate(P(26, 4, { nodeId: 'n1' }), P(29, 4.2), timber, d, TERRAIN, L, 9999).reason,
    'overlaps a member', `< minAngleDeg (${CONFIG.build.minAngleDeg}°) from a neighbour → "overlaps a member"`);
  eq(validate(P(26, 4, { nodeId: 'n1' }), P(27, 6.5), timber, d, TERRAIN, L, 9999).ok, true,
    'a clearly angled member off the same node is fine');
  eq(validate(P(26, 4, { nodeId: 'n1' }), P(26, 4, { nodeId: 'n1' }), timber, d, TERRAIN, L, 9999).reason,
    'same point', 'both ends on one node → "same point"');
}

// --------------------------------------------------------------- 3. budget --

section('3. BUDGET MATH');
{
  const design = {
    nodes: [
      { id: 'n1', x: 26, y: 3, anchorId: 'a0' },
      { id: 'n2', x: 26, y: 7, anchorId: null },
      { id: 'n3', x: 29, y: 3, anchorId: 'a1' },
    ],
    members: [
      { id: 'm1', a: 'n1', b: 'n2', mat: 'timber' },   // 4 m
      { id: 'm2', a: 'n1', b: 'n3', mat: 'steel' },    // 3 m
    ],
  };
  const want = 4 * MATERIALS.timber.costPerMeter + 3 * MATERIALS.steel.costPerMeter;
  near(builder.designCost(design), want, 1e-6, 'designCost sums length × costPerMeter');
  eq(builder.designCost({ nodes: [], members: [] }), 0, 'empty design costs nothing');

  const broken = { nodes: [], members: [{ id: 'm1', a: 'gone', b: 'gone2', mat: 'timber' }] };
  eq(builder.designCost(broken), 0, 'designCost ignores members with missing nodes');
}

// -------------------------------------------------- 4. hit tests + tol -----

section('4. HIT TESTS');
{
  const design = {
    nodes: [{ id: 'n1', x: 26, y: 3, anchorId: null }, { id: 'n2', x: 26, y: 7, anchorId: null }],
    members: [{ id: 'm1', a: 'n1', b: 'n2', mat: 'timber' }],
  };
  eq(hitTestMember(26.1, 5, design, 0.2), 'm1', 'point near a member hits it');
  eq(hitTestMember(28, 5, design, 0.2), null, 'point far from every member hits nothing');
  eq(hitTestMember(26, 9, design, 0.2), null, 'past the end of the segment is a miss');
  eq(hitTestMembersAlong(24, 5, 28, 5, design, 0.05).length, 1, 'a crossing path hits the member');
  eq(hitTestMembersAlong(24, 9, 28, 9, design, 0.05).length, 0, 'a path that misses hits nothing');
  ok(hitTol(1000) === CONFIG.build.hitMinWorld, 'hit tolerance clamps at hitMinWorld when zoomed in');
  ok(hitTol(0.001) === CONFIG.build.hitMaxWorld, 'hit tolerance clamps at hitMaxWorld when zoomed out');
  ok(hitTol(100) < hitTol(20), 'hit tolerance shrinks in world units as zoom grows');
}

// --------------------------------------------- 5. builder pointer + undo ---

section('5. PLACE / DELETE / UNDO / REDO');
{
  const S = getScene();
  const design = emptyDesign();
  const L = level();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.camera = { zoom: 14 };
  S.structure = null; S.water = null; S.simTime = 0;

  builder.initBuilder();
  builder.startLevel(L, TERRAIN, design);

  const Z = 14;
  const px = (x) => x * Z, py = (y) => -y * Z;
  function drag(x0, y0, x1, y1, opts) {
    const o = opts || {};
    emit('input:down', { x: x0, y: y0, px: px(x0), py: py(y0), id: 1, button: o.button || 0, cancel: false });
    emit('input:move', { x: x1, y: y1, px: px(x1), py: py(y1), id: 1, button: o.button || 0, cancel: false, hover: false });
    emit('input:up', { x: x1, y: y1, px: px(x1), py: py(y1), id: 1, button: o.button || 0, cancel: !!o.cancel });
  }
  function tap(x, y, button) {
    emit('input:down', { x, y, px: px(x), py: py(y), id: 1, button: button || 0, cancel: false });
    emit('input:up', { x, y, px: px(x), py: py(y), id: 1, button: button || 0, cancel: false });
  }

  drag(26, 3, 26, 7);
  eq(design.members.length, 1, 'drag places one member');
  eq(design.nodes.length, 2, 'drag creates both endpoints');
  eq(design.nodes[0].anchorId, 'a0', 'a drag started on an anchor produces an anchored node');
  eq(builder.getBuilder().ghost, null, 'ghost is cleared after release');

  // chain build: continue from the endpoint just placed
  drag(26.1, 6.9, 28, 6);
  eq(design.members.length, 2, 'chain drag from the fresh endpoint places a second member');
  eq(design.nodes.length, 3, 'chain drag reuses the shared node instead of duplicating it');
  const shared = design.members[0].b === design.members[1].a || design.members[0].b === design.members[1].b;
  ok(shared, 'the chained member is joined to the previous endpoint');

  drag(26, 3, 28, 6);
  eq(design.members.length, 3, 'closing the triangle works');

  // refusals never mutate the design
  const before = design.members.length;
  drag(26, 3, 40, 3);
  eq(design.members.length, before, 'an invalid drag (outside zone / too long) places nothing');
  ok(builder.getHint().length > 0, 'a refused placement leaves a hint for the HUD');

  // pinch-cancel
  drag(29, 3, 29, 6, { cancel: true });
  eq(design.members.length, before, 'a cancelled (pinch) gesture places nothing');

  // tap selects, tap on empty clears
  tap(26.05, 5);
  eq(builder.getSelection(), design.members[0].id, 'tap on a member selects it');
  tap(40, 10);
  eq(builder.getSelection(), null, 'tap on empty space clears the selection');

  // right-click delete
  const n = design.members.length;
  tap(26.05, 5, 2);
  eq(design.members.length, n - 1, 'right-click on a member deletes it');
  ok(builder.undo(), 'undo after a right-click delete succeeds');
  eq(design.members.length, n, 'undo restores the deleted member');
  ok(builder.redo(), 'redo after undo succeeds');
  eq(design.members.length, n - 1, 'redo re-deletes it');
  builder.undo();

  // delete selection + orphan cleanup
  builder.startLevel(L, TERRAIN, design);
  design.nodes.length = 0; design.members.length = 0;
  drag(26, 3, 26, 7);
  eq(design.nodes.length, 2, 'fresh single member has two nodes');
  builder.getBuilder().selection = design.members[0].id;
  ok(builder.deleteSelection(), 'deleteSelection removes the selected member');
  eq(design.members.length, 0, 'the member is gone');
  eq(design.nodes.length, 0, 'orphaned nodes are cleaned up');
  eq(builder.getSelection(), null, 'the selection is cleared with the member');
  ok(builder.undo(), 'undo brings the deletion back');
  eq(design.members.length, 1, 'member restored by undo');
  eq(design.nodes.length, 2, 'nodes restored by undo');

  // keyboard: material select from the LEVEL list, erase tool, undo key
  builder.startLevel(level({ materials: ['steel', 'cable'] }), TERRAIN, design);
  S.level = builder.getBuilder().level;
  eq(builder.getBuilder().material, 'steel', 'default material is the level list head');
  emit('input:key', { key: '2' });
  eq(builder.getBuilder().material, 'cable', 'key 2 picks the second LEVEL material, not the global one');
  emit('input:key', { key: '4' });
  eq(builder.getBuilder().material, 'cable', 'a key beyond the level list is ignored');
  emit('input:key', { key: 'e' });
  eq(builder.getBuilder().tool, 'erase', 'key E arms the eraser');
  emit('input:key', { key: 'e' });
  eq(builder.getBuilder().tool, 'build', 'key E toggles back to build');
  emit('ui:tool', { id: 'erase' });
  eq(builder.getBuilder().tool, 'erase', 'ui:tool arms the eraser');
  emit('ui:tool', { id: 'erase' });
  eq(builder.getBuilder().tool, 'build', 're-sending the active tool toggles it off');

  // eraser drag deletes everything it crosses, in one undo step
  S.level = L;
  builder.startLevel(L, TERRAIN, design);
  design.nodes.length = 0; design.members.length = 0;
  drag(26, 3, 26, 7);
  drag(29, 3, 29, 7);
  eq(design.members.length, 2, 'two separate uprights placed');
  emit('ui:tool', { id: 'erase' });
  drag(25, 5, 30, 5);
  eq(design.members.length, 0, 'an eraser drag removes every member it touches');
  ok(builder.undo(), 'the whole eraser drag is a single undo step');
  eq(design.members.length, 2, 'both members come back at once');
  emit('ui:tool', { id: 'build' });

  // budget refusal end-to-end
  builder.startLevel(level({ budget: 40 }), TERRAIN, design);
  S.level = builder.getBuilder().level;
  design.nodes.length = 0; design.members.length = 0;
  near(builder.budgetLeft(), 40, 1e-9, 'budgetLeft starts at the level budget');
  drag(26, 3, 26, 7);   // 4 m timber = $60 > $40
  eq(design.members.length, 0, 'a placement that would break the budget is refused');
  eq(builder.getHint(), 'over budget', 'the refusal reason reaches the HUD hint');

  // undo depth ≥ 30. No anchors, and columns 1.5 m apart so nothing collapses
  // into a neighbouring node (nodeSnap is deliberately wider than gridSnap).
  const TERRAIN_NA = createTerrain(TERRAIN.points.map((p) => [p[0], p[1]]), []);
  S.level = L; S.terrain = TERRAIN_NA;
  builder.startLevel(L, TERRAIN_NA, design);
  design.nodes.length = 0; design.members.length = 0;
  for (let i = 0; i < 34; i++) {
    const x = 24 + (i % 7) * 1.5;
    const y = 3 + Math.floor(i / 7) * 3;
    drag(x, y, x, y + 3);
  }
  const placed = design.members.length;
  ok(placed >= 30, `at least 30 placements to undo (placed ${placed})`);
  let undone = 0;
  while (builder.undo()) undone++;
  ok(undone >= 30, `undo stack holds at least 30 steps (undid ${undone})`);
  eq(design.members.length, 0, 'undoing everything empties the design');
  let redone = 0;
  while (builder.redo()) redone++;
  eq(redone, undone, 'redo replays every undone step');
  eq(design.members.length, placed, 'redo restores the full design');

  // ---- structural invariants after awkward interleavings (fuzz regressions) --
  const dangling = (d) => d.members.filter((m) =>
    !d.nodes.some((n) => n.id === m.a) || !d.nodes.some((n) => n.id === m.b)).length;
  const orphans = (d) => d.nodes.filter((n) =>
    !d.members.some((m) => m.a === n.id || m.b === n.id)).length;

  // A node deleted DURING a drag must not be resurrected by the release.
  S.terrain = TERRAIN; S.level = L;
  builder.startLevel(L, TERRAIN, design);
  design.nodes.length = 0; design.members.length = 0;
  drag(26, 4, 29, 4);
  eq(design.members.length, 1, 'setup: one member for the stale-ghost case');
  tap(27.5, 4);
  ok(builder.getSelection() !== null, 'setup: the member is selected');
  emit('input:down', { x: 26, y: 4, px: px(26), py: py(4), id: 1, button: 0, cancel: false });
  emit('input:move', { x: 29, y: 4, px: px(29), py: py(4), id: 1, button: 0, cancel: false, hover: false });
  emit('input:key', { key: 'Delete' });          // deletes the member mid-drag
  emit('input:up', { x: 29, y: 4, px: px(29), py: py(4), id: 1, button: 0, cancel: false });
  eq(dangling(design), 0, 'a node deleted mid-drag is never resurrected by the release');
  eq(orphans(design), 0, 'no orphan survives the mid-drag deletion');

  // An undo snapshot taken while a drag protects an unreferenced node must not
  // bake that node into history.
  builder.startLevel(L, TERRAIN, design);
  design.nodes.length = 0; design.members.length = 0;
  drag(26, 4, 26, 7);        // M1
  drag(31, 4, 31, 7);        // M2, independent
  eq(design.members.length, 2, 'setup: two independent members');
  builder.getBuilder().selection = design.members[0].id;
  emit('input:down', { x: 26, y: 4, px: px(26), py: py(4), id: 1, button: 0, cancel: false });
  emit('input:key', { key: 'Delete' });          // M1 gone; its start node is drag-protected
  emit('input:down', { x: 31, y: 5.5, px: px(31), py: py(5.5), id: 1, button: 2, cancel: false });
  emit('input:up', { x: 31, y: 5.5, px: px(31), py: py(5.5), id: 1, button: 2, cancel: false });
  eq(orphans(design), 0, 'the live design is clean after the interleaved deletes');
  builder.undo();
  eq(orphans(design), 0, 'undo does not resurrect a drag-protected orphan');
  builder.undo();
  eq(orphans(design), 0, 'a second undo step is orphan-free too');
  eq(dangling(design), 0, 'undo never leaves a member pointing at a missing node');

  // phase gate
  S.phase = 'sim';
  const frozen = design.members.length;
  drag(26, 3, 27, 6);
  eq(design.members.length, frozen, 'nothing can be built outside the build phase');
  S.phase = 'build';
}

// -------------------------------------------------- 6. retention + modes ---

section('6. RETENTION + OBJECTIVES');
{
  // dam line
  eq(modes.damLineX(level(), TERRAIN), 34, 'dam line is buildZone.x1');
  eq(modes.damLineX(level({ buildZone: null, objective: { type: 'protect', x0: 40, x1: 50, maxDepth: 0.3, duration: 10 } }), TERRAIN),
    40, 'protect objective puts the dam line at the zone start');
  near(modes.damLineX(level({ buildZone: null, objective: { type: 'survive', duration: 10 } }), TERRAIN),
    30, 1e-9, 'with no zone the dam line is mid-terrain');

  // retention math on a fake water object
  const dry = fakeWater({ totalIn: 0 });
  eq(modes.computeRetention(dry, 10), 1, 'no inflow yet → retention reads as full');

  const held = fakeWater({ totalIn: 10, depthAtCell: (i) => (i < 10 ? 1 : 0) }); // 10 m² upstream
  near(modes.computeRetention(held, 10), 1, 1e-6, 'all water upstream of the dam line → 1.0');

  const half = fakeWater({ totalIn: 10, depthAtCell: (i) => (i < 5 ? 1 : 0) });
  near(modes.computeRetention(half, 10), 0.5, 1e-6, 'half the inflow still upstream → 0.5');

  const leaked = fakeWater({ totalIn: 10, depthAtCell: (i) => (i >= 10 ? 1 : 0) });
  near(modes.computeRetention(leaked, 10), 0, 1e-6, 'everything downstream → 0.0');

  const over = fakeWater({ totalIn: 4, depthAtCell: (i) => (i < 10 ? 1 : 0) });
  eq(modes.computeRetention(over, 10), 1, 'retention is clamped to 1');

  near(modes.maxDepthBetween(fakeWater({ totalIn: 10, depthAtCell: (i) => i * 0.1 }), 0, 10), 0.9, 1e-6,
    'maxDepthBetween finds the deepest cell in range');

  // drive a full retain run: win
  modes.initModes();
  const S = getScene();
  const L = level({ objective: { type: 'retain', minRetention: 0.7, duration: 5 } });
  S.level = L; S.terrain = TERRAIN; S.structure = null;
  S.design = {
    nodes: [{ id: 'n1', x: 26, y: 3, anchorId: 'a0' }, { id: 'n2', x: 26, y: 7, anchorId: null }],
    members: [{ id: 'm1', a: 'n1', b: 'n2', mat: 'timber' }],
  };
  S.water = fakeWater({ totalIn: 10, depthAtCell: (i) => (i < 30 ? 1 : 0), n: 40 });

  let wins = 0, fails = 0, lastStats = null;
  on('level:win', ({ stats }) => { wins++; lastStats = stats; });
  on('level:fail', ({ stats }) => { fails++; lastStats = stats; });

  modes.startLevel(L, TERRAIN);
  modes.startSim(L, null);
  S.simTime = 0;
  const dt = CONFIG.physics.dt;
  for (let i = 0; i < 60 * 8; i++) { S.simTime += dt; modes.update(dt); }
  eq(wins, 1, 'a held reservoir emits level:win exactly once');
  eq(fails, 0, 'no fail is emitted on a win');
  ok(lastStats && lastStats.win === true, 'stats.win is true');
  near(lastStats.cost, 4 * MATERIALS.timber.costPerMeter, 1e-6, 'stats.cost is the design cost');
  near(lastStats.survivalTime, 5, 0.1, 'stats.survivalTime is when the objective completed');
  near(lastStats.peakDepth, 1, 1e-6, 'stats.peakDepth tracks the upstream reservoir');
  eq(lastStats.cause, '', 'a win carries no cause');

  // drive a full retain run: early fail, a couple of seconds after the loss
  wins = 0; fails = 0;
  S.water = fakeWater({ totalIn: 10, depthAtCell: (i) => (i >= 34 ? 0.25 : 0), n: 40 });
  modes.startSim(L, null);
  S.simTime = 0;
  let failTime = -1;
  const offFail = on('level:fail', () => { if (failTime < 0) failTime = S.simTime; });
  for (let i = 0; i < 60 * 12; i++) { S.simTime += dt; modes.update(dt); }
  offFail();
  eq(fails, 1, 'a drained reservoir emits level:fail exactly once');
  eq(wins, 0, 'no win is emitted on a fail');
  const C = CONFIG.build.modes;
  ok(failTime >= C.startGrace + C.failGrace - 0.2 && failTime <= C.startGrace + C.failGrace + 0.4,
    `fail waits startGrace + failGrace before firing (fired at ${failTime.toFixed(2)}s)`);
  eq(lastStats.win, false, 'stats.win is false on a fail');
  ok(typeof lastStats.cause === 'string' && lastStats.cause.length > 0, 'a fail carries a cause line');
  ok(lastStats.cause === "BUDGET WASN'T THE PROBLEM — THE DAM SLID",
    'an intact dam that lost its reservoir early blames the dam', lastStats.cause);

  // structural failure produces a positional + material cause line
  wins = 0; fails = 0;
  S.structure = { maxLoad: 1.4, brokenCount: 1, firstFailure: { memberId: 'm1', mode: 'compression', time: 3.5, x: 26, y: 3.2 } };
  modes.startSim(L, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 12; i++) { S.simTime += dt; modes.update(dt); }
  eq(fails, 1, 'a broken dam fails once');
  ok(/TIMBER — COMPRESSION LIMIT EXCEEDED at 3\.5s$/.test(lastStats.cause),
    'the cause names the member position, material, mode and time', lastStats.cause);
  eq(lastStats.brokenCount, 1, 'stats.brokenCount comes from the structure');
  near(lastStats.maxLoad, 1.4, 1e-6, 'stats.maxLoad comes from the structure');

  // overtop beats a later break in the story
  wins = 0; fails = 0;
  S.structure = { maxLoad: 1.4, brokenCount: 1, firstFailure: { memberId: 'm1', mode: 'tension', time: 9, x: 26, y: 6 } };
  modes.startSim(L, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 12; i++) {
    S.simTime += dt;
    if (i === 30) emit('overtop', { x: 26, flow: 1 });
    modes.update(dt);
  }
  eq(fails, 1, 'an overtopped dam fails once');
  ok(/^OVERTOPPED/.test(lastStats.cause), 'the earliest event wins the cause line', lastStats.cause);

  // protect objective
  wins = 0; fails = 0;
  S.structure = null;
  const PL = level({
    buildZone: { x0: 24, x1: 34 },
    objective: { type: 'protect', x0: 36, x1: 40, maxDepth: 0.3, duration: 5 },
  });
  S.level = PL;
  S.water = fakeWater({ totalIn: 10, n: 60, depthAtCell: (i) => (i >= 36 && i <= 40 ? 1.2 : 0) });
  modes.startSim(PL, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 8; i++) { S.simTime += dt; modes.update(dt); }
  eq(fails, 1, 'water over maxDepth in the protected zone fails the level');
  ok(/^FLOODED DOWNSTREAM/.test(lastStats.cause), 'protect failure says FLOODED DOWNSTREAM', lastStats.cause);

  wins = 0; fails = 0;
  S.water = fakeWater({ totalIn: 10, n: 60, depthAtCell: (i) => (i < 30 ? 1.2 : 0) });
  modes.startSim(PL, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 8; i++) { S.simTime += dt; modes.update(dt); }
  eq(wins, 1, 'a dry protected zone wins at the duration');

  // survive objective: catastrophic collapse
  wins = 0; fails = 0;
  const SL = level({ buildZone: null, objective: { type: 'survive', duration: 5 } });
  S.level = SL;
  S.design = {
    nodes: [{ id: 'n1', x: 26, y: 3, anchorId: 'a0' }, { id: 'n2', x: 26, y: 7, anchorId: null }],
    members: [
      { id: 'm1', a: 'n1', b: 'n2', mat: 'timber' },
      { id: 'm2', a: 'n1', b: 'n2', mat: 'steel' },
      { id: 'm3', a: 'n1', b: 'n2', mat: 'cable' },
    ],
  };
  S.structure = { maxLoad: 2, brokenCount: 2, firstFailure: { memberId: 'm1', mode: 'tension', time: 1, x: 26, y: 5 } };
  S.water = fakeWater({ totalIn: 10, n: 40, depthAtCell: () => 0 });
  modes.startSim(SL, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 12; i++) { S.simTime += dt; modes.update(dt); }
  eq(fails, 1, 'more than collapseFrac of the members broken fails a survive level');
  ok(/^PROGRESSIVE COLLAPSE/.test(lastStats.cause), 'collapse reports how many members went', lastStats.cause);

  wins = 0; fails = 0;
  S.structure = { maxLoad: 0.6, brokenCount: 0, firstFailure: null };
  modes.startSim(SL, null);
  S.simTime = 0;
  for (let i = 0; i < 60 * 8; i++) { S.simTime += dt; modes.update(dt); }
  eq(wins, 1, 'an intact structure survives to the duration');

  // objective text + progress
  ok(modes.objectiveText(level()).includes('70%'), 'objectiveText spells out a retain target');
  const prog = modes.getProgress();
  ok(prog && prog.type === 'survive', 'getProgress reports the live objective type');
}

// ------------------------------------ 7. integration smoke (real physics) --
// modes.js must work against the REAL water API, not just the fake above.
// Opus A owns the physics modules; if they throw this section reports SKIP
// rather than failing the build-side suite.

section('7. INTEGRATION SMOKE — real water + structure');
try {
  const waterSim = await import('../src/physics/water.js');
  const structures = await import('../src/physics/structures.js');
  const constraints = await import('../src/physics/constraints.js');
  const stress = await import('../src/physics/stress.js');
  const coupling = await import('../src/physics/coupling.js');

  const S = getScene();
  const L = level({ objective: { type: 'retain', minRetention: 0.7, duration: 6 }, budget: 3000 });
  const design = emptyDesign();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.camera = { zoom: 14 }; S.structure = null; S.simTime = 0;
  builder.startLevel(L, TERRAIN, design);

  // a braced timber wall across the valley floor, built through the real
  // pointer flow so this also proves the builder produces a legal design
  const Z = 14;
  const put = (x0, y0, x1, y1) => {
    emit('input:down', { x: x0, y: y0, px: x0 * Z, py: -y0 * Z, id: 1, button: 0, cancel: false });
    emit('input:move', { x: x1, y: y1, px: x1 * Z, py: -y1 * Z, id: 1, button: 0, cancel: false, hover: false });
    emit('input:up', { x: x1, y: y1, px: x1 * Z, py: -y1 * Z, id: 1, button: 0, cancel: false });
  };
  put(29, 3, 29, 6.5);       // the face
  put(26, 3, 29, 6.5);       // upstream brace to an anchor
  put(32, 3, 29, 6.5);       // downstream brace to an anchor
  put(26, 3, 29, 3);         // ground tie
  ok(design.members.length === 4, `the braced wall built cleanly (${design.members.length}/4 members)`);
  ok(builder.designCost(design) <= L.budget, 'the wall fits the level budget');

  S.water = waterSim.createWater(TERRAIN, CONFIG.water);
  for (const pond of [{ x0: 0, x1: 12, surface: 9 }]) waterSim.addWater(S.water, pond);
  waterSim.addSource(S.water, { x: 2, rate: 2.2, duration: 20, delay: 0 });
  S.structure = structures.instantiate(design, TERRAIN, MATERIALS);
  S.phase = 'sim'; S.simTime = 0;

  let outcomes = 0;
  const offWin = on('level:win', () => outcomes++);
  const offFail = on('level:fail', () => outcomes++);
  modes.startLevel(L, TERRAIN);
  modes.startSim(L, null);

  const dt = CONFIG.physics.dt;
  let finite = true;
  for (let i = 0; i < 60 * 8; i++) {
    S.simTime += dt;
    coupling.updateObstructions(S.structure, S.water);
    waterSim.stepWater(S.water, dt);
    coupling.applyWaterForces(S.structure, S.water, dt);
    constraints.stepStructure(S.structure, TERRAIN, dt);
    stress.updateStress(S.structure, dt, S.simTime);
    modes.update(dt);
    for (const n of S.structure.nodes) if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) finite = false;
    if (!finite) break;
  }
  offWin(); offFail();

  ok(finite, 'no node position went non-finite over 8 s of real simulation');
  eq(outcomes, 1, 'exactly one level:win / level:fail per sim run against real water');
  const st = modes.getStats();
  ok(st && st.retained >= 0 && st.retained <= 1, `retained stays in 0..1 (${st && st.retained.toFixed(3)})`);
  ok(st && st.peakDepth >= 0, 'peakDepth is non-negative');
  ok(st && Number.isFinite(st.maxLoad), 'maxLoad is finite');
  console.log(`  note   real-sim result: win=${st.win} retained=${st.retained.toFixed(2)} ` +
    `peak=${st.peakDepth.toFixed(2)}m broken=${st.brokenCount} cause="${st.cause}"`);
  S.phase = 'build';
} catch (err) {
  console.log('  SKIP  physics modules unavailable or throwing: ' + err.message);
}

// ---------------------------------------------------------------- summary --

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
