// OPUS B owns. Design editing: place/connect/delete/select/ghost/undo.
// Contract: ARCHITECTURE.md §10. Mutates the design object owned by game.js.
//
// MOUSE / PEN — unchanged since v1 (nothing core depends on hover):
//   press + drag  → ghost member from the snapped start to the snapped end,
//                   placed on release if valid
//   press + tap    → select the member under the pointer (or clear the selection)
//   right button   → delete the member under the cursor
//   erase tool     → press/drag deletes every member the path touches
//   boxdelete tool → press/drag draws a marquee; release deletes the whole
//                    SECTION inside it as one undo step (a tap falls back to the
//                    single-member erase, so the tool is never a dead zone)
// After a placement the far endpoint becomes the "chain node": its snap radius
// grows (CONFIG.build.chainSnapMul) so a quick follow-up drag continues the run.
//
// TOUCH + BUILD TOOL — PRESS-ADJUST-LIFT (v3; CONFIG.touch). v2.4's offset
// cursor and deferred start are GONE: they moved the target away from the finger
// and changed the gesture's mind mid-press, and playtest called that clonky. The
// rule now has no states and no exceptions:
//
//   EVERY press previews at the SNAPPED FINGERTIP. Sliding re-snaps the
//   preview. THE LIFT COMMITS. Nothing else, ever, changes the design.
//
// What the preview IS depends only on what already exists:
//   • CHAIN HEAD live → a BEAM from the head to the snapped fingertip. The lift
//     places beam + node and the new endpoint becomes the head, so a run is
//     tap-tap-tap. A tap ON the head finishes the run.
//   • no head, press on a node/anchor → a beam FROM it (classic drag-draw falls
//     out of this for free, and a tap adopts the joint as the head instead).
//   • no head, press on open ground → just the snapped NODE marker; the lift
//     claims that point as a PENDING head. Pending means "not a design node
//     yet": an unconnected node is an orphan and the design never holds one.
// Snapping to nodes and anchors is CONFIG.touch.snapMul stronger for touch (the
// grid stays 0.5 m), so the preview pops between candidates instead of drifting.
// The loupe (rendering/loupe.js) shows the fingertip magnified — it, not an
// offset, is the answer to a finger covering its own target.
// A press+lift with the build tool NEVER selects: erase and box-delete are the
// touch deletion tools, and every build press is a placement.
//
// NODE DRAGGING (mouse AND touch, build tool): press-and-HOLD on an existing
// design node (CONFIG.touch.holdMs, travel under holdSlopPx) lifts it. It
// follows the snapped pointer with every attached member recomputed live, and
// the release either commits the move as ONE undo step or reverts it whole.
//
// The render layer reads B.chainHead and B.nodeDrag (see the state block).

import { CONFIG } from '../config.js';
import { on, emit } from '../core/events.js';
import { getScene } from '../core/game.js';
import { snapPoint, validate, hitTestMember, hitTestMembersAlong, hitTestMembersInRect, hitTol } from './snapping.js';
import { MATERIALS, MATERIAL_ORDER } from './materials.js';

const B = {
  level: null, terrain: null, design: null,
  material: 'timber',
  tool: 'build',          // build | erase | boxdelete
  ghost: null,            // {x0,y0,x1,y1, ok, cost, len, reason, mat, start, end}
  marquee: null,          // {x0,y0,x1,y1} world rect, normalized — box-delete drag
  marqueeHits: [],        // member ids the live marquee would delete
  drag: null,
  selection: null,        // member id | null  (renderer highlights it)
  hover: null,            // {x,y, snap} last hover/drag point — cosmetic only
  hoverMember: null,      // member id under the pointer — cosmetic only
  nextId: 1,
  undo: [],
  redo: [],
  chainNodeId: null,      // endpoint of the member just placed (snap radius bonus)
  chainHead: null,        // TOUCH CHAIN (v3), for the render layer + the HUD:
                          //   null | {x, y, nodeId|null, anchorId|null, kind,
                          //           pending}
                          // the joint the next touch press builds FROM, drawn
                          // pulsing. `pending` means the point is claimed but is
                          // not a design node yet (a lone node would be an
                          // orphan). Set by a committed touch lift, cleared by a
                          // tap on itself, a tool switch, a phase change,
                          // undo/redo/clear, or the node under it disappearing.
                          // Mouse and pen never set it, so a mouse-only session
                          // never sees one.
  nodeDrag: null,         // LIFTED NODE (mouse or touch), for the render layer:
                          //   null | {nodeId, x, y, anchorId, ok, reason,
                          //           touch, orig:{x,y,anchorId}, members:[id]}
                          // The design node itself is moved LIVE (so every
                          // attached member follows for free); `orig` is what a
                          // revert or the single undo step restores.
  hint: null,             // {text, until} last refusal reason, for the HUD
};

