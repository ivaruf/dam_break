// OPUS B owns. Design editing: place/connect/delete/select/ghost/undo.
// Contract: ARCHITECTURE.md §10. Mutates the design object owned by game.js.
//
// ===========================================================================
// BUILDING v4 — THE REACH CIRCLE.  ONE model, mouse and touch alike.
// ===========================================================================
// The old model refused placements with words: TOO LONG, UNDERGROUND, OUTSIDE
// BUILD ZONE. Every one of those is a nag about a rule the player could not see.
// v4 turns the rules into geometry instead, and then the nagging has nothing
// left to say:
//
//   1. STARTS ARE ANCHORED. A build gesture may only START on a terrain anchor
//      or an existing design joint — i.e. on structure that is transitively
//      attached to the ground. There is no such thing as a free start on empty
//      ground any more, on any input. (The first beam of a dam therefore starts
//      at an anchor, which is also the one true sentence about dams.)
//   2. ARMING draws THE REACH CIRCLE, centred on that start, of radius
//      material.maxLength — always, never scaled by money. The part of it a
//      beam may actually land in is LIT; the rest is dark and hatched
//      (geometry) or amber (unaffordable). See CONFIG.reach and
//      snapping.classifyReach — the picture is sampled FROM validate(), so it
//      cannot disagree with it.
//   3. COMPLETING: a click/tap anywhere in the circle builds from the armed
//      start to the SNAPPED point — and THE CIRCLE GOES. One girder, two clicks,
//      and afterwards nothing is armed at all. A press-drag-release inside the
//      circle does the same thing in one gesture (desktop speed). Every commit
//      is one pushUndo.
//   4. CHAINING IS JUST REPETITION. The endpoint a commit leaves behind is a
//      real design node, so clicking it arms the next circle. Two clicks per
//      girder, the same two clicks every time — no sticky state to be in, and
//      no gesture that means "I am done" because nothing is ever unfinished.
//   5. Clicks OUTSIDE the circle: on another anchor/joint → arm there instead;
//      on a member → select it; on empty ground → dismiss the circle. A click on
//      the armed start itself dismisses it too — that is the cheap "never mind",
//      not a chain-ending gesture. A click on a REFUSING slice inside the circle
//      pulses that slice — red for geometry, amber for money — places nothing,
//      and leaves the circle up, because a refusal should cost one click.
//   6. A DRAG from a press that cannot build (no completion, no joint) PANS the
//      camera — one finger / one button, so nobody two-finger-scrolls or zooms
//      out and in again just to move around. The pan gate is tapMax, so a
//      gesture is never both a pan and a tap — and a pan never dismisses the
//      circle: navigation costs nothing (the dismissal in rule 5 waits for the
//      release and only a TAP confirms it).
//
// What is left of the old vocabulary, unchanged:
//   right button   → delete the member under the cursor
//   erase tool     → press/drag deletes every member the path touches
//   boxdelete tool → press/drag draws a marquee; release deletes the whole
//                    SECTION inside it as one undo step (a tap falls back to the
//                    single-member erase, so the tool is never a dead zone)
//   NODE DRAGGING (mouse AND touch, build tool): press-and-HOLD on an existing
//                    design node (CONFIG.touch.holdMs, travel under holdSlopPx)
//                    lifts it; it follows the snapped pointer with every
//                    attached member recomputed live, and the release either
//                    commits the move as ONE undo step or reverts it whole.
//
// Snapping to nodes and anchors is CONFIG.touch.snapMul stronger for a touch
// gesture (the grid stays 0.5 m), so a fingertip pops onto a joint instead of
// drifting past it. The loupe (rendering/loupe.js) magnifies the fingertip.
//
// GONE with v2.5: pending chain heads on empty ground, the touchbuild drag
// mode, and the press-adjust-lift branch that let a grid point start a run.
// GONE with the chain itself: any state that outlives a commit. The armed start
// is live only while its circle is, and every commit takes both down.
//
// The render layer reads B.reach, B.chainHead, B.reachPulse and B.nodeDrag
// (see the state block).

