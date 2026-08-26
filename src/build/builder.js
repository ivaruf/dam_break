// OPUS B owns. Design editing: place/connect/delete/select/ghost/undo.
// Contract: ARCHITECTURE.md §10. Mutates the design object owned by game.js.
//
// Pointer model (nothing core depends on hover):
//   press + drag  → ghost member from the snapped start to the snapped end,
//                   placed on release if valid
//   press + tap    → select the member under the finger (or clear the selection)
//   right button   → delete the member under the cursor (mouse only)
//   erase tool     → press/drag deletes every member the path touches
//   boxdelete tool → press/drag draws a marquee; release deletes the whole
//                    SECTION inside it as one undo step (a tap falls back to the
//                    single-member erase, so the tool is never a dead zone)
// After a placement the far endpoint becomes the "chain node": its snap radius
// grows (CONFIG.build.chainSnapMul) so a quick follow-up drag continues the run.
//
// TOUCH AIMING v2 (build tool + `ptype:'touch'` only — see CONFIG.touch).
// A mouse hovers before it commits and a cursor hides nothing. A finger does
// neither: its first contact blindly commits the beam START, and it lands on
// exactly the spot the player is trying to see. So for a touch build gesture:
//   • OFFSET CURSOR — the active point floats CONFIG.touch.cursorOffsetPx above
//     the fingertip and ALL snapping/ghost geometry uses the cursor, never the
//     fingertip. Near the top edge the offset shrinks smoothly (never jumps).
//   • DEFERRED START — pointer-down does not lock anything. The gesture opens
//     in state 'aiming' with a PROVISIONAL start that re-snaps to the cursor as
//     the finger slides (the player fine-positions while watching the loupe).
//     Once the cursor has travelled CONFIG.touch.startCommitPx and the ghost
//     would have a direction, the start locks where it was last snapped and the
//     normal drag-to-draw takes over. A release while still aiming is a TAP, at
//     the RAW fingertip (a fat contact patch is an asset for tapping).
// Mouse and pen keep the original path exactly: no ptype means mouse.
// The render layer reads B.touchAim (world + screen cursor, snap kind, aiming).

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
  touchAim: null,         // touch build gesture only, for the render layer:
                          // {x, y, px, py, kind, aiming} — the offset AIM
                          // CURSOR in world metres AND device px, the snap kind
                          // under it ('node'|'anchor'|'grid'), and whether the
                          // start is still provisional. null for mouse/pen, for
                          // the erase/boxdelete tools, and between gestures.
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
  B.marquee = null; B.marqueeHits = [];
  B.hover = null; B.hoverMember = null; B.touchAim = null;
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
  dropMarquee();
  if (B.drag && B.drag.mode === 'build' && B.drag.moved && B.drag.last) updateGhost(B.drag.last);
}

// toggle=true (a UI button) re-sending the active non-build tool turns it off.
export function setTool(id, toggle) {
  const next = (toggle && id !== 'build' && B.tool === id) ? 'build' : id;
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
  const wasDrag = B.drag;
  B.drag = null;
  B.ghost = null;
  B.touchAim = null;
  clearMarquee();
  if (wasDrag && B.design) cleanupOrphans();
}

// ---- touch aim cursor -----------------------------------------------------
//
// Device pixels per CSS pixel. CONFIG.touch is specified in CSS px (it is a
// THUMB measurement, so it must mean the same thing on every screen) while
// input:* events carry device px. The builder has no canvas handle — camera.js
// closes over the element without exposing it — so read the live canvas the
// same way main.js and loupe.js do. No DOM (headless tests) means 1, which is
// exactly right: those drive device px directly.
let dprCanvas = null;

function dpr() {
  if (typeof document === 'undefined') return 1;
  if (!dprCanvas || dprCanvas.isConnected === false) {
    dprCanvas = (typeof document.getElementById === 'function' && document.getElementById('game'))
      || (typeof document.querySelector === 'function' && document.querySelector('canvas'))
      || null;
  }
  const c = dprCanvas;
  if (!c || !c.width || !c.clientWidth) return 1;
  const d = c.width / c.clientWidth;
  return d > 0.1 && d < 8 ? d : 1;
}

