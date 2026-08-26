// OPUS B — headless tests for src/build/*.  Run: node tests/build.test.js
// Covers: snap priority, validate reasons, budget math, place/delete/undo/redo,
// hit tests, and objective/retention evaluation against a fake water object.
// (Opus A owns tests/run.js + tests/scenes.js — this file is separate.)

import { CONFIG } from '../src/config.js';
import { emit, on } from '../src/core/events.js';
import { createTerrain } from '../src/core/terrain.js';
import {
  snapPoint, validate, hitTestMember, hitTestMembersAlong, hitTestMembersInRect,
  segRectDistance, hitTol,
} from '../src/build/snapping.js';
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

// ------------------------------------------- 8. box delete (section erase) --
// The 'boxdelete' tool: drag a marquee, everything it touches highlights,
// release deletes the whole section as ONE undo step. A tap falls back to the
// single-member erase so the tool is never a dead zone.

section('8. BOX DELETE — SECTION MARQUEE');
{
  // ---- pure geometry -----------------------------------------------------
  const PAD = CONFIG.build.marqueeHitPad;
  const geo = {
    nodes: [
      { id: 'n1', x: 10, y: 0, anchorId: null }, { id: 'n2', x: 10, y: 4, anchorId: null },
      { id: 'n3', x: 20, y: 0, anchorId: null }, { id: 'n4', x: 20, y: 4, anchorId: null },
      { id: 'n5', x: 0, y: 8, anchorId: null }, { id: 'n6', x: 30, y: 8, anchorId: null },
    ],
    members: [
      { id: 'mA', a: 'n1', b: 'n2', mat: 'timber' },    // vertical at x = 10, fat
      { id: 'mB', a: 'n3', b: 'n4', mat: 'cable' },     // vertical at x = 20, hairline
      { id: 'mC', a: 'n5', b: 'n6', mat: 'timber' },    // long horizontal at y = 8
      { id: 'mD', a: 'gone', b: 'n2', mat: 'timber' },  // dangling — must be ignored
    ],
  };
  const inRect = (x0, y0, x1, y1) => hitTestMembersInRect(x0, y0, x1, y1, geo, PAD).join(',');

  eq(segRectDistance(10, 1, 10, 2, 9, 0, 11, 3), 0, 'a segment inside the rect is at distance 0');
  eq(segRectDistance(9, 1, 12, 1, 9.5, 0, 11, 3), 0, 'a segment crossing the rect is at distance 0');
  near(segRectDistance(0, 0, 1, 0, 5, 5, 6, 6), Math.hypot(4, 5), 1e-9,
    'a segment clear of the rect measures to the nearest corner');

  eq(inRect(9, -1, 11, 5), 'mA', 'a member wholly inside the box is selected');
  eq(inRect(8, 1, 12, 2), 'mA', 'a member crossing the box edges is selected');
  eq(inRect(11, 1, 13, 2), '', 'a member clear of the box is not selected');
  eq(inRect(10.2, 1, 12, 2), 'mA', 'a fat member grazing the edge counts (thickness/2 + pad)');
  eq(inRect(10.3, 1, 12, 2), '', 'just past thickness/2 + pad the fat member is out');
  eq(inRect(20.2, 1, 22, 2), '', 'a hairline cable at the same 0.2 m offset stays out');
  eq(inRect(11, 5, 9, -1), 'mA', 'the rect test is orientation-independent');
  eq(inRect(10.1, 2, 10.1, 2), 'mA', 'a zero-area marquee degrades to a point test');
  eq(inRect(12, 7, 18, 9), 'mC', 'a long member counts when any part of it crosses the box');
  eq(inRect(-1, -1, 31, 9), 'mA,mB,mC', 'a box over everything selects every member, in design order');
  ok(!inRect(-1, -1, 31, 9).includes('mD'), 'a member with a missing node is never selected');

  // ---- the tool, through the real pointer flow ----------------------------
  const S = getScene();
  const design = emptyDesign();
  const L = level();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.camera = { zoom: 14 };
  S.structure = null; S.water = null; S.simTime = 0;
  builder.startLevel(L, TERRAIN, design);
  const B = builder.getBuilder();

  const Z = 14;
  const px = (x) => x * Z, py = (y) => -y * Z;
  const down = (x, y, button) =>
    emit('input:down', { x, y, px: px(x), py: py(y), id: 1, button: button || 0, cancel: false });
  const move = (x, y) =>
    emit('input:move', { x, y, px: px(x), py: py(y), id: 1, button: 0, cancel: false, hover: false });
  const up = (x, y, cancel) =>
    emit('input:up', { x, y, px: px(x), py: py(y), id: 1, button: 0, cancel: !!cancel });
  const tap = (x, y) => { down(x, y); up(x, y); };
  const put = (x0, y0, x1, y1) => { down(x0, y0); move(x1, y1); up(x1, y1); };
  const arm = () => { if (B.tool !== 'boxdelete') emit('ui:tool', { id: 'boxdelete' }); };
  const disarm = () => emit('ui:tool', { id: 'build' });

  // drag a marquee and report the state seen mid-gesture (the UI renders this)
  function boxDrag(x0, y0, x1, y1, opts) {
    const o = opts || {};
    down(x0, y0);
    move(x1, y1);
    const live = { rect: B.marquee ? { ...B.marquee } : null, hits: B.marqueeHits.slice() };
    up(x1, y1, o.cancel);
    return live;
  }

  // ---- activation / toggling ---------------------------------------------
  emit('ui:tool', { id: 'boxdelete' });
  eq(B.tool, 'boxdelete', 'ui:tool {id:boxdelete} arms the section box');
  emit('ui:tool', { id: 'boxdelete' });
  eq(B.tool, 'build', 're-sending boxdelete toggles it back to build');
  emit('input:key', { key: 'x' });
  eq(B.tool, 'boxdelete', 'key X arms the section box');
  emit('input:key', { key: 'x' });
  eq(B.tool, 'build', 'key X toggles it off again');
  emit('input:key', { key: 'X' });
  eq(B.tool, 'boxdelete', 'shift-X arms it too');
  emit('ui:tool', { id: 'erase' });
  eq(B.tool, 'erase', 'the single-member eraser replaces the box tool');
  emit('input:key', { key: 'x' });
  eq(B.tool, 'boxdelete', 'X switches straight from the eraser to the box');
  emit('ui:material', { id: 'timber' });
  eq(B.tool, 'build', 'picking a material drops the box tool for build');
  eq(B.marquee, null, 'no marquee while nothing is being dragged');
  eq(B.marqueeHits.length, 0, 'no marquee hits while nothing is being dragged');

  // ---- four uprights, 2.5 m apart ----------------------------------------
  design.nodes.length = 0; design.members.length = 0;
  builder.startLevel(L, TERRAIN, design);
  put(25, 4, 25, 7); put(27.5, 4, 27.5, 7); put(30, 4, 30, 7); put(32.5, 4, 32.5, 7);
  const ids = design.members.map((m) => m.id);
  eq(design.members.length, 4, 'setup: four uprights placed for the section tests');
  eq(design.nodes.length, 8, 'setup: eight nodes');
  near(builder.designCost(design), 4 * 3 * MATERIALS.timber.costPerMeter, 1e-6,
    'setup: the four 3 m timber uprights cost 180');

  let changes = [];
  const offChange = on('design:change', (e) => changes.push(e));

  // ---- the marquee itself -------------------------------------------------
  arm();
  changes = [];
  const live = boxDrag(28.5, 7.5, 24.5, 3.5);          // dragged up-left on purpose
  ok(live.rect !== null, 'dragging with the tool armed produces a live marquee');
  near(live.rect.x0, 24.5, 1e-9, 'the marquee normalizes x0 <= x1');
  near(live.rect.y0, 3.5, 1e-9, 'the marquee normalizes y0 <= y1');
  near(live.rect.x1, 28.5, 1e-9, 'marquee x1 is the larger x');
  near(live.rect.y1, 7.5, 1e-9, 'marquee y1 is the larger y');
  eq(live.hits.length, 2, 'the live hit list holds the members inside the box');
  ok(live.hits.includes(ids[0]) && live.hits.includes(ids[1]),
    'the hits are exactly the two uprights inside the box');
  eq(design.members.length, 2, 'release deletes the whole boxed section');
  eq(design.nodes.length, 4, 'the section takes its nodes with it (orphan cleanup)');
  eq(B.marquee, null, 'the marquee is cleared on release');
  eq(B.marqueeHits.length, 0, 'the hit list is cleared on release');
  eq(changes.length, 1, 'a section delete emits exactly ONE design:change');
  eq(changes[0].action, 'delete', 'the event action is delete');
  eq(changes[0].id, null, 'a section delete carries id null');
  eq(changes[0].count, 2, 'the event counts the members that went');
  near(builder.designCost(design), 2 * 3 * MATERIALS.timber.costPerMeter, 1e-6,
    'the deleted section stops costing anything');
  near(builder.budgetLeft(), L.budget - 90, 1e-6, 'the budget is refunded for the whole section');

  // ---- one undo step ------------------------------------------------------
  ok(builder.undo(), 'undo after a section delete succeeds');
  eq(design.members.length, 4, 'ONE undo restores the entire section');
  eq(design.nodes.length, 8, 'and all of its nodes');
  ok(builder.redo(), 'redo after that undo succeeds');
  eq(design.members.length, 2, 'redo re-deletes the whole section at once');
  builder.undo();
  eq(design.members.length, 4, 'back to four uprights');

  // ---- members crossing the box edge -------------------------------------
  arm();
  const band = boxDrag(26.5, 5, 31, 5.5);              // thin band across mid-span
  eq(band.hits.length, 2, 'a thin band crossing two members selects both');
  eq(design.members.length, 2, 'and takes exactly those two');
  ok(design.members.every((m) => m.id !== ids[1] && m.id !== ids[2]),
    'the two crossed uprights are the ones that died');
  builder.undo();

  // ---- selection ----------------------------------------------------------
  disarm();
  tap(25, 5.5);
  eq(builder.getSelection(), ids[0], 'setup: the first upright is selected');
  arm();
  boxDrag(24, 3.5, 26, 7.5);
  eq(design.members.length, 3, 'the box took the selected upright');
  eq(builder.getSelection(), null, 'the selection is cleared when its member is boxed away');
  builder.undo();

  disarm();
  tap(32.5, 5.5);
  eq(builder.getSelection(), ids[3], 'setup: the last upright is selected');
  arm();
  boxDrag(24, 3.5, 26, 7.5);
  eq(builder.getSelection(), ids[3], 'a section delete elsewhere leaves the selection alone');
  builder.undo();

  // ---- pinch-cancel -------------------------------------------------------
  arm();
  const n0 = design.members.length;
  const cancelled = boxDrag(24, 3.5, 33, 7.5, { cancel: true });
  eq(cancelled.hits.length, 4, 'the cancelled marquee had previewed all four uprights');
  eq(design.members.length, n0, 'a pinch-cancelled marquee deletes nothing');
  eq(B.marquee, null, 'a cancelled marquee is cleared');

  // ---- tap with the tool armed = single-member erase ----------------------
  arm();
  changes = [];
  const m0 = design.members.length;
  tap(27.5, 5.5);
  eq(design.members.length, m0 - 1, 'a tap with the box tool erases the member under it');
  eq(changes.length, 1, 'the tap erase emits one design:change');
  eq(changes[0].id, ids[1], 'the tap erase names the single member it took');
  ok(builder.undo(), 'the tap erase is one undo step');
  eq(design.members.length, m0, 'the tapped member comes back');

  arm();
  changes = [];
  tap(34, 12);
  eq(design.members.length, m0, 'a tap on empty space with the box tool deletes nothing');
  eq(changes.length, 0, 'and emits nothing');

  // ---- an empty box -------------------------------------------------------
  arm();
  changes = [];
  const emptyBox = boxDrag(34.5, 9, 36, 11);
  eq(emptyBox.hits.length, 0, 'a box over empty space selects nothing');
  eq(design.members.length, m0, 'and deletes nothing');
  eq(changes.length, 0, 'and emits no design:change');

  // ---- the box is abandoned when the tool goes away under the finger ------
  arm();
  down(24, 3.5); move(33, 7.5);
  ok(B.marquee !== null, 'setup: a live marquee is up');
  disarm();
  eq(B.marquee, null, 'switching tools mid-drag drops the marquee');
  up(33, 7.5);
  eq(design.members.length, m0, 'and the release deletes nothing');

  arm();
  down(24, 3.5); move(33, 7.5);
  emit('ui:material', { id: 'steel' });
  eq(B.marquee, null, 'picking a material mid-marquee drops it too');
  eq(B.tool, 'build', 'the material pick left the build tool armed');
  up(33, 7.5);
  eq(design.members.length, m0, 'that release deletes nothing either');
  emit('ui:material', { id: 'timber' });

  // Escape is game.js's "leave the level": it is NOT bound in the builder, and
  // the phase:change it causes is what discards the marquee.
  arm();
  down(24, 3.5); move(33, 7.5);
  ok(B.marquee !== null, 'setup: a live marquee is up again');
  emit('phase:change', { phase: 'levelselect' });
  eq(B.marquee, null, 'leaving the build phase (Escape) discards the marquee');
  S.phase = 'levelselect';
  up(33, 7.5);
  eq(design.members.length, m0, 'Escape deletes nothing');
  S.phase = 'build';

  // ---- phase gate ---------------------------------------------------------
  arm();
  S.phase = 'sim';
  boxDrag(24, 3.5, 33, 7.5);
  eq(design.members.length, m0, 'the box tool does nothing outside the build phase');
  eq(B.marquee, null, 'and leaves no marquee behind');
  S.phase = 'build';
  disarm();
  offChange();
}