import { CONFIG } from '../config.js';
import { on, emit } from '../core/events.js';
import { getScene } from '../core/game.js';
import {
  snapPoint, snapEnd, validate, hitTestMember, hitTestMembersAlong, hitTestMembersInRect, hitTol,
  reachRadius, affordRadius,
} from './snapping.js';
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
  chainNodeId: null,      // endpoint of the member just placed. v4 arms that
                          // endpoint outright, so its old job — a wider snap
                          // radius for starting a follow-up drag near it — is
                          // gone (see buildDown), and so is the auto re-arm it
                          // used to feed. It survives in the undo snapshot.
  chainHead: null,        // THE ARMED START (v4), for the render layer + the HUD:
                          //   null | {x, y, nodeId|null, anchorId|null, kind}
                          // the joint the LIVE circle is centred on, and the
                          // only thing a click inside it can build from. ALWAYS
                          // a real anchor or a real design node — never a
                          // claimed point on open ground, which is what v2.5's
                          // `pending` head was and what v4 deletes outright.
                          // ALWAYS null once a girder commits: it exists exactly
                          // as long as B.reach does, never a moment longer.
                          // Cleared by a commit, a click on itself, a click on
                          // empty ground outside the circle, a tool switch, a
                          // phase change, undo/redo/clear, or the node under it
                          // disappearing.
  reach: null,            // THE REACH CIRCLE — the armed start as GEOMETRY:
                          //   null | {x, y, nodeId, anchorId, kind,
                          //           r, rAfford, material, touch,
                          //           t01, seq, version}
                          // r        = material.maxLength (never budget-scaled)
                          // rAfford  = metres this budget still buys; the amber
                          //            band is the annulus beyond it
                          // t01      = expansion progress 0..1, advanced by the
                          //            RENDERER off its frame counter (the
                          //            builder owns no clock) and published here
                          // seq      = bumped on every arm — the renderer
                          //            restarts the expansion when it changes
                          // version  = bumped whenever the lit region could have
                          //            moved (material, budget, design), so the
                          //            renderer knows to re-sample it
  reachPulse: null,       // null | {kind:'bad'|'budget'|'local', x, y, seq}
                          // a click the rules refused. The renderer flashes it
                          // once — 'bad' = the dark slices (a beam cannot go
                          // there), 'budget' = the amber band (you cannot afford
                          // that far), 'local' = a mark at the click itself, for
                          // the refusals the circle does not draw (already
                          // built, overlaps a member). Only 'budget' also writes
                          // to the hint line; otherwise the picture is the whole
                          // answer.
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
export function getReach() { return B.reach; }
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

// ---- the armed start + its reach circle -----------------------------------
//
// Arming is the whole of v4's state: a start, and the circle that says what it
// can reach. `seq` restarts the renderer's expansion animation, `version` tells
// it the LIT REGION may have moved (material, money or design) and must be
// re-sampled. Neither is a clock — this module owns no frame counter and never
// will; the renderer advances reach.t01 off its own frame count.

let reachSeq = 0;          // monotonic: one per arm
let pulseSeq = 0;          // monotonic: one per refused click
let designSeq = 0;         // monotonic: one per structural edit

function designChanged() { designSeq++; }

// Arm a run at a snapped point. Refuses anything that is not a real anchor or a
// real design node: v4 has no free starts, so "arm on empty ground" is not a
// state that can exist rather than one that is merely discouraged.
function armReach(pt, touch) {
  if (!pt || (!pt.nodeId && !pt.anchorId)) { disarm(); return false; }
  const mat = MATERIALS[B.material];
  B.chainHead = headAt(pt);
  B.reach = {
    x: pt.x, y: pt.y,
    nodeId: pt.nodeId || null,
    anchorId: pt.anchorId || null,
    kind: pt.nodeId ? 'node' : 'anchor',
    r: reachRadius(mat),
    rAfford: affordRadius(mat, budgetLeft()),
    material: B.material,
    touch: !!touch,
    t01: 0,
    seq: ++reachSeq,
    version: 0,
    designSeq,
  };
  B.reachPulse = null;
  return true;
}

function disarm() {
  B.chainHead = null;
  B.reach = null;
  B.reachPulse = null;
}

// Re-measure the live circle. Radius follows the MATERIAL (never the budget —
// reach is physics); the affordable radius follows the money; the version bumps
// only when one of those, or the design itself, actually moved, so the renderer
// re-samples the region when it must and not once per pointer-up.
function refreshReach() {
  const rc = B.reach;
  if (!rc) return;
  const mat = MATERIALS[B.material];
  const r = reachRadius(mat);
  const ra = affordRadius(mat, budgetLeft());
  if (rc.material === B.material && rc.r === r && rc.rAfford === ra && rc.designSeq === designSeq) return;
  rc.material = B.material;
  rc.r = r;
  rc.rAfford = ra;
  rc.designSeq = designSeq;
  rc.version++;
}

