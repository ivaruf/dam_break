// OPUS B owns. Design editing: place/connect/delete/select/ghost/undo.
// Contract: ARCHITECTURE.md §10. Mutates the design object owned by game.js.
//
// Pointer model (identical for mouse and touch — nothing core depends on hover):
//   press + drag  → ghost member from the snapped start to the snapped end,
//                   placed on release if valid
//   press + tap    → select the member under the finger (or clear the selection)
//   right button   → delete the member under the cursor (mouse only)
//   erase tool     → press/drag deletes every member the path touches
// After a placement the far endpoint becomes the "chain node": its snap radius
// grows (CONFIG.build.chainSnapMul) so a quick follow-up drag continues the run.

import { CONFIG } from '../config.js';
import { on, emit } from '../core/events.js';
import { getScene } from '../core/game.js';
import { snapPoint, validate, hitTestMember, hitTestMembersAlong, hitTol } from './snapping.js';
import { MATERIALS, MATERIAL_ORDER } from './materials.js';

const B = {
  level: null, terrain: null, design: null,
  material: 'timber',
  tool: 'build',          // build | erase
  ghost: null,            // {x0,y0,x1,y1, ok, cost, len, reason, mat, start, end}
  drag: null,
  selection: null,        // member id | null  (renderer highlights it)
  hover: null,            // {x,y, snap} last hover/drag point — cosmetic only
  hoverMember: null,      // member id under the pointer — cosmetic only
  nextId: 1,
  undo: [],
  redo: [],
  chainNodeId: null,      // endpoint of the member just placed
  hint: null,             // {text, until} last refusal reason, for the HUD
};

export function getBuilder() { return B; }
export function getSelection() { return B.selection; }
export function canUndo() { return B.undo.length > 0; }
export function canRedo() { return B.redo.length > 0; }

// Short human-readable reason for the last refused action ('' when stale).
export function getHint() {
  if (!B.hint) return '';
  return now() < B.hint.until ? B.hint.text : '';
}

function now() { return Date.now(); }

function hint(text) {
  B.hint = { text, until: now() + CONFIG.build.hintMs };
}

// ---- lifecycle ------------------------------------------------------------

export function initBuilder() {
  on('input:down', onDown);
  on('input:move', onMove);
  on('input:up', onUp);
  on('ui:material', ({ id }) => setMaterial(id));
  on('ui:tool', ({ id }) => setTool(id, true));
  on('ui:undo', () => undo());
  on('ui:redo', () => redo());
  on('ui:delete', () => deleteSelection());
  on('ui:clear', () => clearDesign());
  on('input:key', onKey);
  on('phase:change', ({ phase }) => { if (phase !== 'build') cancelDrag(); });
}

export function startLevel(level, terrain, design) {
  B.level = level; B.terrain = terrain; B.design = design;
  B.material = pickDefaultMaterial(level);
  B.tool = 'build';
  B.ghost = null; B.drag = null; B.selection = null;
  B.hover = null; B.hoverMember = null;
  B.nextId = 1;
  B.undo = []; B.redo = [];
  B.chainNodeId = null;
  B.hint = null;
}

// A level naming a material that does not exist must not silently disable
// building (and must not hand hud.js an id it will dereference).
function pickDefaultMaterial(level) {
  for (const id of materialList(level)) if (MATERIALS[id]) return id;
  return MATERIAL_ORDER[0];
}

function materialList(level) {
  const lv = level || B.level;
  if (lv && lv.materials && lv.materials.length) return lv.materials;
  return MATERIAL_ORDER;
}

// Safety net: if game.js swapped in a new design object without telling us
// (level reload), rebind and drop the now-meaningless history.
function scene() {
  const S = getScene();
  if (S.design && S.design !== B.design) startLevel(S.level, S.terrain, S.design);
  else {
    if (S.level) B.level = S.level;
    if (S.terrain) B.terrain = S.terrain;
  }
  return S;
}