export function getBuilder() { return B; }
export function getSelection() { return B.selection; }
export function getChainHead() { return B.chainHead; }
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
  // Leaving the build phase ends everything in flight, the chain included: a
  // pulsing head over a running simulation would be a promise nothing can keep.
  on('phase:change', ({ phase }) => { if (phase !== 'build') { cancelDrag(); B.chainHead = null; } });
}

export function startLevel(level, terrain, design) {
  B.level = level; B.terrain = terrain; B.design = design;
  B.material = pickDefaultMaterial(level);
  B.tool = 'build';
  B.ghost = null; B.drag = null; B.selection = null;
  B.marquee = null; B.marqueeHits = [];
  B.hover = null; B.hoverMember = null;
  B.nextId = 1;
  B.undo = []; B.redo = [];
  B.chainNodeId = null;
  B.chainHead = null;
  B.nodeDrag = null;
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
  dropMarquee();
  if (B.drag && B.drag.mode === 'build' && B.drag.moved && B.drag.last) updateGhost(B.drag.last);
  // a live touch preview re-costs itself in the new material immediately
  else if (B.drag && B.drag.mode === 'touchbuild' && B.drag.last) updatePreview(B.drag.last);
}

// toggle=true (a UI button) re-sending the active non-build tool turns it off.
export function setTool(id, toggle) {
  const next = (toggle && id !== 'build' && B.tool === id) ? 'build' : id;
  // Switching tools ENDS a touch chain: the head is a promise about what the
  // next press will build, and reaching for the eraser withdraws it. Picking a
  // material does not (that sets B.tool directly, and is still building).
  //
  // Pressing the BUILD button itself ends one too, even though the tool does not
  // change: it is the toolbar's "never mind" — and it is the escape hatch for a
  // chain whose head has been left somewhere the player can no longer reach
  // (scrolled off screen, or too far for any legal beam). `toggle` is only true
  // for a real UI press, so the internal setTool('build') calls do not.
  if (toggle && next === 'build') B.chainHead = null;
  if (next !== B.tool) {
    B.chainHead = null;
    // A node in the air and a live touch preview both belong to the BUILD tool,
    // so a tool change abandons them (the node goes back where it was). The
    // mouse's own build drag is deliberately left alone: it commits on its own
    // release exactly as it always has.
    if (B.nodeDrag || (B.drag && B.drag.mode === 'touchbuild')) cancelDrag();
  }
  B.tool = next;
  if (next !== 'build') B.ghost = null;
  if (next !== 'boxdelete') dropMarquee();   // disarming mid-drag deletes nothing
}

