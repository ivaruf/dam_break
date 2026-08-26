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

// ------------------------------------------- 10. TOUCH AIMING v2 (cursor) ---
// A finger has no hover and no point: its first contact blindly commits the
// beam start, under the one spot the player needs to see. Touch aiming v2 gives
// a touch BUILD gesture an offset AIM CURSOR (CONFIG.touch.cursorOffsetPx above
// the fingertip, everything snaps to it) and a DEFERRED START (provisional and
// re-snapping until the cursor has travelled startCommitPx). Mouse, pen, and
// the erase/box-delete tools keep the raw-fingertip behaviour exactly.
//
// These tests need a camera that really unprojects: sections 5–9 drive px/py as
// -y·Z, which is fine for travel thresholds but meaningless as a screen
// coordinate, and "56 px above the finger" only means something on a real one.

section('10. TOUCH AIMING v2 — OFFSET CURSOR + DEFERRED START');
{
  const T = CONFIG.touch;
  const S = getScene();
  const design = emptyDesign();
  const L = level();
  S.phase = 'build'; S.level = L; S.terrain = TERRAIN; S.design = design;
  S.structure = null; S.water = null; S.simTime = 0;

  // phone-shaped canvas, dpr 1 (no DOM headless → CSS px == device px)
  const Z = 14, W = 500, H = 850, CX = 29, CY = 5;
  S.camera = {
    zoom: Z,
    screenToWorld: (px, py) => [(px - W / 2) / Z + CX, (H / 2 - py) / Z + CY],
  };
  const sx = (x) => (x - CX) * Z + W / 2;         // world → device px
  const sy = (y) => H / 2 - (y - CY) * Z;
  const OFF = T.cursorOffsetPx;
  const B = builder.getBuilder();

  // a finger that puts the CURSOR on world (x, y) …
  const aimAt = (x, y) => {
    const px = sx(x), py = sy(y) + OFF;
    const [wx, wy] = S.camera.screenToWorld(px, py);
    return { x: wx, y: wy, px, py };
  };
  // … and a finger that is itself on world (x, y)
  const fingerAt = (x, y) => ({ x, y, px: sx(x), py: sy(y) });

  const tdown = (f) => emit('input:down', { ...f, id: 1, button: 0, cancel: false, ptype: 'touch' });
  const tmove = (f) => emit('input:move', { ...f, id: 1, button: 0, cancel: false, hover: false, ptype: 'touch' });
  const tup = (f, cancel) => emit('input:up', { ...f, id: 1, button: 0, cancel: !!cancel, ptype: 'touch' });

  // mouse/pen driver on the same camera (no ptype = mouse)
  const put = (x0, y0, x1, y1, ptype) => {
    const a = fingerAt(x0, y0), b = fingerAt(x1, y1);
    emit('input:down', { ...a, id: 1, button: 0, cancel: false, ptype });
    emit('input:move', { ...b, id: 1, button: 0, cancel: false, hover: false, ptype });
    emit('input:up', { ...b, id: 1, button: 0, cancel: false, ptype });
  };

  const reset = () => {
    design.nodes.length = 0; design.members.length = 0;
    builder.startLevel(L, TERRAIN, design);
  };

  // ---- A. the cursor floats above the finger, and IT is what snaps ---------
  reset();
  {
    const f = aimAt(26, 3);                        // anchor a0 sits at (26, 3)
    tdown(f);
    ok(B.touchAim !== null, 'a touch build gesture publishes B.touchAim on down');
    eq(B.touchAim.aiming, true, 'the gesture opens in the aiming state');
    near(B.touchAim.px, f.px, 1e-9, 'the cursor keeps the finger x');
    near(B.touchAim.py, f.py - OFF, 1e-9, 'the cursor floats cursorOffsetPx ABOVE the finger');
    ok(B.touchAim.py < f.py, 'the cursor is above the finger in screen space');
    near(B.touchAim.x, 26, 1e-9, 'the cursor world x is where the player is aiming');
    near(B.touchAim.y, 3, 1e-9, 'the cursor world y is where the player is aiming');
    near(f.y, 3 - OFF / Z, 1e-9, 'the FINGER itself is a whole ' + (OFF / Z).toFixed(1) + ' m lower');
    eq(B.touchAim.kind, 'anchor', 'touchAim reports the snap kind under the cursor');
    ok(B.hover && B.hover.snap && B.hover.snap.anchorId === 'a0',
      'the provisional start snapped to the anchor the CURSOR is over');
    eq(snapPoint(f.x, f.y, design, TERRAIN).kind, 'grid',
      'the raw fingertip is over nothing — the anchor was found by the cursor alone');
    tup(f, true);                                  // discard
    eq(B.touchAim, null, 'B.touchAim is cleared when the gesture ends');
  }

  // ---- B. release while aiming = TAP, at the RAW fingertip -----------------
  reset();
  put(26, 4, 29, 4);                               // a horizontal beam at y = 4
  eq(design.members.length, 1, 'setup: one horizontal beam for the tap tests');
  {
    const id = design.members[0].id;
    const f0 = fingerAt(27.5, 4);                  // finger ON the beam
    tdown(f0);
    tmove({ ...f0, px: f0.px + 10 });              // wiggle, under startCommitPx
    ok(B.ghost === null, 'no ghost appears while the gesture is still aiming');
    eq(B.touchAim.aiming, true, 'a wiggle under startCommitPx does not lock the start');
    tup({ ...f0, px: f0.px + 10 });
    eq(builder.getSelection(), id, 'down + wiggle + up selects the member under the RAW finger');
    eq(design.members.length, 1, 'a tap places nothing');
    ok(hitTestMember(f0.x, f0.y - OFF / Z, design, hitTol(Z)) === null,
      'and the cursor was NOT over the member: the tap used the fingertip');
  }
  {
    builder.getBuilder().selection = null;
    const f = fingerAt(27.5, 4);
    tdown(f);
    await new Promise((r) => setTimeout(r, CONFIG.build.tapMaxMs + 60));
    tup(f);
    eq(builder.getSelection(), design.members[0].id,
      'aiming has no time limit: a slow, careful tap still selects');
  }
  {
    const f = fingerAt(34.5, 11);                  // empty sky
    tdown(f); tup(f);
    eq(builder.getSelection(), null, 'a tap on empty space clears the selection');
  }

  // ---- C. the provisional start re-snaps while aiming ----------------------
  reset();
  {
    const a = aimAt(27.4, 5.4);
    tdown(a);
    near(B.hover.snap.x, 27.5, 1e-9, 'the provisional start snaps to the grid under the cursor');
    near(B.hover.snap.y, 5.5, 1e-9, '… on both axes');
    const b = aimAt(27.1, 5.1);                    // 5.9 px of cursor travel
    tmove(b);
    ok(Math.hypot(b.px - a.px, b.py - a.py) < T.startCommitPx,
      'setup: that slide is under the commit threshold');
    near(B.hover.snap.x, 27, 1e-9, 'the start re-snapped to the new grid point');
    near(B.hover.snap.y, 5, 1e-9, '… on both axes');
    eq(B.touchAim.aiming, true, 'and the gesture is still aiming');
    tup(b);
    eq(design.members.length, 0, 'a re-snapped aim that never pulled places nothing');
  }

  // ---- D. the pull locks the start at the SNAPPED CURSOR -------------------
  reset();
  {
    const a = aimAt(26, 3.1);                      // cursor over anchor a0
    tdown(a);
    tmove(aimAt(26.1, 3.05));                      // fine-position: still aiming
    eq(B.touchAim.aiming, true, 'setup: fine-positioning has not committed');
    const b = aimAt(26, 7);                        // pull: 3.9 m ≈ 55 px
    tmove(b);
    eq(B.touchAim.aiming, false, 'past startCommitPx the start LOCKS');
    ok(B.ghost !== null, 'the ghost appears the moment the start locks');
    near(B.ghost.x0, 26, 1e-9, 'the locked start is the anchor the cursor was over (x)');
    near(B.ghost.y0, 3, 1e-9, 'the locked start is the anchor the cursor was over (y)');
    eq(B.ghost.start.anchorId, 'a0', 'and it is the ANCHOR, not a bare grid point');
    near(B.ghost.x1, 26, 1e-9, 'the ghost end follows the cursor (x)');
    near(B.ghost.y1, 7, 1e-9, 'the ghost end follows the cursor, not the finger (y)');
    ok(Math.abs(B.ghost.y0 - a.y) > 3, 'the start is nowhere near the raw fingertip');
    tup(b);
    eq(design.members.length, 1, 'release places the beam');
    eq(design.nodes.length, 2, 'with both endpoints created');
    const ys = design.nodes.map((n) => n.y).sort((m, n) => m - n);
    near(ys[0], 3, 1e-9, 'the placed beam starts at the aimed anchor, not 4 m below it');
    near(ys[1], 7, 1e-9, 'and ends at the cursor');
    eq(design.nodes.find((n) => n.y === 3).anchorId, 'a0', 'the anchored endpoint kept its anchor');
  }

  // ---- E. chaining works, measured at the cursor ---------------------------
  {
    const chainId = B.chainNodeId;
    ok(!!chainId, 'setup: the placement armed a chain node');
    const a = aimAt(26.9, 7);                      // 0.9 m out: chain radius only
    tdown(a);
    eq(B.hover.snap.nodeId, chainId, 'a new touch near the fresh endpoint chains from it');
    eq(B.touchAim.kind, 'node', 'and the cursor reports a node snap');
    const b = aimAt(29, 7);
    tmove(b);
    tup(b);
    eq(design.members.length, 2, 'the chained beam is placed');
    eq(design.nodes.length, 3, 'and shares the endpoint instead of duplicating it');
  }

  // ---- E2. the commit threshold never outgrows the material ---------------
  // A phone fits a whole valley at ~7 px/m, where startCommitPx is 3.7 m of
  // world travel — further than concrete is ALLOWED to span. Uncapped, that
  // makes concrete unplaceable by touch at the default framing.
  reset();
  {
    const mainCam = S.camera;
    const FAR = 7;
    S.camera = {
      zoom: FAR,
      screenToWorld: (px, py) => [(px - W / 2) / FAR + CX, (H / 2 - py) / FAR + CY],
    };
    const far = (x, y) => {
      const px = (x - CX) * FAR + W / 2, py = H / 2 - (y - CY) * FAR + OFF;
      const [wx, wy] = S.camera.screenToWorld(px, py);
      return { x: wx, y: wy, px, py };
    };
    emit('ui:material', { id: 'concrete' });
    ok(MATERIALS.concrete.maxLength * FAR < T.startCommitPx,
      'setup: at 7 px/m a legal concrete beam is shorter than startCommitPx');
    const a = far(29, 4);
    tdown(a);
    // 11 px of pull: over the capped threshold (10.5) and — deliberately —
    // UNDER the mouse's tapMaxPx, which a committed touch drag must ignore
    const b = { ...a, py: a.py - 11 };
    const [bwx, bwy] = S.camera.screenToWorld(b.px, b.py);
    b.x = bwx; b.y = bwy;
    ok(11 < CONFIG.build.tapMaxPx, 'setup: that pull is shorter than tapMaxPx');
    tmove(b);
    eq(B.touchAim.aiming, false, 'the commit threshold is capped by the material span');
    tup(b);
    eq(design.members.length, 1, 'so concrete is still placeable at a phone zoom');
    near(builder.designCost(design), 1.5 * MATERIALS.concrete.costPerMeter, 1e-6,
      'and a locked gesture places even when the mouse would have called it a tap');
    emit('ui:material', { id: 'timber' });
    S.camera = mainCam;
  }

  // ---- F. the offset shrinks near the top edge (and never jumps) ----------
  reset();
  {
    const probe = (py) => {
      const f = { px: 250, py, x: 0, y: 0 };
      const [wx, wy] = S.camera.screenToWorld(f.px, f.py);
      f.x = wx; f.y = wy;
      tdown(f);
      const cy = B.touchAim.py;
      tup(f, true);
      return cy;
    };
    near(probe(600), 600 - OFF, 1e-9, 'far from the top the cursor gets the full offset');
    near(probe(T.topClearancePx + OFF), T.topClearancePx, 1e-9,
      'the offset shrinks so the cursor stops exactly at topClearancePx');
    near(probe(T.topClearancePx + 20), T.topClearancePx, 1e-9,
      'closer still, the cursor is pinned to the clearance line');
    near(probe(60), 60, 1e-9,
      'a finger already above the clearance line keeps the cursor on the fingertip');

    let below = 0, above = 0, jump = 0, prevF = null, prevC = null;
    for (let py = 400; py >= 20; py -= 7) {
      const c = probe(py);
      if (c < Math.min(py, T.topClearancePx) - 1e-9) below++;
      if (c > py + 1e-9) above++;
      if (prevF !== null && Math.abs(c - prevC) > Math.abs(py - prevF) + 1e-9) jump++;
      prevF = py; prevC = c;
    }
    eq(below, 0, 'the cursor never rises past the clearance line (55 sample heights)');
    eq(above, 0, 'and never falls below the fingertip');
    eq(jump, 0, 'the shrink is smooth: the cursor never moves further than the finger');
  }

  // ---- G. erase and box-delete stay on the RAW fingertip -------------------
  reset();
  put(26, 4, 29, 4);
  eq(design.members.length, 1, 'setup: one beam to delete');
  {
    emit('ui:tool', { id: 'erase' });
    const f = fingerAt(27.5, 4);
    tdown(f);
    eq(B.touchAim, null, 'the erase tool publishes no aim cursor');
    tup(f);
    eq(design.members.length, 0, 'a touch erase deletes what the FINGER is on');
    builder.undo();
    eq(design.members.length, 1, 'setup: the beam is back');
    emit('ui:tool', { id: 'build' });
  }
  {
    emit('ui:tool', { id: 'boxdelete' });
    const a = fingerAt(25, 3.5), b = fingerAt(30, 4.5);
    tdown(a);
    tmove(b);
    eq(B.touchAim, null, 'the box-delete tool publishes no aim cursor either');
    ok(B.marquee !== null, 'setup: the marquee is live');
    near(B.marquee.y0, 3.5, 1e-9, 'the marquee is built from raw finger coords (y0)');
    near(B.marquee.y1, 4.5, 1e-9, 'the marquee is built from raw finger coords (y1)');
    tup(b);
    eq(design.members.length, 0, 'and the box deletes the beam it was actually drawn around');
    emit('ui:tool', { id: 'build' });
  }

  // ---- H. pinch-cancel from both states ------------------------------------
  reset();
  {
    const a = aimAt(26, 3);
    tdown(a);
    tmove(aimAt(26.05, 3.05));
    eq(B.touchAim.aiming, true, 'setup: cancelling from the aiming state');
    tup(aimAt(26.05, 3.05), true);
    eq(design.members.length, 0, 'a pinch-cancel while aiming places nothing');
    eq(design.nodes.length, 0, 'and leaves no orphan node');
    eq(builder.getSelection(), null, 'and is not treated as a tap');
    eq(B.touchAim, null, 'and clears the aim cursor');
  }
  {
    const a = aimAt(26, 3);
    tdown(a);
    const b = aimAt(26, 7);
    tmove(b);
    eq(B.touchAim.aiming, false, 'setup: cancelling from the drawing state');
    tup(b, true);
    eq(design.members.length, 0, 'a pinch-cancel while drawing places nothing');
    eq(design.nodes.length, 0, 'and leaves no orphan node');
    eq(B.ghost, null, 'and clears the ghost');
    eq(B.touchAim, null, 'and clears the aim cursor');
  }

  // ---- I. mouse and pen are untouched --------------------------------------
  reset();
  {
    const a = fingerAt(26, 3), b = fingerAt(26, 7);
    emit('input:down', { ...a, id: 1, button: 0, cancel: false });
    eq(B.touchAim, null, 'a mouse gesture never publishes an aim cursor');
    emit('input:move', { ...b, id: 1, button: 0, cancel: false, hover: false });
    eq(B.touchAim, null, 'nor on move');
    ok(B.ghost !== null, 'a mouse drag draws its ghost from the very first move');
    near(B.ghost.y0, 3, 1e-9, 'the mouse start is committed at pointer-down, unchanged');
    emit('input:up', { ...b, id: 1, button: 0, cancel: false });
    eq(design.members.length, 1, 'the mouse places on release exactly as before');
    near(design.nodes.find((n) => n.anchorId === 'a0').y, 3, 1e-9,
      'and at the raw pointer position');
  }
  reset();
  {
    put(26, 3, 26, 7, 'pen');
    eq(design.members.length, 1, 'a pen drag places a beam');
    eq(B.touchAim, null, 'and pen gets no aim cursor (it points at what it touches)');
    const ys = design.nodes.map((n) => n.y).sort((m, n) => m - n);
    near(ys[0], 3, 1e-9, 'a pen beam starts at the raw pen position');
    near(ys[1], 7, 1e-9, 'and ends there too — no offset for pen');
  }
  reset();
}