// ---- cost / budget --------------------------------------------------------

export function designCost(design) {
  if (!design) return 0;
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  let c = 0;
  for (const m of design.members) {
    const a = byId.get(m.a), b = byId.get(m.b);
    const mat = MATERIALS[m.mat];
    if (!a || !b || !mat) continue;
    c += Math.hypot(b.x - a.x, b.y - a.y) * mat.costPerMeter;
  }
  return c;
}

export function budgetLeft() {
  if (!B.level) return 0;
  return B.level.budget - designCost(B.design);
}

// Metres of a material the remaining budget still buys (for the HUD).
export function affordableLength(matId) {
  const mat = MATERIALS[matId || B.material];
  if (!mat || !mat.costPerMeter) return 0;
  return Math.max(0, budgetLeft() / mat.costPerMeter);
}

// ---- tools / materials ----------------------------------------------------

export function setMaterial(id) {
  if (!MATERIALS[id]) return;
  B.material = id;
  B.tool = 'build';            // picking a material always means "build"
  if (B.drag && B.drag.mode === 'build' && B.drag.moved && B.drag.last) updateGhost(B.drag.last);
}

// toggle=true (a UI button) re-sending the active non-build tool turns it off.
export function setTool(id, toggle) {
  const next = (toggle && id !== 'build' && B.tool === id) ? 'build' : id;
  B.tool = next;
  if (next !== 'build') B.ghost = null;
}

// ---- undo / redo ----------------------------------------------------------

function snapshot() {
  // A committed state never contains an orphan. The node a live drag is holding
  // on to (see cleanupOrphans) is not part of the design yet, so it must not be
  // baked into history — restoring it later would resurrect a permanent orphan.
  const used = new Set();
  for (const m of B.design.members) { used.add(m.a); used.add(m.b); }
  return {
    nodes: B.design.nodes.filter((n) => used.has(n.id)).map((n) => ({ ...n })),
    members: B.design.members.map((m) => ({ ...m })),
    nextId: B.nextId,
    selection: B.selection,
    chainNodeId: B.chainNodeId,
  };
}

function restore(s) {
  const d = B.design;
  d.nodes.length = 0;
  for (const n of s.nodes) d.nodes.push({ ...n });
  d.members.length = 0;
  for (const m of s.members) d.members.push({ ...m });
  B.nextId = s.nextId;
  B.selection = d.members.some((m) => m.id === s.selection) ? s.selection : null;
  B.chainNodeId = d.nodes.some((n) => n.id === s.chainNodeId) ? s.chainNodeId : null;
}

function pushUndo() {
  B.undo.push(snapshot());
  if (B.undo.length > CONFIG.build.undoDepth) B.undo.shift();
  B.redo.length = 0;
}

export function undo() {
  if (!B.design || !B.undo.length) return false;
  B.redo.push(snapshot());
  if (B.redo.length > CONFIG.build.undoDepth) B.redo.shift();
  restore(B.undo.pop());
  cancelDrag();
  return true;
}

export function redo() {
  if (!B.design || !B.redo.length) return false;
  B.undo.push(snapshot());
  if (B.undo.length > CONFIG.build.undoDepth) B.undo.shift();
  restore(B.redo.pop());
  cancelDrag();
  return true;
}

export function clearDesign() {
  if (!B.design || (!B.design.members.length && !B.design.nodes.length)) return false;
  pushUndo();
  B.design.members.length = 0;
  B.design.nodes.length = 0;
  B.selection = null;
  B.chainNodeId = null;
  cancelDrag();
  return true;
}

// ---- structural edits -----------------------------------------------------