// A click the rules refused, recorded for the renderer to flash once.
function pulse(kind, x, y) {
  B.reachPulse = { kind, x, y, seq: ++pulseSeq };
}

// Is this world point inside the armed circle? The RAW point, not the snapped
// one: the drawn circle is what the player is aiming at, and a click past its
// edge means "start a new run over there", not "build a beam to there". The rim
// band counts as inside — the rim is a snap target now (snapOptsFor), and a
// click that will land ON the edge must complete, not dismiss: half the presses
// aimed at the drawn line fall a few pixels outside it.
function inReach(x, y, touch) {
  const rc = B.reach;
  if (!rc) return false;
  const tol = CONFIG.build.rimSnap * (touch ? CONFIG.touch.snapMul : 1);
  return Math.hypot(x - rc.x, y - rc.y) <= rc.r + tol;
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
  // Leaving the build phase ends everything in flight, the armed run included:
  // a reach circle over a running simulation is a promise nothing can keep.
  on('phase:change', ({ phase }) => { if (phase !== 'build') { cancelDrag(); disarm(); } });
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
  B.reach = null;
  B.reachPulse = null;
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

// Picking a material never ends a run: it re-sizes the circle the run is
// standing in. Reach is a property of the material, so switching from timber to
// cable makes the circle bigger under the player's finger, live, and the amber
// affordability band moves with it — that IS the material comparison, drawn.
export function setMaterial(id) {
  if (!MATERIALS[id]) return;
  B.material = id;
  B.tool = 'build';            // picking a material always means "build"
  dropMarquee();
  refreshReach();
  if (B.drag && B.drag.mode === 'build' && B.drag.last) updateGhost(B.drag.last);
}

// toggle=true (a UI button) re-sending the active non-build tool turns it off.
export function setTool(id, toggle) {
  const next = (toggle && id !== 'build' && B.tool === id) ? 'build' : id;
  // Switching tools DISARMS the run: the circle is a promise about what the next
  // click will build, and reaching for the eraser withdraws it. Picking a
  // material does not (that sets B.tool directly, and is still building).
  //
  // Pressing the BUILD button itself disarms too, even though the tool does not
  // change: it is the toolbar's "never mind" — and it is the escape hatch for a
  // run armed somewhere the player can no longer reach (scrolled off screen).
  // `toggle` is only true for a real UI press, so the internal setTool('build')
  // calls do not.
  if (toggle && next === 'build') disarm();
  if (next !== B.tool) disarm();
  // A node in the air and a live build gesture both belong to a run that has
  // just been called off, so they are abandoned with it (the node goes back
  // where it was). A gesture cannot outlive the start it was building from.
  if (!B.chainHead && (B.nodeDrag || (B.drag && B.drag.mode === 'build'))) cancelDrag();
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
// committed), and the armed run is disarmed: the design its circle was drawn
// against has just changed under it.
export function undo() {
  if (!B.design || !B.undo.length) return false;
  abortNodeDrag();
  B.redo.push(snapshot());
  if (B.redo.length > CONFIG.build.undoDepth) B.redo.shift();
  restore(B.undo.pop());
  cancelDrag();
  disarm();
  return true;
}

export function redo() {
  if (!B.design || !B.redo.length) return false;
  abortNodeDrag();
  B.undo.push(snapshot());
  if (B.undo.length > CONFIG.build.undoDepth) B.undo.shift();
  restore(B.redo.pop());
  cancelDrag();
  disarm();
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
  disarm();
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
  // an armed start or a lifted node whose node is gone is a dangling promise
  if (B.chainHead && B.chainHead.nodeId && !nodes.some((n) => n.id === B.chainHead.nodeId)) {
    disarm();
  }
  if (B.nodeDrag && !nodes.some((n) => n.id === B.nodeDrag.nodeId)) B.nodeDrag = null;
  refreshReach();          // the design changed: so did the budget and the region
}

// The one and only way a member is born. A refusal PULSES the slice the player
// clicked instead of writing a sentence at them — except for 'over budget',
// which is the one refusal the circle cannot fully explain on its own (the
// amber band says where, the hint says how much) and the one the player asked
// to keep. Returns the member, or null.
function placeMember(start, end) {
  const mat = MATERIALS[B.material];
  const v = validate(start, end, mat, B.design, B.terrain, B.level, budgetLeft());
  if (!v.ok) { refuse(v.reason, end); return null; }

  pushUndo();
  const a = ensureNode(start);
  const b = ensureNode(end);
  if (a === b) { B.undo.pop(); cleanupOrphans(); return null; }

  const m = { id: 'm' + B.nextId++, a, b, mat: B.material };
  B.design.members.push(m);
  B.chainNodeId = b;
  B.selection = null;
  designChanged();
  emit('design:change', { action: 'place', id: m.id });
  return m;
}

// The refusals the CIRCLE cannot show, because they are about the design rather
// than the place: this beam already exists, or it would leave its neighbour at
// under minAngleDeg. They are why a click is still checked in full — see
// snapping.reachGeom for why they are deliberately not drawn.
const SOCIAL = ['same point', 'already built', 'overlaps a member'];

// A placement the rules refused. `end` is where the player aimed, so the
// renderer can flash the right thing: the amber band for money, the dark slices
// for a place a beam cannot go, and — for a refusal with no region of its own —
// a small mark at the click itself, which is the honest answer to "something
// said no, but not the ground and not the wallet".
function refuse(reason, end) {
  const budget = reason === 'over budget';
  const kind = budget ? 'budget' : SOCIAL.indexOf(reason) >= 0 ? 'local' : 'bad';
  pulse(kind, end ? end.x : 0, end ? end.y : 0);
  if (budget) hint(reason);
}

export function deleteMember(id) {
  const i = B.design ? B.design.members.findIndex((m) => m.id === id) : -1;
  if (i < 0) return false;
  B.design.members.splice(i, 1);
  if (B.selection === id) B.selection = null;
  designChanged();
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
  designChanged();
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

// The snap options a gesture uses, mouse or touch. Node and anchor radii are
// CONFIG.touch.snapMul wider for a finger so a joint POPS under it; the grid
// stays 0.5 m on every input, because a grid is a quantisation, not a target.
//
// Deliberately NO chain bonus (CONFIG.build.chainSnapMul) on the far end of a
// gesture: that bonus exists to make STARTING near a fresh endpoint forgiving,
// and stacking 1.7 on top of snapMul would give the armed start a 2 m radius —
// swallowing every click that meant "beam to here" and reading it as "tap the
// start, finish the run" instead. Within a node's plain snap radius, a click
// means THAT node: that is the honest rule and the one the circle draws.
//
// While a run is ARMED, the circle's own rim rides along as a snap target
// (CONFIG.build.rimSnap): a click near the edge lands ON it, at exactly
// maxLength — the whole rim means "the longest beam this material has". The
// renderer samples the region with these same opts, so the picture pops to the
// rim exactly where a click would.
export function snapOptsFor(touch) {
  const rc = B.reach;
  if (!touch && !rc) return undefined;
  const o = touch ? { radiusMul: CONFIG.touch.snapMul } : {};
  if (rc) o.rim = { x: rc.x, y: rc.y, r: rc.r };
  return o;
}

function snapAt(x, y, touch) {
  return snapPoint(x, y, B.design, B.terrain, snapOptsFor(touch));
}

// The END of a build gesture from `from`: the same snap, plus the boundary
// repair (snapping.snapEnd) — a refused grid point near the ground, the zone
// edge or the rim slides onto it, so the click builds the thing it meant and
// the drawn shadow's edge is the true line, not a staircase of grid rounding.
function snapEndAt(from, x, y, touch) {
  return snapEnd(from, x, y, MATERIALS[B.material], B.design, B.terrain, B.level, snapOptsFor(touch));
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

// An armed-start record from any snapped point or design node. There is no
// 'grid' kind any more: a point that is neither a node nor an anchor cannot arm.
function headAt(pt) {
  if (!pt) return null;
  const nodeId = pt.id || pt.nodeId || null;
  return {
    x: pt.x, y: pt.y,
    nodeId,
    anchorId: pt.anchorId || null,
    kind: nodeId ? 'node' : 'anchor',
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

  // TOOL CHOICE: erase and box-delete are coarse by nature — a sweep through
  // members, a marquee round a section — and both are aimed with the whole
  // contact patch, so they keep the raw pointer and the original code path,
  // mouse and touch alike. Only the BUILD tool goes through the reach circle.
  if (!eraser && !box) { buildDown(p); return; }

  B.drag = {
    mode: box ? 'boxdelete' : 'erase',
    start: null,
    px0: p.px, py0: p.py, t0: now(),
    lx: p.x, ly: p.y,
    x0: p.x, y0: p.y,        // marquee origin (box-delete)
    last: null,
    snapped: false,
    moved: false,
    touch: p.ptype === 'touch',
    holdNodeId: null,
  };
  B.ghost = null;
  clearMarquee();            // the box only exists once the drag passes dragMinPx

  if (eraser) eraseAt(p.x, p.y);
}

// A build press — THE gesture, identical on mouse, pen and touch. It decides one
// thing: what is this press FROM? There are exactly four answers, and three of
// them build nothing.
//
//   • inside the armed circle  → the press is a COMPLETION. It previews a beam
//     from the armed start and commits on release, wherever the pointer has got
//     to by then (so a tap and a drag are the same gesture at different speeds).
//   • on an anchor or a joint  → ARM there. A circle already up somewhere else is
//     replaced: clicking a different foundation means "start over there".
//   • nothing armed, or the press is outside the circle, and it is not on a
//     joint → the press CANNOT BUILD, so its drag is free to mean the other
//     thing a drag on a map means: PAN. A tap still selects the member under
//     it (or dismisses the circle); a drag moves the camera — one finger, one
//     button, no two-finger scroll or zoom-out-zoom-in detour — and because
//     navigation must cost nothing, a pan does NOT dismiss the circle: the
//     dismissal waits for the release and only a tap confirms it.
//
// Nothing is committed here and nothing is locked in: a press only ever chooses
// a preview.
function buildDown(p) {
  const touch = p.ptype === 'touch';
  // Deliberately the SAME snap the release and the renderer's region sampling
  // use — no chainNodeId bonus anywhere in a build gesture. That bonus existed
  // so a mouse could START a follow-up drag near the endpoint it had just
  // placed; v4 has already armed that endpoint, so all the bonus could do now
  // is give the armed start a 1 m radius and swallow every click that meant
  // "beam to here". It would also make the down-snap differ from the snap the
  // circle was drawn with, and then a lit point could refuse — which is the one
  // thing this model may never do.
  const snap = snapAt(p.x, p.y, touch);
  const joint = (snap.nodeId || snap.anchorId) ? snap : null;
  const armed = !!B.chainHead;
  const inside = armed && inReach(p.x, p.y, touch);

  let from = null;
  let fresh = false;
  let dismiss = false;
  if (armed && inside) {
    from = B.chainHead;
    // the drawn region must snap the way THIS gesture snaps: a circle armed by
    // mouse and then pressed by a finger has to be re-sampled with the fatter
    // touch radii, or the picture would answer a question nobody asked
    if (B.reach && B.reach.touch !== touch) { B.reach.touch = touch; B.reach.version++; }
  } else if (joint) {
    armReach(joint, touch);
    from = B.chainHead;
    fresh = true;
  } else if (armed) {
    dismiss = true;          // outside, on empty or on a member: a TAP dismisses
  }                          // on release — a drag is a pan and keeps the circle

  // the gesture end takes the boundary repair; the arming/lift decisions above
  // deliberately used the plain snap (a repaired point is never a joint)
  const end = from ? snapEndAt(from, p.x, p.y, touch) : snap;

  B.drag = {
    mode: 'build',
    touch,
    start: from,             // named `start` so cleanupOrphans keeps protecting it
    from,
    fresh,                   // this press is what armed the circle
    dismiss,                 // this press means "never mind" IF it stays a tap
    panning: false,          // a from-less drag past tapMax moves the camera
    px0: p.px, py0: p.py, t0: now(),
    lpx: p.px, lpy: p.py,    // last pointer position, for pan deltas
    lx: p.x, ly: p.y,
    x0: p.x, y0: p.y,
    last: end,
    snapped: false,
    moved: false,
    holdNodeId: snap.kind === 'node' ? snap.nodeId : null,
  };
  B.ghost = null;
  clearMarquee();
  // Publish the snap immediately: on the very first contact the snap ring IS
  // the answer to "where will this land?", and the loupe magnifies it.
  B.hover = { x: p.x, y: p.y, snap: end };
  updateGhost(end);
}

// ---- pointer move ---------------------------------------------------------

function onMove(p) {
  const S = getScene();
  if (S.phase !== 'build' || !B.design) return;

  if (B.nodeDrag) { nodeDragMove(p); return; }    // a lifted node owns the pointer

  if (!B.drag) {                                  // hover (mouse only, cosmetic)
    if (p.hover) {
      // the hover mark shows exactly where a click would land: same snap, no
      // bonus — and with a run armed, the same boundary repair the click gets
      B.hover = {
        x: p.x, y: p.y,
        snap: B.chainHead ? snapEndAt(B.chainHead, p.x, p.y, false) : snapAt(p.x, p.y, false),
      };
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

  // No start to build from: the drag PANS. One finger or one button moves the
  // map — no two-finger scroll, no zoom-out-and-in detour. The gate is tapMax,
  // not dragMinPx, so a gesture is never both a pan and a tap: under it the
  // release still selects/dismisses, past it the press is navigation and
  // nothing else (see buildCommit).
  if (!B.drag.from) {
    const gate = B.drag.touch ? CONFIG.touch.tapMaxPx * dpr() : CONFIG.build.tapMaxPx;
    if (!B.drag.panning && travel > gate) B.drag.panning = true;
    if (B.drag.panning) emit('input:pan', { dx: p.px - B.drag.lpx, dy: p.py - B.drag.lpy });
    B.drag.lpx = p.px; B.drag.lpy = p.py;
    return;
  }

  // Sliding only ever re-snaps the preview: adjust, then release. The far end
  // takes no chain bonus (see snapOptsFor) but does take the boundary repair.
  const end = snapEndAt(B.drag.from, p.x, p.y, B.drag.touch);
  B.drag.last = end;
  B.hover.snap = end;
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

  // pinch-cancel: never place, never select — and the armed start survives, so a
  // two-finger pan mid-run costs the player nothing.
  if (p.cancel) { cleanupOrphans(); return; }

  buildCommit(p, drag, ghost);
  cleanupOrphans();
}

// THE commit point, mouse and touch alike: the pointer has left, and where it
// left is what gets built. In order:
//   1. no armed start under this press → a TAP selects the member under it (an
//      empty tap clears the selection, and dismisses whatever circle the press
//      landed outside of). This is the only gesture in v4 that is not about
//      building, and it is why touch can select again at all: a press on empty
//      ground no longer places anything, so it is free to mean something else.
//      Past a tap the gesture was a PAN — it selects nothing and dismisses
//      nothing, because looking around must never cost the player their run.
//   2. released back ON the armed start → dismiss the circle, unless this same
//      press is what armed it (arming and dismissing on one click would make the
//      circle un-openable). This is "never mind", not "I have finished": after a
//      commit there is nothing armed to say it to.
//   3. otherwise → build from the armed start to the snapped release point, and
//      the circle goes with the girder. If the rules refuse it, the slice PULSES
//      and the circle stays up: a refusal costs the player a click, not a
//      re-arm.
function buildCommit(p, drag, ghost) {
  const travel = Math.hypot(p.px - drag.px0, p.py - drag.py0);
  const tapMax = drag.touch ? CONFIG.touch.tapMaxPx * dpr() : CONFIG.build.tapMaxPx;
  const tap = travel <= tapMax;

  if (!drag.from) {
    if (tap) {
      if (drag.dismiss) disarm();
      B.selection = hitTestMember(p.x, p.y, B.design, tolerance());
    }
    return;
  }

  const end = (ghost && ghost.end) || snapEndAt(drag.from, p.x, p.y, drag.touch);

  if (samePoint(drag.from, end)) {
    if (tap && !drag.fresh) disarm();
    return;
  }
  commit(drag.from, end);
}

// Place a beam — and take the circle down with it. The gesture is OVER: the
// girder exists, and the player is not mid-anything. What used to be a chain is
// now just the next two clicks, starting on the joint this one left behind, and
// that is worth more than the saved tap: there is no state to be in, so there is
// no state to get out of, and every girder is built the same way as the first.
// A refusal is the one thing that does NOT dismiss (see placeMember → refuse).
function commit(from, end) {
  const m = placeMember(from, end);
  if (m) disarm();
  return m;
}

// The live preview beam. Null when there is nothing to build from, or while the
// beam would be a zero-length stub (a press that has not left its own start yet
// is not a refusal, it is a press) — the renderer falls back to the snap mark.
function updateGhost(end) {
  const start = B.drag && B.drag.from;
  const mat = MATERIALS[B.material];
  if (!start || !mat || samePoint(start, end)) { B.ghost = null; return; }
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
  designChanged();
  refreshReach();
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

// The armed start is a COPY of a point, so a node that moves takes its start —
// and the circle drawn around it — with it. (A start naming a node that died is
// dropped in cleanupOrphans.)
function syncChainHead(n) {
  const h = B.chainHead;
  if (h && h.nodeId === n.id) { h.x = n.x; h.y = n.y; h.anchorId = n.anchorId || null; }
  const rc = B.reach;
  if (rc && rc.nodeId === n.id) { rc.x = n.x; rc.y = n.y; rc.anchorId = n.anchorId || null; }
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