// Abandon an in-flight marquee (tool switched away under the finger).
function dropMarquee() {
  if (B.drag && B.drag.mode === 'boxdelete') cancelDrag();
  else clearMarquee();
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

// History wins over anything in flight. A live node lift is put BACK before the
// snapshot is taken (otherwise redo would remember a position the player never
// committed), and the touch chain is dropped: the design it pointed into has
// just changed under it.
export function undo() {
  if (!B.design || !B.undo.length) return false;
  abortNodeDrag();
  B.redo.push(snapshot());
  if (B.redo.length > CONFIG.build.undoDepth) B.redo.shift();
  restore(B.undo.pop());
  cancelDrag();
  B.chainHead = null;
  return true;
}

export function redo() {
  if (!B.design || !B.redo.length) return false;
  abortNodeDrag();
  B.undo.push(snapshot());
  if (B.undo.length > CONFIG.build.undoDepth) B.undo.shift();
  restore(B.redo.pop());
  cancelDrag();
  B.chainHead = null;
  return true;
}

export function clearDesign() {
  if (!B.design || (!B.design.members.length && !B.design.nodes.length)) return false;
  abortNodeDrag();
  pushUndo();
  B.design.members.length = 0;
  B.design.nodes.length = 0;
  B.selection = null;
  B.chainNodeId = null;
  B.chainHead = null;
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
  // a chain head or a lifted node whose node is gone is a dangling promise
  if (B.chainHead && B.chainHead.nodeId && !nodes.some((n) => n.id === B.chainHead.nodeId)) {
    B.chainHead = null;
  }
  if (B.nodeDrag && !nodes.some((n) => n.id === B.nodeDrag.nodeId)) B.nodeDrag = null;
}

// `touch` = this placement came from a touch lift, so the far endpoint becomes
// the CHAIN HEAD and the next press continues the run. Mouse/pen placements
// leave the chain alone, which in a mouse-only session means there never is one.
function placeMember(start, end, touch) {
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
  if (touch) B.chainHead = headAt(nodeById(b));
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
  emit('design:change', { action: 'delete', id, count: 1 });
  return true;
}

// Delete a whole set of members as ONE edit: one undo step, one orphan sweep,
// one 'design:change'. The box-delete tool's release goes through here, and a
// section coming back on a single undo is the whole point of the tool.
// Returns the number actually removed (ids may be stale by now).
export function deleteMembers(ids) {
  if (!B.design || !ids || !ids.length) return 0;
  const want = new Set(ids);
  const members = B.design.members;
  const gone = [];
  for (let i = members.length - 1; i >= 0; i--) {
    if (want.has(members[i].id)) gone.push(members[i].id);
  }
  if (!gone.length) return 0;

  pushUndo();
  for (let i = members.length - 1; i >= 0; i--) {
    if (want.has(members[i].id)) members.splice(i, 1);
  }
  if (B.selection && want.has(B.selection)) B.selection = null;
  cleanupOrphans();
  emit('design:change', { action: 'delete', id: null, count: gone.length });
  return gone.length;
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
  const wasDrag = B.drag || B.nodeDrag;
  abortNodeDrag();           // an interrupted lift never commits
  B.drag = null;
  B.ghost = null;
  clearMarquee();
  if (wasDrag && B.design) cleanupOrphans();
}

// Device pixels per CSS pixel. CONFIG.touch is specified in CSS px (thumbs and
// hold-slop are body measurements, so they must mean the same thing on every
// screen) while input:* events carry device px. camera.js exposes the canvas it
// closed over, so there is no DOM lookup here; a headless camera stub has none,
// which correctly gives 1 — those tests drive device px directly.
function dpr() {
  const cam = getScene().camera;
  const c = cam && cam.canvas;
  if (!c || !c.width || !c.clientWidth) return 1;
  const d = c.width / c.clientWidth;
  return d > 0.1 && d < 8 ? d : 1;
}

// ---- snapping helpers -----------------------------------------------------

// Snap for a TOUCH gesture: same priority as always, node and anchor radii
// scaled by CONFIG.touch.snapMul so the preview endpoint pops onto joints.
//
// Deliberately NO chain bonus (CONFIG.build.chainSnapMul). That bonus exists so
// a MOUSE can start a follow-up drag near the endpoint it just placed; a touch
// chain already builds from the head by definition, and stacking 1.7 on top of
// snapMul would give the head a 2 m radius — swallowing every tap that meant
// "beam to here" and reading it as "tap the head, finish the run" instead. The
// head keeps the plain node radius, which is also the honest rule: within a
// node's snap radius, a tap means THAT node.
function snapTouch(x, y) {
  return snapPoint(x, y, B.design, B.terrain, { radiusMul: CONFIG.touch.snapMul });
}

// Two snapped points that mean the same place. Both are quantised (node /
// anchor / 0.5 m grid), so this is exact rather than fuzzy: it answers "would
// the beam between these two be a zero-length stub?".
function samePoint(a, b) {
  if (!a || !b) return false;
  if (a.nodeId && b.nodeId) return a.nodeId === b.nodeId;
  return Math.hypot(b.x - a.x, b.y - a.y) <= CONFIG.build.mergeEps;
}

function nodeById(id) {
  if (!id || !B.design) return null;
  for (const n of B.design.nodes) if (n.id === id) return n;
  return null;
}

// A chain-head record from any snapped point or design node.
function headAt(pt) {
  if (!pt) return null;
  const nodeId = pt.id || pt.nodeId || null;
  return {
    x: pt.x, y: pt.y,
    nodeId,
    anchorId: pt.anchorId || null,
    kind: nodeId ? 'node' : pt.anchorId ? 'anchor' : (pt.kind || 'grid'),
    pending: !nodeId,
  };
}

// ---- pointer down ---------------------------------------------------------

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
  const box = B.tool === 'boxdelete';

  // TOOL CHOICE: only the BUILD tool gets press-adjust-lift. Erase and
  // box-delete are coarse by nature — a sweep through members, a marquee round a
  // section — and both are aimed with the whole contact patch, so they keep the
  // raw fingertip and the original code path, mouse and touch alike.
  if (p.ptype === 'touch' && !eraser && !box) { touchDown(p); return; }

  const start = (eraser || box) ? null
    : snapPoint(p.x, p.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });

  B.drag = {
    mode: box ? 'boxdelete' : eraser ? 'erase' : 'build',
    start,
    px0: p.px, py0: p.py, t0: now(),
    lx: p.x, ly: p.y,
    x0: p.x, y0: p.y,        // marquee origin (box-delete)
    last: start,
    snapped: false,
    moved: false,
    touch: false,
    // press-and-hold on an existing node lifts it (see holdCheck)
    holdNodeId: (!eraser && !box && start && start.kind === 'node') ? start.nodeId : null,
  };
  B.ghost = null;
  clearMarquee();            // the box only exists once the drag passes dragMinPx

  if (eraser) eraseAt(p.x, p.y);
}