function ensureNode(s) {
  // s can be a stale snap result: the node it names may have been deleted
  // between the pointer move that produced it and the release that uses it.
  if (s.nodeId && B.design.nodes.some((n) => n.id === s.nodeId)) return s.nodeId;
  if (s.anchorId) {
    const ex = B.design.nodes.find((n) => n.anchorId === s.anchorId);
    if (ex) return ex.id;
  }
  const id = 'n' + B.nextId++;
  B.design.nodes.push({ id, x: s.x, y: s.y, anchorId: s.anchorId || null });
  return id;
}

// Nodes that no member uses any more are removed, except the node an
// in-progress drag is anchored to.
function cleanupOrphans() {
  const keep = B.drag && B.drag.start ? B.drag.start.nodeId : null;
  const used = new Set();
  for (const m of B.design.members) { used.add(m.a); used.add(m.b); }
  const nodes = B.design.nodes;
  let removed = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!used.has(nodes[i].id) && nodes[i].id !== keep) { nodes.splice(i, 1); removed = true; }
  }
  // the in-flight ghost may name a node that just disappeared
  if (removed) B.ghost = null;
  if (B.chainNodeId && !nodes.some((n) => n.id === B.chainNodeId)) B.chainNodeId = null;
}

function placeMember(start, end) {
  const mat = MATERIALS[B.material];
  const v = validate(start, end, mat, B.design, B.terrain, B.level, budgetLeft());
  if (!v.ok) { hint(v.reason); return null; }

  pushUndo();
  const a = ensureNode(start);
  const b = ensureNode(end);
  if (a === b) { B.undo.pop(); cleanupOrphans(); return null; }

  const m = { id: 'm' + B.nextId++, a, b, mat: B.material };
  B.design.members.push(m);
  B.chainNodeId = b;
  B.selection = null;
  emit('design:change', { action: 'place', id: m.id });
  return m;
}

export function deleteMember(id) {
  const i = B.design ? B.design.members.findIndex((m) => m.id === id) : -1;
  if (i < 0) return false;
  B.design.members.splice(i, 1);
  if (B.selection === id) B.selection = null;
  cleanupOrphans();
  emit('design:change', { action: 'delete', id });
  return true;
}

export function deleteSelection() {
  if (!B.selection) return false;
  pushUndo();
  const ok = deleteMember(B.selection);
  if (!ok) B.undo.pop();
  return ok;
}

// ---- pointer flow ---------------------------------------------------------

function tolerance(mul) {
  const S = getScene();
  const zoom = S.camera ? S.camera.zoom : 1;
  return hitTol(zoom) * (mul || 1);
}

function cancelDrag() {
  const wasDrag = B.drag;
  B.drag = null;
  B.ghost = null;
  if (wasDrag && B.design) cleanupOrphans();
}

function onDown(p) {
  const S = scene();
  if (S.phase !== 'build' || !B.design) return;

  // right button: straight delete, and swallow the rest of the gesture
  if (p.button === 2) {
    const id = hitTestMember(p.x, p.y, B.design, tolerance());
    if (id) { pushUndo(); deleteMember(id); } else { B.selection = null; }
    B.drag = { mode: 'dead' };
    B.ghost = null;
    return;
  }

  const eraser = B.tool === 'erase';
  const start = eraser ? null
    : snapPoint(p.x, p.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });

  B.drag = {
    mode: eraser ? 'erase' : 'build',
    start,
    px0: p.px, py0: p.py, t0: now(),
    lx: p.x, ly: p.y,
    last: start,
    snapped: false,
    moved: false,
  };
  B.ghost = null;

  if (eraser) eraseAt(p.x, p.y);
}