// The offset aim cursor for a touch gesture: {px, py} device px + {x, y} world.
// Returns null when the camera cannot unproject (a headless stub without
// screenToWorld) — the caller then keeps the plain fingertip behaviour, so a
// missing camera degrades to the mouse path rather than throwing.
function cursorAt(p) {
  const cam = getScene().camera;
  if (!cam || typeof cam.screenToWorld !== 'function') return null;
  const T = CONFIG.touch;
  const d = dpr();
  // The offset SHRINKS towards the top edge instead of being clamped there:
  // min() is continuous, so the cursor slides into the fingertip as the finger
  // approaches the HUD and never jumps mid-gesture. Floored at 0 — the cursor
  // is never BELOW the finger, and never above the clearance line unless the
  // finger already is.
  const off = Math.max(0, Math.min(T.cursorOffsetPx * d, p.py - T.topClearancePx * d));
  const px = p.px, py = p.py - off;
  const [x, y] = cam.screenToWorld(px, py);
  return { px, py, x, y };
}

// Fallback "cursor" that is just the fingertip (see cursorAt).
function fingerAt(p) { return { px: p.px, py: p.py, x: p.x, y: p.y }; }

function setTouchAim(cur, kind, aiming) {
  B.touchAim = { x: cur.x, y: cur.y, px: cur.px, py: cur.py, kind, aiming };
}

// Cursor travel that locks the start, in DEVICE px.
//
// startCommitPx is a screen distance, and it has to be: it is the difference
// between a thumb settling and a thumb pulling. But a screen distance is a
// world distance too, and on a zoomed-out portrait phone (level 2 fits its
// valley at ~7 px/m) 26 px is 3.7 m — more than concrete is ALLOWED to span,
// which would make concrete unplaceable by touch at the default framing. So the
// threshold is capped at commitMaxFrac of the material's longest legal beam:
// the gesture can always reach a beam this material is permitted to be. At any
// zoom where fine work is actually possible the cap is inert.
function commitPx() {
  const T = CONFIG.touch;
  const base = T.startCommitPx * dpr();
  const cam = getScene().camera;
  const mat = MATERIALS[B.material];
  const zoom = cam ? cam.zoom : 0;
  if (!mat || !mat.maxLength || !(zoom > 0)) return base;
  return Math.min(base, mat.maxLength * zoom * T.commitMaxFrac);
}

// "Meaningfully directional": the snapped end resolves to a different point
// than the provisional start. Both are quantised (node / anchor / 0.5 m grid),
// so this is the earliest moment a locked start can produce a beam that HAS a
// direction — commit before it and the gesture's first ghost is a zero-length
// stub sitting under the cursor.
function directional(a, b) {
  if (!a || !b) return false;
  if (a.nodeId && a.nodeId === b.nodeId) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) > CONFIG.build.mergeEps;
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
  const box = B.tool === 'boxdelete';

  // TOOL CHOICE (touch aiming v2): only the BUILD tool gets the offset cursor.
  // Erase and box-delete are coarse by nature — a sweep through members and a
  // marquee round a section — and both are aimed with the WHOLE contact patch,
  // not a point. Offsetting them would move the deletion 56 px away from the
  // thing the player is pointing at, which is the one place a surprise is
  // unforgivable. So those two stay on the raw fingertip, exactly as before.
  const touch = p.ptype === 'touch' && !eraser && !box;
  const cur = touch ? cursorAt(p) : null;
  const from = cur || fingerAt(p);
  const start = (eraser || box) ? null
    : snapPoint(from.x, from.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });

  B.drag = {
    mode: box ? 'boxdelete' : eraser ? 'erase' : 'build',
    start,
    px0: p.px, py0: p.py, t0: now(),
    lx: p.x, ly: p.y,
    x0: p.x, y0: p.y,        // marquee origin (box-delete)
    last: start,
    snapped: false,
    moved: false,
    // touch aiming (build tool only; false/unused for mouse, pen and the
    // delete tools, which therefore run the original code path untouched)
    touch: !!cur,
    aiming: !!cur,           // the start above is PROVISIONAL until it locks
    cpx0: from.px, cpy0: from.py,   // cursor origin for the commit test
  };
  B.ghost = null;
  B.touchAim = null;
  if (cur) {
    setTouchAim(cur, start.kind, true);
    // publish the provisional snap immediately: the renderer's snap mark is
    // what answers "where am I?" on the very first contact of a gesture, which
    // is the whole complaint touch aiming v2 exists to fix
    B.hover = { x: cur.x, y: cur.y, snap: start };
  }
  clearMarquee();            // the box only exists once the drag passes dragMinPx

  if (eraser) eraseAt(p.x, p.y);
}