// ------------------------------------------------------- 9. editing fuzz ----
// Deterministic pointer fuzz over the WHOLE editing surface (place, erase,
// box-delete, select, right-click, key delete, undo/redo, clear, tool and
// material switches, pinch-cancels, and gestures interrupted mid-drag). The
// point is not any single action but that the seven structural invariants below
// survive every interleaving of them.

section('9. FUZZ — EDITING INVARIANTS');
{
  const S = getScene();
  const L = level({ budget: 2000 });
  const design = emptyDesign();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.camera = { zoom: 14 };
  S.structure = null; S.water = null; S.simTime = 0;
  const B = builder.getBuilder();

  const Z = 14;
  const px = (x) => x * Z, py = (y) => -y * Z;
  const down = (x, y, button) =>
    emit('input:down', { x, y, px: px(x), py: py(y), id: 1, button: button || 0, cancel: false });
  const move = (x, y) =>
    emit('input:move', { x, y, px: px(x), py: py(y), id: 1, button: 0, cancel: false, hover: false });
  const up = (x, y, cancel, button) =>
    emit('input:up', { x, y, px: px(x), py: py(y), id: 1, button: button || 0, cancel: !!cancel });

  // mulberry32: same seeds → same run, forever
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const INV = [
    'every member points at two live nodes',
    'no orphan node survives a completed gesture',
    'node and member ids stay unique',
    'the selection is null or a live member',
    'the design never costs more than the budget',
    'every node coordinate stays finite',
    'the marquee is null and empty whenever no drag is live',
  ];
  const viol = INV.map(() => 0);
  const witness = INV.map(() => '');

  function check(where) {
    const nodeIds = new Set(design.nodes.map((n) => n.id));
    const bad = [
      design.members.some((m) => !nodeIds.has(m.a) || !nodeIds.has(m.b)),
      design.nodes.some((n) => !design.members.some((m) => m.a === n.id || m.b === n.id)),
      nodeIds.size !== design.nodes.length ||
        new Set(design.members.map((m) => m.id)).size !== design.members.length,
      !!B.selection && !design.members.some((m) => m.id === B.selection),
      builder.designCost(design) > L.budget + CONFIG.build.budgetEps,
      design.nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)),
      !!B.marquee || B.marqueeHits.length > 0,
    ];
    for (let i = 0; i < bad.length; i++) {
      if (bad[i]) { viol[i]++; if (!witness[i]) witness[i] = where; }
    }
  }

  let boxDeleted = 0, singleDeleted = 0, placed = 0;
  const offChange = on('design:change', (e) => {
    if (e.action === 'place') placed++;
    else if (e.id === null) boxDeleted += e.count || 0;
    else singleDeleted++;
  });

  const SEEDS = [1, 7, 1337, 90210];
  const ACTIONS = 260;
  for (const seed of SEEDS) {
    const r = rng(seed);
    const X = () => 23 + r() * 12;          // straddles the 24..34 build zone
    const Y = () => 3 + r() * 6;
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);

    for (let step = 0; step < ACTIONS; step++) {
      const pick = r();
      const where = `seed ${seed} step ${step}`;

      if (pick < 0.30) {                    // place a member
        const x0 = X(), y0 = Y();
        down(x0, y0); move(x0 + (r() - 0.5) * 6, y0 + (r() - 0.5) * 6);
        const x1 = x0 + (r() - 0.5) * 6, y1 = y0 + (r() - 0.5) * 6;
        move(x1, y1); up(x1, y1, r() < 0.08);
      } else if (pick < 0.42) {             // box-delete drag
        builder.setTool('boxdelete');
        const x0 = X(), y0 = Y(), x1 = X(), y1 = Y();
        down(x0, y0); move((x0 + x1) / 2, (y0 + y1) / 2); move(x1, y1);
        up(x1, y1, r() < 0.15);
        builder.setTool('build');
      } else if (pick < 0.50) {             // box-delete tap (single erase)
        builder.setTool('boxdelete');
        const x = X(), y = Y();
        down(x, y); up(x, y);
        builder.setTool('build');
      } else if (pick < 0.56) {             // marquee abandoned mid-drag
        builder.setTool('boxdelete');
        const x0 = X(), y0 = Y();
        down(x0, y0); move(X(), Y());
        if (r() < 0.5) emit('input:key', { key: 'x' });
        else emit('input:key', { key: 'Delete' });
        const x1 = X(), y1 = Y();
        up(x1, y1);
        builder.setTool('build');
      } else if (pick < 0.64) {             // eraser drag
        builder.setTool('erase');
        const x0 = X(), y0 = Y(), x1 = X(), y1 = Y();
        down(x0, y0); move(x1, y1); up(x1, y1);
        builder.setTool('build');
      } else if (pick < 0.72) {             // tap: select / clear
        const x = X(), y = Y();
        down(x, y); up(x, y);
      } else if (pick < 0.78) {             // right-click delete
        const x = X(), y = Y();
        down(x, y, 2); up(x, y, false, 2);
      } else if (pick < 0.84) {             // key delete of the selection
        emit('input:key', { key: r() < 0.5 ? 'Delete' : 'Backspace' });
      } else if (pick < 0.92) {             // undo / redo
        emit('input:key', { key: r() < 0.6 ? 'z' : 'Z' });
      } else if (pick < 0.95) {             // clear everything
        builder.clearDesign();
      } else {                              // tool / material churn
        const keys = ['x', 'e', 'b', '1', '2', '3', '4', 'X', 'E'];
        emit('input:key', { key: keys[Math.floor(r() * keys.length)] });
        builder.setTool('build');
      }

      check(where);
    }

    // unwinding the whole history must stay just as clean
    let guard = 0;
    while (builder.undo() && guard++ < 500) check(`seed ${seed} undo`);
    check(`seed ${seed} fully undone`);
    while (builder.redo() && guard++ < 1000) check(`seed ${seed} redo`);
  }
  offChange();
  builder.setTool('build');

  const runs = SEEDS.length * ACTIONS;
  for (let i = 0; i < INV.length; i++) {
    ok(viol[i] === 0, `fuzz invariant ${i + 1}: ${INV[i]}`,
      `${viol[i]} violations (first at ${witness[i]})`);
  }
  ok(boxDeleted > 0 && singleDeleted > 0 && placed > 0,
    `the fuzz actually exercised the editor (${placed} placed, ${boxDeleted} boxed away, ` +
    `${singleDeleted} erased singly over ${runs} actions across ${SEEDS.length} seeds)`);
  ok(builder.canUndo() || builder.canRedo() || design.members.length === 0,
    'the fuzz leaves a coherent history');
}
// ------------------------------------------ 10. TOUCH BUILDING v3 (press) ---
// PRESS-ADJUST-LIFT. Every touch press with the build tool previews at the
// SNAPPED FINGERTIP, sliding re-snaps the preview, and the LIFT commits —
// nothing changes mid-gesture, ever. A committed lift leaves a CHAIN HEAD, so a
// run of beams is tap-tap-tap, and a tap on the head itself finishes it.
// (v2.4's offset cursor and deferred start are gone; so is selection on touch
// with the build tool — every build press is a placement.)
//
// These tests drive a phone-shaped screen so the px thresholds
// (CONFIG.touch.tapMaxPx / holdSlopPx) mean what they mean on glass.