function onMove(p) {
  const S = getScene();
  if (S.phase !== 'build' || !B.design) return;

  if (!B.drag) {                                  // hover (mouse only, cosmetic)
    if (p.hover) {
      B.hover = { x: p.x, y: p.y, snap: snapPoint(p.x, p.y, B.design, B.terrain, { chainNodeId: B.chainNodeId }) };
      B.hoverMember = hitTestMember(p.x, p.y, B.design, tolerance(B.tool === 'erase' ? CONFIG.build.eraseTolMul : 1));
    }
    return;
  }
  if (B.drag.mode === 'dead') return;

  B.hover = { x: p.x, y: p.y, snap: null };
  const travel = Math.hypot(p.px - B.drag.px0, p.py - B.drag.py0);
  if (travel >= CONFIG.build.dragMinPx) B.drag.moved = true;

  if (B.drag.mode === 'erase') {
    eraseAlong(B.drag.lx, B.drag.ly, p.x, p.y);
    B.drag.lx = p.x; B.drag.ly = p.y;
    return;
  }

  if (!B.drag.moved) { B.ghost = null; return; }
  // no chain bonus on the far end: that radius exists to make STARTING a
  // follow-up drag forgiving, and would otherwise pull short members back home
  const end = snapPoint(p.x, p.y, B.design, B.terrain);
  B.drag.last = end;
  B.hover.snap = end;
  updateGhost(end);
}

function onUp(p) {
  const drag = B.drag;
  const ghost = B.ghost;
  B.drag = null;
  B.ghost = null;
  if (!drag || drag.mode === 'dead' || !B.design) { if (drag) cleanupOrphans(); return; }

  if (drag.mode === 'erase') { cleanupOrphans(); return; }
  if (p.cancel) { cleanupOrphans(); return; }     // pinch-cancel: never place

  const cfg = CONFIG.build;
  const travel = Math.hypot(p.px - drag.px0, p.py - drag.py0);
  const held = now() - drag.t0;

  if (travel <= cfg.tapMaxPx && held <= cfg.tapMaxMs) {          // tap = select
    B.selection = hitTestMember(p.x, p.y, B.design, tolerance());
    cleanupOrphans();
    return;
  }
  if (travel < cfg.dragMinPx) { cleanupOrphans(); return; }      // long hold: no-op

  const end = (ghost && ghost.end) || snapPoint(p.x, p.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });
  placeMember(drag.start, end);
  cleanupOrphans();
}

function updateGhost(end) {
  const start = B.drag.start;
  const mat = MATERIALS[B.material];
  if (!start || !mat) { B.ghost = null; return; }
  const v = validate(start, end, mat, B.design, B.terrain, B.level, budgetLeft());
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  B.ghost = {
    x0: start.x, y0: start.y, x1: end.x, y1: end.y,
    ok: v.ok, reason: v.reason,
    len, cost: len * mat.costPerMeter,
    mat: B.material,
    start, end,
    startNodeId: start.nodeId || null,
    endNodeId: end.nodeId || null,
  };
}

// ---- eraser ---------------------------------------------------------------

function eraseIds(ids) {
  if (!ids.length) return;
  if (B.drag && !B.drag.snapped) { pushUndo(); B.drag.snapped = true; }
  else if (!B.drag) pushUndo();
  for (const id of ids) deleteMember(id);
}

function eraseAt(x, y) {
  const id = hitTestMember(x, y, B.design, tolerance(CONFIG.build.eraseTolMul));
  if (id) eraseIds([id]);
}

function eraseAlong(x0, y0, x1, y1) {
  const ids = hitTestMembersAlong(x0, y0, x1, y1, B.design, tolerance(CONFIG.build.eraseTolMul));
  eraseIds(ids);
}

// ---- keyboard -------------------------------------------------------------

function onKey({ key }) {
  const S = getScene();
  if (S.phase !== 'build') return;

  const list = materialList();
  const i = parseInt(key, 10);
  if (!Number.isNaN(i) && i >= 1 && i <= list.length) { setMaterial(list[i - 1]); return; }

  switch (key) {
    case 'e': case 'E': setTool(B.tool === 'erase' ? 'build' : 'erase'); break;
    case 'b': case 'B': setTool('build'); break;
    case 'z': undo(); break;
    case 'Z': redo(); break;
    case 'y': case 'Y': redo(); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    default: break;
  }
}