function onMove(p) {
  const S = getScene();
  if (S.phase !== 'build' || !B.design) return;

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

  if (B.drag.touch) { touchMove(p); return; }      // offset cursor + deferred start

  if (!B.drag.moved) { B.ghost = null; return; }
  // no chain bonus on the far end: that radius exists to make STARTING a
  // follow-up drag forgiving, and would otherwise pull short members back home
  const end = snapPoint(p.x, p.y, B.design, B.terrain);
  B.drag.last = end;
  B.hover.snap = end;
  updateGhost(end);
}

// A touch build gesture. Everything geometric here is measured at the CURSOR;
// the fingertip only ever decides where the cursor is (and, on release while
// aiming, what was tapped).
function touchMove(p) {
  const d = B.drag;
  const cur = cursorAt(p) || fingerAt(p);

  if (d.aiming) {
    // Travel is the DISPLACEMENT from where the cursor started, not the path
    // length: fine-positioning wanders, and a wiggle that comes back to where
    // it began must still release as a tap.
    const travel = Math.hypot(cur.px - d.cpx0, cur.py - d.cpy0);
    if (travel >= commitPx()) {
      // The pull has begun: the start LOCKS where it was last snapped — the
      // point the player was aiming at, not the point they have now dragged to
      // — and this move becomes the drag's end.
      const end = snapPoint(cur.x, cur.y, B.design, B.terrain);
      if (directional(d.start, end)) {
        d.aiming = false;
        d.moved = true;
        d.last = end;
        B.hover = { x: cur.x, y: cur.y, snap: end };
        setTouchAim(cur, end.kind, false);
        updateGhost(end);
        return;
      }
      // not directional yet (still the same snap target): keep aiming
    }
    // still aiming: the provisional start follows the cursor, chain radius and
    // all, so a run can be continued from the endpoint just placed
    const s = snapPoint(cur.x, cur.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });
    d.start = s;
    d.last = s;
    d.moved = false;         // an aiming gesture has not "moved": no ghost yet,
                             // and a material switch must not conjure one
    B.ghost = null;
    B.hover = { x: cur.x, y: cur.y, snap: s };
    setTouchAim(cur, s.kind, true);
    return;
  }

  // committed: the normal drag-to-draw, with the end snapped at the cursor and
  // no chain bonus on it (same reason as the mouse path)
  const end = snapPoint(cur.x, cur.y, B.design, B.terrain);
  d.last = end;
  B.hover = { x: cur.x, y: cur.y, snap: end };
  setTouchAim(cur, end.kind, false);
  updateGhost(end);
}

function onUp(p) {
  const drag = B.drag;
  const ghost = B.ghost;
  B.drag = null;
  B.ghost = null;
  B.touchAim = null;
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

  // A touch build gesture has already decided what it is, so it does not go
  // through the mouse's tap/drag thresholds at all.
  if (drag.touch) {
    if (drag.aiming) {
      // The start never locked, so nothing was ever going to be built: this is
      // a TAP, judged at the RAW fingertip with the normal tolerance (a fat
      // contact patch is an ASSET for hitting a beam). No tapMaxMs gate either
      // — aiming is deliberate, and a slow, careful "no, nothing here" is
      // still a tap.
      B.selection = hitTestMember(p.x, p.y, B.design, tolerance());
      cleanupOrphans();
      return;
    }
    // Locked: the commit WAS the decision to draw a beam. The mouse needs
    // tapMaxPx/dragMinPx because its press commits a start and it must still
    // tell a click from a drag; here the lock has already done that, and at a
    // far-out zoom commitPx is capped below tapMaxPx anyway — gating on it
    // would silently throw away a beam the player watched themselves draw.
    const at = cursorAt(p) || fingerAt(p);
    const cEnd = (ghost && ghost.end) || snapPoint(at.x, at.y, B.design, B.terrain, { chainNodeId: B.chainNodeId });
    placeMember(drag.start, cEnd);
    cleanupOrphans();
    return;
  }

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