section('10. TOUCH BUILDING v3 — PRESS-ADJUST-LIFT + CHAINS');
{
  const T = CONFIG.touch;
  const S = getScene();
  const design = emptyDesign();
  const L = level();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.structure = null; S.water = null; S.simTime = 0;

  const Z = 14, W = 500, H = 850, CX = 29, CY = 5;
  S.camera = {
    zoom: Z,
    screenToWorld: (px, py) => [(px - W / 2) / Z + CX, (H / 2 - py) / Z + CY],
  };
  const sx = (x) => (x - CX) * Z + W / 2;         // world → device px
  const sy = (y) => H / 2 - (y - CY) * Z;
  const at = (x, y) => ({ x, y, px: sx(x), py: sy(y) });
  const B = builder.getBuilder();

  const tdown = (f) => emit('input:down', { ...f, id: 1, button: 0, cancel: false, ptype: 'touch' });
  const tmove = (f) => emit('input:move', { ...f, id: 1, button: 0, cancel: false, hover: false, ptype: 'touch' });
  const tup = (f, cancel) => emit('input:up', { ...f, id: 1, button: 0, cancel: !!cancel, ptype: 'touch' });

  // the whole touch vocabulary: a tap, and a press that slides before it lifts
  const tap = (x, y) => { const f = at(x, y); tdown(f); tup(f); };
  const slide = (x0, y0, x1, y1, cancel) => {
    tdown(at(x0, y0)); tmove(at(x1, y1)); tup(at(x1, y1), cancel);
  };

  // mouse/pen on the same screen (no ptype = mouse)
  const put = (x0, y0, x1, y1, ptype) => {
    emit('input:down', { ...at(x0, y0), id: 1, button: 0, cancel: false, ptype });
    emit('input:move', { ...at(x1, y1), id: 1, button: 0, cancel: false, hover: false, ptype });
    emit('input:up', { ...at(x1, y1), id: 1, button: 0, cancel: false, ptype });
  };

  const reset = () => {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
  };
  const nodeAt = (x, y) => design.nodes.find((n) =>
    Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6);

  // ---- A. three taps, two beams: the chain IS the gesture -----------------
  reset();
  {
    tap(27.3, 5.4);                                // open ground
    eq(design.members.length, 0, 'the first tap on open ground builds nothing');
    eq(design.nodes.length, 0, 'and creates no node: an unconnected node is an orphan');
    ok(!!B.chainHead, 'it claims a CHAIN HEAD instead');
    eq(B.chainHead.pending, true, 'which is PENDING — a point, not a design node');
    near(B.chainHead.x, 27.5, 1e-9, 'the head sits at the SNAPPED lift position (x)');
    near(B.chainHead.y, 5.5, 1e-9, '… and y (0.5 m grid, not the raw fingertip)');
    eq(B.ghost, null, 'no preview outlives the press');
    eq(B.drag, null, 'and no drag record either');

    tap(27.6, 7.4);                                // second tap: the first beam
    eq(design.members.length, 1, 'the second tap places a beam from the head');
    eq(design.nodes.length, 2, 'with both endpoints created');
    ok(!!nodeAt(27.5, 5.5) && !!nodeAt(27.5, 7.5), 'between the two snapped tap points');
    eq(B.chainHead.pending, false, 'the head is now a real design node');
    eq(B.chainHead.nodeId, nodeAt(27.5, 7.5).id, 'and it is the endpoint just placed');

    tap(29.4, 7.4);                                // third tap: the second beam
    eq(design.members.length, 2, 'the third tap extends the chain');
    eq(design.nodes.length, 3, 'sharing the joint instead of duplicating it');
    eq(B.chainHead.nodeId, nodeAt(29.5, 7.5).id, 'the head advanced to the new endpoint');
    near(builder.designCost(design), 4 * MATERIALS.timber.costPerMeter, 1e-6,
      'two 2 m timber beams cost what two 2 m timber beams cost');
  }

  // ---- B. the LIFT position is what commits (press-adjust-lift) -----------
  // Everything here stays 3 m clear of the anchors at y = 3: a touch anchor
  // radius is anchorSnap × snapMul = 1.8 m, and this test is about the grid.
  reset();
  {
    tap(26.2, 6.1);                                // head at (26, 6)
    near(B.chainHead.x, 26, 1e-9, 'setup: head on the grid, clear of the anchors');
    tdown(at(26.2, 6.1));
    tmove(at(28.4, 6.1));                          // adjust…
    ok(B.ghost !== null, 'sliding shows a live preview beam');
    near(B.ghost.x1, 28.5, 1e-9, 'whose end follows the snapped fingertip');
    tmove(at(27.4, 7.4));                          // …adjust again
    near(B.ghost.x1, 27.5, 1e-9, 'and re-snaps as the finger keeps moving (x)');
    near(B.ghost.y1, 7.5, 1e-9, '… and y');
    eq(design.members.length, 0, 'nothing is committed mid-gesture');
    tup(at(27.4, 7.4));
    eq(design.members.length, 1, 'the lift commits');
    ok(!!nodeAt(27.5, 7.5), 'at the SNAPPED LIFT position, not where the press started');
    ok(!nodeAt(28.5, 6), 'and not at any position it merely passed through');
  }

  // ---- C. starting a chain from existing work -----------------------------
  reset();
  put(26, 3, 26, 7);                               // a mouse-built upright
  eq(design.members.length, 1, 'setup: one mouse-built beam');
  eq(B.chainHead, null, 'a mouse placement never arms a touch chain');
  {
    // …from an ANCHOR: press on it, slide, lift
    slide(29, 3, 29, 6.5);
    eq(design.members.length, 2, 'a press on an anchor draws a beam from it');
    const anchored = design.nodes.find((n) => n.anchorId === 'a1');
    ok(!!anchored, 'the anchored endpoint carries the anchor id');
    near(anchored.y, 3, 1e-9, 'and sits on the anchor, at the fingertip, unoffset');
    eq(B.chainHead.nodeId, nodeAt(29, 6.5).id, 'the far end became the chain head');
  }
  {
    // …from an existing NODE, with no chain running
    emit('ui:tool', { id: 'erase' });               // ends the chain
    emit('ui:tool', { id: 'build' });
    eq(B.chainHead, null, 'setup: no chain head');
    const before = design.nodes.length;
    slide(26, 7, 27.5, 8.5);
    eq(design.members.length, 3, 'a press on a node draws a beam FROM that node');
    eq(design.nodes.length, before + 1, 'reusing the node instead of duplicating it');
    ok(!!nodeAt(27.5, 8.5), 'and ending at the snapped lift position');
  }
  {
    // …by TAPPING an existing node: it just becomes the head
    emit('ui:tool', { id: 'erase' });
    emit('ui:tool', { id: 'build' });
    const n = nodeAt(26, 3);
    const before = design.members.length;
    tap(26, 3);
    eq(design.members.length, before, 'a tap on an existing joint builds nothing');
    ok(!!B.chainHead && B.chainHead.nodeId === n.id, 'it adopts the joint as the chain head');
    eq(B.chainHead.pending, false, 'a real node, not a pending point');
  }

  // ---- D. ending a chain --------------------------------------------------
  reset();
  {
    tap(26.2, 4.1); tap(26.2, 6.1);                // head at (26, 6)
    eq(design.members.length, 1, 'setup: one beam, chain live');
    const head = B.chainHead;
    tap(26.1, 6.05);                               // tap the head itself
    eq(B.chainHead, null, 'a tap ON the chain head finishes the run');
    eq(design.members.length, 1, 'and builds nothing');
    eq(design.nodes.length, 2, 'and leaves no stray node');
    ok(head !== null, 'setup sanity: there had been a head to tap');
  }
  {
    tap(28.2, 4.1);
    ok(!!B.chainHead, 'setup: a fresh chain head');
    emit('ui:tool', { id: 'erase' });
    eq(B.chainHead, null, 'switching tools ends the chain');
    emit('ui:tool', { id: 'build' });

    tap(28.2, 4.1);
    ok(!!B.chainHead, 'setup: another chain head');
    emit('ui:material', { id: 'steel' });
    ok(!!B.chainHead, 'picking a material does NOT end it (still building)');
    emit('ui:material', { id: 'timber' });

    emit('ui:tool', { id: 'build' });
    eq(B.chainHead, null, 'pressing the BUILD button ends it too (the escape hatch)');
    eq(B.tool, 'build', 'and leaves the build tool armed');

    emit('phase:change', { phase: 'sim' });
    eq(B.chainHead, null, 'leaving the build phase ends the chain');
    S.phase = 'build';
  }
  {
    const members = design.members.length, nodes = design.nodes.length;
    tap(30.2, 6.1);
    const head = B.chainHead;
    slide(30.2, 6.1, 30.2, 8.1, true);             // pinch-cancel
    eq(design.members.length, members, 'a pinch-cancelled press commits nothing');
    eq(design.nodes.length, nodes, 'and creates no node');
    eq(B.ghost, null, 'and clears the preview');
    ok(B.chainHead === head, 'and the chain survives it, unchanged');
  }

  // ---- E. an invalid lift refuses, hints, and keeps the chain -------------
  reset();
  {
    tap(26.2, 6.1);                                // head at (26, 6)
    const head = B.chainHead;
    tap(33.4, 6.1);                                // 7.5 m of timber: too long
    eq(design.members.length, 0, 'an over-length lift places nothing');
    eq(builder.getHint(), 'too long', 'and says why');
    ok(B.chainHead === head, 'and the chain head is exactly where it was');

    tap(23.4, 6);                                  // outside the 24..34 zone
    eq(design.members.length, 0, 'a lift outside the build zone places nothing');
    eq(builder.getHint(), 'outside build zone', 'and says that instead');
    ok(B.chainHead === head, 'the chain still survives');

    tap(28.2, 6.1);                                // …and a legal one still works
    eq(design.members.length, 1, 'a legal lift right after a refusal still builds');
    ok(!!nodeAt(28, 6), 'at the point it was aimed at');
  }

  // ---- F. touch snapping is STRONGER than mouse snapping ------------------
  reset();
  put(28, 6, 28, 3);                               // free node at (28, 6)
  {
    const target = nodeAt(28, 6);
    ok(!!target, 'setup: a free node at (28, 6)');
    ok(B.chainNodeId !== target.id, 'setup: it is not the chain node (no radius bonus)');
    near(CONFIG.build.nodeSnap * T.snapMul, 1.2, 1e-9,
      `setup: touch node radius is ${CONFIG.build.nodeSnap} × ${T.snapMul} m`);

    tdown(at(29, 6));                              // exactly 1.0 m away
    eq(B.hover.snap.kind, 'node', 'a touch press 1.0 m from a node snaps ONTO it');
    eq(B.hover.snap.nodeId, target.id, 'and names that node');
    tup(at(29, 6));

    emit('input:down', { ...at(29, 6), id: 1, button: 0, cancel: false });
    eq(B.drag.start.kind, 'grid', 'a MOUSE press at the same point stays on the grid');
    emit('input:up', { ...at(29, 6), id: 1, button: 0, cancel: false });

    near(CONFIG.build.gridSnap, 0.5, 1e-9, 'and the grid itself is untouched by snapMul');
  }

  // ---- G. the build tool never selects on touch --------------------------
  reset();
  put(26, 4, 29, 4);
  {
    builder.getBuilder().selection = null;
    eq(design.members.length, 1, 'setup: one beam to (not) select');
    tap(27.5, 4.2);
    eq(builder.getSelection(), null, 'a touch press on a beam selects nothing');
    ok(!!B.chainHead, 'it is a placement gesture like any other');
    // the mouse still selects, exactly as before
    B.chainHead = null;
    emit('input:down', { ...at(27.5, 4.2), id: 1, button: 0, cancel: false });
    emit('input:up', { ...at(27.5, 4.2), id: 1, button: 0, cancel: false });
    eq(builder.getSelection(), design.members[0].id, 'a MOUSE tap still selects it');
  }

  // ---- H. erase and box-delete keep the raw fingertip --------------------
  reset();
  put(26, 4, 29, 4);
  eq(design.members.length, 1, 'setup: one beam to delete');
  {
    emit('ui:tool', { id: 'erase' });
    tap(27.5, 4);
    eq(design.members.length, 0, 'a touch erase deletes what the FINGER is on');
    builder.undo();
    eq(design.members.length, 1, 'setup: the beam is back');
    emit('ui:tool', { id: 'build' });
  }
  {
    emit('ui:tool', { id: 'boxdelete' });
    tdown(at(25, 3.5));
    tmove(at(30, 4.5));
    ok(B.marquee !== null, 'setup: the marquee is live');
    near(B.marquee.y0, 3.5, 1e-9, 'built from raw finger coords (y0)');
    near(B.marquee.y1, 4.5, 1e-9, '… and y1');
    tup(at(30, 4.5));
    eq(design.members.length, 0, 'and the box deletes what it was drawn around');
    emit('ui:tool', { id: 'build' });
  }

  // ---- I. mouse and pen are untouched -------------------------------------
  reset();
  {
    emit('input:down', { ...at(26, 3), id: 1, button: 0, cancel: false });
    emit('input:move', { ...at(26, 7), id: 1, button: 0, cancel: false, hover: false });
    ok(B.ghost !== null, 'a mouse drag draws its ghost from the very first move');
    near(B.ghost.y0, 3, 1e-9, 'the mouse start is committed at pointer-down, unchanged');
    emit('input:up', { ...at(26, 7), id: 1, button: 0, cancel: false });
    eq(design.members.length, 1, 'the mouse places on release exactly as before');
    near(design.nodes.find((n) => n.anchorId === 'a0').y, 3, 1e-9, 'at the raw pointer position');
    eq(B.chainHead, null, 'and arms no chain (a mouse-only session never sees one)');
  }
  reset();
  {
    put(26, 3, 26, 7, 'pen');
    eq(design.members.length, 1, 'a pen drag places a beam');
    eq(B.chainHead, null, 'and gets no chain either (it points at what it touches)');
    const ys = design.nodes.map((n) => n.y).sort((m, n) => m - n);
    near(ys[0], 3, 1e-9, 'a pen beam starts at the raw pen position');
    near(ys[1], 7, 1e-9, 'and ends there too');
  }
  reset();
}