// A touch press with the build tool. Nothing is committed and nothing is locked:
// this only decides what the PREVIEW is, and the preview follows the finger
// until it lifts.
function touchDown(p) {
  const snap = snapTouch(p.x, p.y);
  const head = B.chainHead;
  // Where a beam would come FROM: the chain head if a run is live, else the
  // joint under the finger, else nothing (an open-ground press previews a node).
  const from = head || ((snap.kind === 'node' || snap.kind === 'anchor') ? snap : null);

  B.drag = {
    mode: 'touchbuild',
    touch: true,
    start: from,             // named `start` so cleanupOrphans keeps protecting it
    from,
    px0: p.px, py0: p.py, t0: now(),
    lx: p.x, ly: p.y,
    x0: p.x, y0: p.y,
    last: snap,
    snapped: false,
    moved: false,
    holdNodeId: snap.kind === 'node' ? snap.nodeId : null,
  };
  B.ghost = null;
  clearMarquee();
  // Publish the snap immediately: on the very first contact the snap ring IS
  // the answer to "where will this land?", and the loupe magnifies it.
  B.hover = { x: p.x, y: p.y, snap };
  updatePreview(snap);
}

// ---- pointer move ---------------------------------------------------------

function onMove(p) {
  const S = getScene();
  if (S.phase !== 'build' || !B.design) return;

  if (B.nodeDrag) { nodeDragMove(p); return; }    // a lifted node owns the pointer

  if (!B.drag) {                                  // hover (mouse only, cosmetic)
    if (p.hover) {
      B.hover = { x: p.x, y: p.y, snap: snapPoint(p.x, p.y, B.design, B.terrain, { chainNodeId: B.chainNodeId }) };
      const del = B.tool === 'erase' || B.tool === 'boxdelete';
      B.hoverMember = hitTestMember(p.x, p.y, B.design, tolerance(del ? CONFIG.build.eraseTolMul : 1));
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

  if (B.drag.mode === 'boxdelete') {
    // nothing is deleted while dragging: the marquee + its hit list ARE the
    // preview, and the whole section goes on release
    if (B.drag.moved) setMarquee(B.drag.x0, B.drag.y0, p.x, p.y);
    else clearMarquee();
    return;
  }

  // A press that stayed put on an existing node long enough LIFTS it (mouse and
  // touch alike). This is checked here rather than on a timer so the builder
  // stays free of the frame clock: the promotion happens on the first move
  // after the hold, which is also the first moment the node has anywhere to go.
  if (B.drag.holdNodeId && holdCheck(travel)) { nodeDragMove(p); return; }

  if (B.drag.mode === 'touchbuild') { touchMove(p); return; }

  if (!B.drag.moved) { B.ghost = null; return; }
  // no chain bonus on the far end: that radius exists to make STARTING a
  // follow-up drag forgiving, and would otherwise pull short members back home
  const end = snapPoint(p.x, p.y, B.design, B.terrain);
  B.drag.last = end;
  B.hover.snap = end;
  updateGhost(end);
}

// Sliding a touch press only ever re-snaps the preview: adjust, then lift.
function touchMove(p) {
  const snap = snapTouch(p.x, p.y);
  B.drag.last = snap;
  B.hover = { x: p.x, y: p.y, snap };
  updatePreview(snap);
}

// The preview under a live touch press: a beam from the gesture's origin to the
// snapped fingertip, or — with no origin, or while the beam would be a
// zero-length stub — nothing but the snap mark the renderer draws from B.hover.
function updatePreview(end) {
  const from = B.drag && B.drag.from;
  if (!from || samePoint(from, end)) { B.ghost = null; return; }
  updateGhost(end);
}

// ---- pointer up -----------------------------------------------------------

function onUp(p) {
  const drag = B.drag;
  const ghost = B.ghost;
  B.drag = null;
  B.ghost = null;
  if (B.nodeDrag) { finishNodeDrag(p); return; }
  if (!drag || drag.mode === 'dead' || !B.design) { clearMarquee(); if (drag) cleanupOrphans(); return; }

  if (drag.mode === 'erase') { cleanupOrphans(); return; }

  if (drag.mode === 'boxdelete') {
    const hits = B.marqueeHits;
    const boxed = !!B.marquee;
    clearMarquee();
    if (p.cancel) { cleanupOrphans(); return; }   // pinch-cancel: nothing dies
    const travelBox = Math.hypot(p.px - drag.px0, p.py - drag.py0);
    if (boxed && travelBox >= CONFIG.build.dragMinPx) deleteMembers(hits);
    else eraseAt(p.x, p.y);                       // tap = single-member erase
    cleanupOrphans();
    return;
  }

  if (p.cancel) { cleanupOrphans(); return; }     // pinch-cancel: never place

  if (drag.mode === 'touchbuild') { touchCommit(p, drag); cleanupOrphans(); return; }

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

// THE commit point of touch building: the finger has left the glass, and where
// it left is what gets built. Four outcomes, in this order:
//   1. a TAP on the chain head finishes the run (this is the "done" gesture);
//   2. a press that had no origin claims its lift point as a PENDING head;
//   3. a beam that would be a stub either adopts its joint as the head (so a
//      tap on existing work starts a run) or does nothing;
//   4. otherwise: place the beam, and the far end becomes the head.
// An invalid beam hints and places nothing — and leaves the chain exactly as it
// was, so a refusal costs the player a tap, not their run.
function touchCommit(p, drag) {
  const end = snapTouch(p.x, p.y);
  const tap = Math.hypot(p.px - drag.px0, p.py - drag.py0) <= CONFIG.touch.tapMaxPx * dpr();
  const head = B.chainHead;

  if (head && tap && samePoint(head, end)) { B.chainHead = null; return; }
  if (!drag.from) { B.chainHead = headAt(end); return; }
  if (samePoint(drag.from, end)) {
    if (!head && tap) B.chainHead = headAt(drag.from);
    return;
  }
  placeMember(drag.from, end, true);
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

// ---- node dragging (mouse + touch, build tool) ----------------------------
//
// The design nodes ARE the geometry, so a lifted node is moved in place and
// every attached member follows it for free — including in the cost readout and
// the renderer. That is also why the move has to be reversible to the metre:
// `orig` is the position the release restores when the drop is illegal, and the
// position the ONE undo step snapshots when it is legal.

// True when the press has earned the lift. Called on every move of a press that
// started on a node: past holdSlopPx before holdMs the gesture is a slide (draw
// a beam), and the candidate is dropped for good.
function holdCheck(travel) {
  const d = B.drag;
  const T = CONFIG.touch;
  if (now() - d.t0 < T.holdMs) {
    if (travel > T.holdSlopPx * dpr()) d.holdNodeId = null;
    return false;
  }
  if (startNodeDrag(d.holdNodeId, !!d.touch)) return true;
  d.holdNodeId = null;
  return false;
}

function startNodeDrag(nodeId, touch) {
  const n = nodeById(nodeId);
  if (!n) return false;
  const members = [];
  for (const m of B.design.members) if (m.a === nodeId || m.b === nodeId) members.push(m.id);
  if (!members.length) return false;          // nothing attached: nothing to move
  B.nodeDrag = {
    nodeId, touch: !!touch, members,
    orig: { x: n.x, y: n.y, anchorId: n.anchorId || null },
    x: n.x, y: n.y, anchorId: n.anchorId || null,
    ok: true, reason: '',
  };
  B.ghost = null;
  return true;
}

function nodeDragMove(p) {
  const nd = B.nodeDrag;
  const snap = snapPoint(p.x, p.y, B.design, B.terrain, {
    radiusMul: nd.touch ? CONFIG.touch.snapMul : 1,
    ignoreNodeId: nd.nodeId,
    // anchors and the grid only: dropping this node exactly onto another one
    // would leave a coincident pair, which is not a joint
    noNodes: true,
  });
  const n = nodeById(nd.nodeId);
  if (!n) { B.nodeDrag = null; return; }
  n.x = snap.x; n.y = snap.y; n.anchorId = snap.anchorId || null;
  nd.x = n.x; nd.y = n.y; nd.anchorId = n.anchorId; nd.snap = snap;
  const v = validateNode(n);
  nd.ok = v.ok; nd.reason = v.reason;
  B.hover = { x: p.x, y: p.y, snap };
}

// Is the design legal with this node where it now is? What a move can break: a
// beam grown past what its material may span (or shrunk under it), the budget
// (grown lengths cost money, which is why the WHOLE design is re-costed), the
// build zone, the ground, and the one thing snapping cannot prevent — landing
// exactly on top of another joint. The node drag deliberately does not snap to
// other nodes (a coincident pair is not a joint), so a drop that lands on one
// anyway, by grid or by a shared anchor, is refused rather than silently made.
function validateNode(n) {
  const cfg = CONFIG.build;
  if (B.level && B.level.buildZone) {
    const z = B.level.buildZone;
    if (n.x < z.x0 - 1e-6 || n.x > z.x1 + 1e-6) return { ok: false, reason: 'outside build zone' };
  }
  if (B.terrain && B.terrain.heightAt && n.y < B.terrain.heightAt(n.x) - cfg.groundTol) {
    return { ok: false, reason: 'underground' };
  }
  for (const q of B.design.nodes) {
    if (q.id === n.id) continue;
    if (Math.hypot(q.x - n.x, q.y - n.y) <= cfg.mergeEps ||
        (n.anchorId && q.anchorId === n.anchorId)) {
      return { ok: false, reason: 'another joint there' };
    }
  }
  for (const m of B.design.members) {
    if (m.a !== n.id && m.b !== n.id) continue;
    const other = nodeById(m.a === n.id ? m.b : m.a);
    const mat = MATERIALS[m.mat];
    if (!other || !mat) continue;
    const len = Math.hypot(other.x - n.x, other.y - n.y);
    if (len > mat.maxLength) return { ok: false, reason: 'too long' };
    if (len < mat.minLength) return { ok: false, reason: 'too short' };
  }
  if (B.level && designCost(B.design) > B.level.budget + cfg.budgetEps) {
    return { ok: false, reason: 'over budget' };
  }
  return { ok: true, reason: '' };
}

function finishNodeDrag(p) {
  const nd = B.nodeDrag;
  B.nodeDrag = null;
  B.ghost = null;
  const n = nodeById(nd.nodeId);
  if (!n) return;

  const to = { x: n.x, y: n.y, anchorId: n.anchorId || null };
  const moved = to.x !== nd.orig.x || to.y !== nd.orig.y || to.anchorId !== nd.orig.anchorId;
  putNodeBack(n, nd);                            // always: history is authored
                                                 // from the pre-lift state
  if ((p && p.cancel) || !nd.ok || !moved) {
    if (!nd.ok && nd.reason) hint(nd.reason);    // a red drop says why
    return;
  }
  pushUndo();
  n.x = to.x; n.y = to.y; n.anchorId = to.anchorId;
  syncChainHead(n);
  emit('design:change', { action: 'move', id: nd.nodeId });
}

function putNodeBack(n, nd) {
  n.x = nd.orig.x; n.y = nd.orig.y; n.anchorId = nd.orig.anchorId;
  syncChainHead(n);
}

// Revert an in-flight lift without committing anything (tool switch, phase
// change, undo, a key delete that took the member out from under it).
function abortNodeDrag() {
  const nd = B.nodeDrag;
  if (!nd) return;
  B.nodeDrag = null;
  const n = nodeById(nd.nodeId);
  if (n) putNodeBack(n, nd);
}

// The chain head is a COPY of a point, so a node that moves takes its head with
// it (and a head naming a node that died is dropped in cleanupOrphans).
function syncChainHead(n) {
  const h = B.chainHead;
  if (h && h.nodeId === n.id) { h.x = n.x; h.y = n.y; h.anchorId = n.anchorId || null; }
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

// ---- box delete (section marquee) -----------------------------------------

// Live preview: a normalized world rect plus the ids it would take. Recomputed
// from scratch every move — the design can change under it (undo, a key delete)
// and a stale hit list would delete the wrong section on release.
function setMarquee(ax, ay, bx, by) {
  B.marquee = {
    x0: Math.min(ax, bx), y0: Math.min(ay, by),
    x1: Math.max(ax, bx), y1: Math.max(ay, by),
  };
  B.marqueeHits = hitTestMembersInRect(
    B.marquee.x0, B.marquee.y0, B.marquee.x1, B.marquee.y1,
    B.design, CONFIG.build.marqueeHitPad,
  );
}

function clearMarquee() {
  B.marquee = null;
  if (B.marqueeHits.length) B.marqueeHits = [];
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
    // X toggles the section box. Escape is deliberately NOT bound here: game.js
    // already leaves the level on Escape from the build phase, and the
    // phase:change that follows cancels the drag (marquee discarded, nothing
    // deleted). Two meanings on one key would be worse than none.
    case 'x': case 'X': setTool(B.tool === 'boxdelete' ? 'build' : 'boxdelete'); break;
    case 'b': case 'B': setTool('build'); break;
    case 'z': undo(); break;
    case 'Z': redo(); break;
    case 'y': case 'Y': redo(); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    default: break;
  }
}