// ------------------------------------------------ 11. TOUCH GESTURE FUZZ ----
// Section 9 fuzzes the mouse editing surface. This one interleaves the three
// touch gestures — aim → wiggle → pull → place, aim → tap, aim → pinch-cancel —
// with the mouse actions, the delete tools and undo/redo, and holds the same
// seven structural invariants plus an eighth: the aim cursor is a property of a
// LIVE gesture and must never outlive one.

section('11. FUZZ — TOUCH GESTURES');
{
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
  const OFF = CONFIG.touch.cursorOffsetPx;

  const at = (x, y) => ({ x, y, px: sx(x), py: sy(y) });
  const aim = (x, y) => {                     // finger that puts the cursor on (x,y)
    const px = sx(x), py = sy(y) + OFF;
    const [wx, wy] = S.camera.screenToWorld(px, py);
    return { x: wx, y: wy, px, py };
  };
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
    'the aim cursor never outlives its gesture',
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
      !!B.touchAim,
    ];
    for (let i = 0; i < bad.length; i++) {
      if (bad[i]) { viol[i]++; if (!witness[i]) witness[i] = where; }
    }
  }

  let inTouch = false;
  let touchPlaced = 0, mousePlaced = 0, deleted = 0;
  const offChange = on('design:change', (e) => {
    if (e.action !== 'place') { deleted += e.count || 1; return; }
    if (inTouch) touchPlaced++; else mousePlaced++;
  });
  let touchTapSelects = 0, touchCancels = 0, locked = 0;

  const SEEDS = [3, 11, 2024, 65535];
  const ACTIONS = 260;
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

      if (pick < 0.30) {                        // TOUCH: aim → wiggle → pull → place
        inTouch = true;
        const x0 = X(), y0 = Y();
        down(aim(x0, y0), 0, 'touch');
        move(aim(x0 + (r() - 0.5) * 0.6, y0 + (r() - 0.5) * 0.6), 'touch');   // fine-position
        const x1 = x0 + (r() - 0.5) * 8, y1 = y0 + (r() - 0.5) * 8;
        move(aim(x1, y1), 'touch');
        if (B.touchAim && B.touchAim.aiming === false) locked++;
        const cancel = r() < 0.10;
        if (cancel) touchCancels++;
        up(aim(x1, y1), cancel, 0, 'touch');
      } else if (pick < 0.42) {                 // TOUCH: aim → tap (never commits)
        inTouch = true;
        const x = X(), y = Y();
        const f = at(x, y);
        down(f, 0, 'touch');
        move({ ...f, px: f.px + (r() - 0.5) * 20 }, 'touch');
        up({ ...f, px: f.px + (r() - 0.5) * 20 }, false, 0, 'touch');
        if (B.selection) touchTapSelects++;
      } else if (pick < 0.48) {                 // TOUCH: aim → pinch-cancel
        inTouch = true;
        const x = X(), y = Y();
        down(aim(x, y), 0, 'touch');
        if (r() < 0.5) move(aim(x + (r() - 0.5) * 8, y + (r() - 0.5) * 8), 'touch');
        up(aim(X(), Y()), true, 0, 'touch');
        touchCancels++;
      } else if (pick < 0.54) {                 // TOUCH gesture cut short mid-drag
        inTouch = true;
        const x = X(), y = Y();
        down(aim(x, y), 0, 'touch');
        move(aim(X(), Y()), 'touch');
        emit('input:key', { key: r() < 0.5 ? 'Delete' : 'z' });
        up(aim(X(), Y()), false, 0, 'touch');
      } else if (pick < 0.62) {                 // mouse place (the untouched path)
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
  ok(touchPlaced > 0 && locked > 0,
    `touch gestures actually built things (${touchPlaced} placed after ${locked} start locks)`);
  ok(mousePlaced > 0, `the mouse path still built things alongside them (${mousePlaced})`);
  ok(touchTapSelects > 0, `aim-taps selected members (${touchTapSelects} times)`);
  ok(touchCancels > 0 && deleted > 0,
    `cancels and deletes were exercised too (${touchCancels} cancels, ${deleted} members deleted)`);
}

// ---------------------------------------------------------------- summary --

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