// --------------------------------------------------- 11. NODE DRAGGING ------
// Press-and-HOLD on an existing design node (CONFIG.touch.holdMs, travel under
// holdSlopPx) LIFTS it: it follows the snapped pointer, every attached member
// follows live with validity checking, and the release either commits the move
// as ONE undo step or reverts the whole thing. Mouse and touch both.

section('11. NODE DRAGGING — HOLD TO LIFT');
{
  const T = CONFIG.touch;
  const S = getScene();
  const design = emptyDesign();
  const L = level();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.structure = null; S.water = null; S.simTime = 0;

  const Z = 14, W = 500, H = 850, CX = 29, CY = 5;
  S.camera = {
    zoom: Z,
    screenToWorld: (px, py) => [(px - W / 2) / Z + CX, (H / 2 - py) / Z + CY],
  };
  const sx = (x) => (x - CX) * Z + W / 2;
  const sy = (y) => H / 2 - (y - CY) * Z;
  const at = (x, y) => ({ x, y, px: sx(x), py: sy(y) });
  const B = builder.getBuilder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HOLD = T.holdMs + 30;

  const down = (f, ptype) => emit('input:down', { ...f, id: 1, button: 0, cancel: false, ptype });
  const move = (f, ptype) => emit('input:move', { ...f, id: 1, button: 0, cancel: false, hover: false, ptype });
  const up = (f, cancel, ptype) => emit('input:up', { ...f, id: 1, button: 0, cancel: !!cancel, ptype });
  const put = (x0, y0, x1, y1) => {
    down(at(x0, y0)); move(at(x1, y1)); up(at(x1, y1));
  };
  const nodeAt = (x, y) => design.nodes.find((n) =>
    Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6);
  const memberLen = (m) => {
    const a = design.nodes.find((n) => n.id === m.a), b = design.nodes.find((n) => n.id === m.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  // Two beams meeting at a free joint: dragging that joint has to move both.
  const setup = () => {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
    put(26, 3, 28, 6);        // anchor a0 → free joint
    put(29, 3, 28, 6);        // anchor a1 → the same joint
    emit('ui:tool', { id: 'erase' });    // clear any chain state
    emit('ui:tool', { id: 'build' });
  };

  setup();
  eq(design.members.length, 2, 'setup: two beams meeting at (28, 6)');
  eq(design.nodes.length, 3, 'setup: three nodes');

  // ---- A. a slide under the hold is NOT a lift ----------------------------
  {
    down(at(28, 6), 'touch');
    move(at(28.9, 6), 'touch');                    // 12.6 px > holdSlopPx (10)
    eq(B.nodeDrag, null, 'moving past holdSlopPx before holdMs is a slide, not a lift');
    await sleep(HOLD);
    move(at(30, 6), 'touch');
    eq(B.nodeDrag, null, 'and waiting afterwards does not retro-lift it');
    ok(B.ghost !== null, 'the gesture stayed a beam-drawing press');
    up(at(30, 6), true, 'touch');                  // cancel: keep the fixture
    eq(design.members.length, 2, 'setup intact');
  }

  // ---- B. holding still, then moving, LIFTS the node ---------------------
  {
    const n = nodeAt(28, 6);
    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(28.2, 6.1), 'touch');                  // first move after the hold
    ok(B.nodeDrag !== null, 'a press held past holdMs lifts the node it is on');
    eq(B.nodeDrag.nodeId, n.id, 'the lifted node is the one under the finger');
    eq(B.nodeDrag.touch, true, 'and it knows it is a touch drag (loupe + snapMul)');
    eq(B.ghost, null, 'no beam ghost while a node is in the air');

    const lens = design.members.map(memberLen);
    move(at(28.4, 6.9), 'touch');                  // 4.7 m / 4.0 m: still legal
    near(B.nodeDrag.x, 28.5, 1e-9, 'the lifted node follows the SNAPPED pointer (x)');
    near(B.nodeDrag.y, 7, 1e-9, '… and y');
    near(n.x, 28.5, 1e-9, 'the design node itself moves, so the members follow (x)');
    near(n.y, 7, 1e-9, '… and y');
    design.members.forEach((m, i) => {
      ok(Math.abs(memberLen(m) - lens[i]) > 0.2,
        'attached member ' + m.id + ' recomputed with the joint',
        `${lens[i].toFixed(2)} → ${memberLen(m).toFixed(2)} m`);
    });
    eq(B.nodeDrag.ok, true, 'the drop is legal');

    const undos = B.undo.length;
    up(at(28.4, 6.9), false, 'touch');
    eq(B.nodeDrag, null, 'the release clears the lift');
    near(nodeAt(28.5, 7).x, 28.5, 1e-9, 'the node stays where it was dropped');
    eq(B.undo.length, undos + 1, 'and the whole move is ONE undo step');
    eq(design.members.length, 2, 'no member was harmed');

    ok(builder.undo(), 'that step undoes');
    ok(!!nodeAt(28, 6), 'the node is back where it started');
    eq(design.members.length, 2, 'with both beams intact');
    eq(design.nodes.length, 3, 'and no node lost or gained');
  }

  // ---- C. anchors gained and lost -----------------------------------------
  // Its own fixture: one beam whose free end can actually REACH the anchor at
  // (32, 3) without stretching the timber past its 5 m span.
  {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
    put(30, 6, 32, 6);
    eq(design.members.length, 1, 'setup: one horizontal beam, both ends free');
    eq(nodeAt(32, 6).anchorId, null, 'setup: the end to drag is unanchored');

    down(at(32, 6), 'touch');
    await sleep(HOLD);
    move(at(31.9, 3.1), 'touch');                  // anchor a2 sits at (32, 3)
    eq(B.nodeDrag.anchorId, 'a2', 'dropping a free node on an anchor claims it');
    eq(B.nodeDrag.ok, true, 'and that drop is legal');
    up(at(31.9, 3.1), false, 'touch');
    const moved = nodeAt(32, 3);
    ok(!!moved, 'the node snapped exactly onto the anchor');
    eq(moved.anchorId, 'a2', 'and kept the anchor id after the commit');

    down(at(32, 3), 'touch');
    await sleep(HOLD);
    move(at(30.4, 4.6), 'touch');
    eq(B.nodeDrag.anchorId, null, 'dragging it back off the anchor drops the anchor id');
    up(at(30.4, 4.6), false, 'touch');
    const freed = nodeAt(30.5, 4.5);
    ok(!!freed, 'the node committed at the grid point it was dropped on');
    eq(freed.anchorId, null, 'as a free node again');
  }

  // ---- D. an illegal drop reverts, whole ----------------------------------
  {
    setup();
    const n = nodeAt(28, 6);
    const before = design.nodes.map((q) => ({ id: q.id, x: q.x, y: q.y, a: q.anchorId }));
    const undos = B.undo.length;
    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(33.5, 9), 'touch');                    // 7+ m from both anchors
    eq(B.nodeDrag.ok, false, 'a drop that stretches timber past maxLength is refused');
    eq(B.nodeDrag.reason, 'too long', 'and says why');
    up(at(33.5, 9), false, 'touch');
    eq(builder.getHint(), 'too long', 'the refusal reaches the HUD hint');
    eq(B.undo.length, undos, 'an illegal move is not history');
    for (const q of before) {
      const live = design.nodes.find((z) => z.id === q.id);
      ok(!!live && live.x === q.x && live.y === q.y && (live.anchorId || null) === q.a,
        'node ' + q.id + ' is exactly where it was before the lift');
    }
  }
  {
    // outside the build zone is refused the same way
    setup();
    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(23.5, 5), 'touch');                    // zone is 24..34
    eq(B.nodeDrag.ok, false, 'a drop outside the build zone is refused');
    eq(B.nodeDrag.reason, 'outside build zone', 'with the zone reason');
    up(at(23.5, 5), false, 'touch');
    ok(!!nodeAt(28, 6), 'and the node goes home');
  }
  {
    // …and so is a drop straight on top of another joint (the drag does not
    // snap to nodes, so this is the one overlap it has to catch itself)
    setup();
    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(26, 3), 'touch');                      // the anchored node's spot
    eq(B.nodeDrag.ok, false, 'a drop on top of another joint is refused');
    eq(B.nodeDrag.reason, 'another joint there', 'and says so');
    up(at(26, 3), false, 'touch');
    ok(!!nodeAt(28, 6), 'the joint goes home');
    eq(design.nodes.length, 3, 'and no coincident pair was created');
  }
  {
    // Over budget from GROWN lengths. $190 buys the fixture with $18 to spare,
    // and the move stretches both beams (steel is the expensive one) by $65 —
    // while keeping every span well inside its material's limit, so the refusal
    // can only be the budget.
    const tight = level({ budget: 190 });
    S.level = tight;
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(tight, TERRAIN, design);
    put(26, 3, 28, 5);                             // 2.83 m timber = $42
    eq(design.members.length, 1, 'setup: one cheap beam under a $190 budget');
    emit('ui:material', { id: 'steel' });
    put(29, 3, 28, 5);                             // 2.24 m steel = $130
    eq(design.members.length, 2, 'setup: plus an expensive one');
    emit('ui:material', { id: 'timber' });
    ok(builder.budgetLeft() < 20, `setup: almost nothing left ($${builder.budgetLeft().toFixed(0)})`);
    down(at(28, 5), 'touch');
    await sleep(HOLD);
    move(at(28.1, 5.9), 'touch');                  // grows both beams
    eq(B.nodeDrag.ok, false, 'a move that grows the design past the budget is refused');
    eq(B.nodeDrag.reason, 'over budget', 'and names the budget');
    up(at(28.1, 5.9), false, 'touch');
    ok(!!nodeAt(28, 5), 'the joint reverts');
    ok(builder.designCost(design) <= tight.budget + CONFIG.build.budgetEps,
      'and the design still fits the budget');
    S.level = L;
  }

  // ---- E. interruptions never commit -------------------------------------
  {
    setup();
    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(28.5, 7), 'touch');
    ok(B.nodeDrag !== null, 'setup: a node is in the air');
    up(at(28.5, 7), true, 'touch');                // pinch-cancel
    eq(B.nodeDrag, null, 'a pinch-cancel ends the lift');
    ok(!!nodeAt(28, 6), 'and puts the node back');

    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(28.5, 7), 'touch');
    emit('phase:change', { phase: 'sim' });
    eq(B.nodeDrag, null, 'a phase change ends the lift');
    ok(!!nodeAt(28, 6), 'and puts the node back');
    S.phase = 'build';
    up(at(28.5, 7), false, 'touch');
    ok(!!nodeAt(28, 6), 'the stale release changes nothing');

    down(at(28, 6), 'touch');
    await sleep(HOLD);
    move(at(28.5, 7), 'touch');
    emit('ui:tool', { id: 'erase' });
    eq(B.nodeDrag, null, 'switching tools ends the lift');
    ok(!!nodeAt(28, 6), 'and puts the node back');
    emit('ui:tool', { id: 'build' });
    up(at(28.5, 7), false, 'touch');
  }

  // ---- F. the MOUSE lifts nodes too --------------------------------------
  {
    setup();
    const n = nodeAt(28, 6);
    emit('input:down', { ...at(28, 6), id: 1, button: 0, cancel: false });
    await sleep(HOLD);
    emit('input:move', { ...at(29, 7), id: 1, button: 0, cancel: false, hover: false });
    ok(B.nodeDrag !== null, 'a mouse press held on a node lifts it as well');
    eq(B.nodeDrag.touch, false, 'and knows it is not a touch drag');
    near(B.nodeDrag.x, 29, 1e-9, 'it follows the snapped mouse');
    emit('input:up', { ...at(29, 7), id: 1, button: 0, cancel: false });
    ok(!!nodeAt(29, 7), 'and the mouse move commits');
    ok(builder.undo() && !!nodeAt(28, 6), 'one undo brings it home');
  }

  // ---- G. the chain head follows the node it names -----------------------
  {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
    const tap = (x, y) => {
      const f = at(x, y);
      emit('input:down', { ...f, id: 1, button: 0, cancel: false, ptype: 'touch' });
      emit('input:up', { ...f, id: 1, button: 0, cancel: false, ptype: 'touch' });
    };
    tap(26, 3); tap(26, 6);                        // beam a0 → (26, 6), head there
    eq(design.members.length, 1, 'setup: a touch-built beam');
    const head = B.chainHead;
    eq(head.nodeId, nodeAt(26, 6).id, 'setup: the head is the free endpoint');

    down(at(26, 6), 'touch');
    await sleep(HOLD);
    move(at(27, 6.5), 'touch');
    eq(B.nodeDrag.nodeId, head.nodeId, 'holding the head lifts it like any node');
    up(at(27, 6.5), false, 'touch');
    near(B.chainHead.x, 27, 1e-9, 'after the move the head is where the node is (x)');
    near(B.chainHead.y, 6.5, 1e-9, '… and y');
    eq(B.chainHead.nodeId, head.nodeId, 'still naming the same node');

    // a reverted move leaves the head where the node stayed
    down(at(27, 6.5), 'touch');
    await sleep(HOLD);
    move(at(33.9, 9.4), 'touch');                  // too long
    eq(B.nodeDrag.ok, false, 'setup: an illegal drop');
    up(at(33.9, 9.4), false, 'touch');
    near(B.chainHead.x, 27, 1e-9, 'a reverted move leaves the head with its node (x)');
    near(B.chainHead.y, 6.5, 1e-9, '… and y');

    // and a head whose node dies is dropped
    builder.getBuilder().selection = design.members[0].id;
    builder.deleteSelection();
    eq(design.members.length, 0, 'setup: the beam is deleted');
    eq(B.chainHead, null, 'a chain head whose node is gone is dropped');
  }

  // ---- H. a chain press on a node still draws a beam if it does not hold --
  {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
    put(26, 3, 26, 6);
    emit('ui:tool', { id: 'erase' }); emit('ui:tool', { id: 'build' });
    down(at(26, 6), 'touch');
    move(at(28, 7), 'touch');                      // straight away: a slide
    eq(B.nodeDrag, null, 'a press that slides immediately never lifts the node');
    ok(B.ghost !== null, 'it draws a beam instead');
    up(at(28, 7), false, 'touch');
    eq(design.members.length, 2, 'and the lift places it');
    ok(!!nodeAt(26, 6), 'the joint it started from did not move');
  }
}

// ------------------------------------------------ 12. TOUCH GESTURE FUZZ ----
// Section 9 fuzzes the mouse editing surface. This one interleaves the touch
// vocabulary of v3 — press-adjust-lift chains, head taps, pinch-cancels and
// held node drags (legal and illegal) — with the mouse actions, the delete
// tools and undo/redo, and holds the same seven structural invariants plus
// three about the new state: no preview outlives its gesture, the chain head is
// always either null / pending / a live node, and no chain survives a phase
// change.

section('12. FUZZ — TOUCH GESTURES + NODE DRAGS');
{
  const T = CONFIG.touch;
  const S = getScene();
  const L = level({ budget: 2000 });
  const design = emptyDesign();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.structure = null; S.water = null; S.simTime = 0;
  const B = builder.getBuilder();

  const Z = 14, W = 500, H = 850, CX = 29, CY = 5;
  S.camera = {
    zoom: Z,
    screenToWorld: (px, py) => [(px - W / 2) / Z + CX, (H / 2 - py) / Z + CY],
  };
  const sx = (x) => (x - CX) * Z + W / 2;
  const sy = (y) => H / 2 - (y - CY) * Z;
  const at = (x, y) => ({ x, y, px: sx(x), py: sy(y) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const down = (f, button, ptype) =>
    emit('input:down', { ...f, id: 1, button: button || 0, cancel: false, ptype });
  const move = (f, ptype) =>
    emit('input:move', { ...f, id: 1, button: 0, cancel: false, hover: false, ptype });
  const up = (f, cancel, button, ptype) =>
    emit('input:up', { ...f, id: 1, button: button || 0, cancel: !!cancel, ptype });

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const INV = [
    'every member points at two live nodes',
    'no orphan node survives a completed gesture',
    'node and member ids stay unique',
    'the selection is null or a live member',
    'the design never costs more than the budget',
    'every node coordinate stays finite',
    'the marquee is null and empty whenever no drag is live',
    'no preview (drag, ghost, lifted node) outlives its gesture',
    'the chain head is null, pending, or a live design node — always finite',
    'no two nodes ever end up in the same place',
  ];
  const viol = INV.map(() => 0);
  const witness = INV.map(() => '');

  function check(where) {
    const nodeIds = new Set(design.nodes.map((n) => n.id));
    const h = B.chainHead;
    const bad = [
      design.members.some((m) => !nodeIds.has(m.a) || !nodeIds.has(m.b)),
      design.nodes.some((n) => !design.members.some((m) => m.a === n.id || m.b === n.id)),
      nodeIds.size !== design.nodes.length ||
        new Set(design.members.map((m) => m.id)).size !== design.members.length,
      !!B.selection && !design.members.some((m) => m.id === B.selection),
      builder.designCost(design) > L.budget + CONFIG.build.budgetEps,
      design.nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)),
      !!B.marquee || B.marqueeHits.length > 0,
      !!B.drag || !!B.ghost || !!B.nodeDrag,
      !!h && (!Number.isFinite(h.x) || !Number.isFinite(h.y) ||
        (h.pending ? !!h.nodeId : !nodeIds.has(h.nodeId))),
      design.nodes.some((a, i) => design.nodes.some((b, j) =>
        j > i && Math.hypot(a.x - b.x, a.y - b.y) <= CONFIG.build.mergeEps)),
    ];
    for (let i = 0; i < bad.length; i++) {
      if (bad[i]) { viol[i]++; if (!witness[i]) witness[i] = where; }
    }
  }

  let touchPlaced = 0, mousePlaced = 0, deleted = 0, movedNodes = 0;
  let inTouch = false;
  const offChange = on('design:change', (e) => {
    if (e.action === 'move') { movedNodes++; return; }
    if (e.action !== 'place') { deleted += e.count || 1; return; }
    if (inTouch) touchPlaced++; else mousePlaced++;
  });
  let headTaps = 0, chainsStarted = 0, lifts = 0, badDrops = 0, cancels = 0;

  const SEEDS = [3, 11, 2024, 65535];
  const ACTIONS = 240;
  for (const seed of SEEDS) {
    const r = rng(seed);
    const X = () => 23 + r() * 12;              // straddles the 24..34 build zone
    const Y = () => 3 + r() * 6;
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);

    for (let step = 0; step < ACTIONS; step++) {
      const pick = r();
      const where = `seed ${seed} step ${step}`;
      inTouch = false;

      if (pick < 0.34) {                        // TOUCH: press · adjust · lift
        inTouch = true;
        const had = !!B.chainHead;
        const x0 = X(), y0 = Y();
        down(at(x0, y0), 0, 'touch');
        if (r() < 0.6) move(at(x0 + (r() - 0.5) * 6, y0 + (r() - 0.5) * 6), 'touch');
        const x1 = x0 + (r() - 0.5) * 5, y1 = y0 + (r() - 0.5) * 5;
        if (r() < 0.5) move(at(x1, y1), 'touch');
        const cancel = r() < 0.08;
        if (cancel) cancels++;
        up(at(x1, y1), cancel, 0, 'touch');
        if (!had && B.chainHead) chainsStarted++;
      } else if (pick < 0.44) {                 // TOUCH: tap exactly on the head
        inTouch = true;
        const h = B.chainHead;
        const f = h ? at(h.x, h.y) : at(X(), Y());
        down(f, 0, 'touch');
        up(f, false, 0, 'touch');
        if (h && !B.chainHead) headTaps++;
      } else if (pick < 0.47) {                 // TOUCH: held NODE DRAG
                                                // (rarer than the rest on
                                                // purpose: each one has to wait
                                                // out a real holdMs, and the
                                                // hold has its own section)
        inTouch = true;
        const nodes = design.nodes;
        if (nodes.length) {
          const n = nodes[Math.floor(r() * nodes.length)];
          down(at(n.x, n.y), 0, 'touch');
          await sleep(T.holdMs + 12);
          move(at(n.x + (r() - 0.5) * 8, n.y + (r() - 0.5) * 8), 'touch');
          if (B.nodeDrag) {
            lifts++;
            if (!B.nodeDrag.ok) badDrops++;
          }
          const f = at(X(), Y());
          const cancel = r() < 0.12;
          if (cancel) cancels++;
          up(f, cancel, 0, 'touch');
        }
      } else if (pick < 0.56) {                 // TOUCH gesture cut short mid-press
        inTouch = true;
        down(at(X(), Y()), 0, 'touch');
        move(at(X(), Y()), 'touch');
        emit('input:key', { key: r() < 0.5 ? 'Delete' : 'z' });
        up(at(X(), Y()), false, 0, 'touch');
      } else if (pick < 0.64) {                 // mouse place (the untouched path)
        const x0 = X(), y0 = Y();
        down(at(x0, y0));
        move(at(x0 + (r() - 0.5) * 6, y0 + (r() - 0.5) * 6));
        const x1 = x0 + (r() - 0.5) * 6, y1 = y0 + (r() - 0.5) * 6;
        move(at(x1, y1));
        up(at(x1, y1), r() < 0.08);
      } else if (pick < 0.70) {                 // box-delete drag, by touch
        builder.setTool('boxdelete');
        const x0 = X(), y0 = Y(), x1 = X(), y1 = Y();
        down(at(x0, y0), 0, 'touch');
        move(at((x0 + x1) / 2, (y0 + y1) / 2), 'touch');
        move(at(x1, y1), 'touch');
        up(at(x1, y1), r() < 0.15, 0, 'touch');
        builder.setTool('build');
      } else if (pick < 0.76) {                 // box-delete tap, by touch
        builder.setTool('boxdelete');
        const f = at(X(), Y());
        down(f, 0, 'touch'); up(f, false, 0, 'touch');
        builder.setTool('build');
      } else if (pick < 0.82) {                 // eraser drag, by touch
        builder.setTool('erase');
        const f0 = at(X(), Y()), f1 = at(X(), Y());
        down(f0, 0, 'touch'); move(f1, 'touch'); up(f1, false, 0, 'touch');
        builder.setTool('build');
      } else if (pick < 0.86) {                 // right-click delete (mouse only)
        const f = at(X(), Y());
        down(f, 2); up(f, false, 2);
      } else if (pick < 0.90) {                 // key delete of the selection
        emit('input:key', { key: r() < 0.5 ? 'Delete' : 'Backspace' });
      } else if (pick < 0.96) {                 // undo / redo
        emit('input:key', { key: r() < 0.6 ? 'z' : 'Z' });
      } else if (pick < 0.98) {                 // clear everything
        builder.clearDesign();
      } else {                                  // tool / material churn
        const keys = ['x', 'e', 'b', '1', '2', '3', '4'];
        emit('input:key', { key: keys[Math.floor(r() * keys.length)] });
        builder.setTool('build');
      }

      inTouch = false;
      check(where);
    }

    // a phase change must strip every trace of a live gesture
    emit('phase:change', { phase: 'sim' });
    ok(B.chainHead === null && B.nodeDrag === null && B.drag === null && B.ghost === null,
      `seed ${seed}: a phase change ends every gesture and the chain`);
    S.phase = 'build';

    let guard = 0;
    while (builder.undo() && guard++ < 500) check(`seed ${seed} undo`);
    check(`seed ${seed} fully undone`);
    while (builder.redo() && guard++ < 1000) check(`seed ${seed} redo`);
  }
  offChange();
  builder.setTool('build');

  for (let i = 0; i < INV.length; i++) {
    ok(viol[i] === 0, `touch fuzz invariant ${i + 1}: ${INV[i]}`,
      `${viol[i]} violations (first at ${witness[i]})`);
  }
  ok(touchPlaced > 0 && chainsStarted > 0,
    `press-adjust-lift built things (${touchPlaced} beams over ${chainsStarted} chains started)`);
  ok(headTaps > 0, `chains were finished by tapping the head (${headTaps} times)`);
  ok(mousePlaced > 0, `the mouse path still built things alongside them (${mousePlaced})`);
  ok(lifts > 0 && movedNodes > 0 && badDrops > 0,
    `nodes were dragged (${lifts} lifted, ${movedNodes} moves committed, ${badDrops} illegal drops)`);
  ok(cancels > 0 && deleted > 0,
    `cancels and deletes were exercised too (${cancels} cancels, ${deleted} members deleted)`);
}

// ---------------------------------------------------------------- summary --

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
