// OPUS B owns. Snapping, placement validity, hit tests. Contract §10. DOM-free.
//
// Priority for snapPoint(): existing design node > terrain anchor > grid.
// validate() is the single authority on "may this member exist" — the builder
// never places anything it rejects, and the ghost shows its `reason` verbatim.
//
// BUILDING v4 splits validate() into two halves that answer two different
// questions, and the split is the whole reason the reach circle can be drawn:
//
//   geometryReason()  — is this PLACE legal? length, build zone, ground. True of
//                       a location whatever else is standing nearby, so it can
//                       be turned into a SHAPE. reachGeom() adds the wallet on
//                       top and returns REACH_OK / REACH_BUDGET / REACH_BAD:
//                       that is exactly what the circle paints.
//   validate()        — may this MEMBER exist? geometryReason plus everything
//                       about the design already there (already built, overlaps
//                       a member, same point). Still the single authority on
//                       placement; the builder never places anything it rejects.
//
// Both are asked about a SNAPPED point, because a click snaps first: see
// classifyReach (click-time truth) and classifyReachGeom (what the circle
// draws). Money is its own answer because "you cannot afford that" and "that
// cannot exist" are different sentences and the player must be able to tell
// them apart without reading any text.

import { CONFIG } from '../config.js';
import { MATERIALS } from './materials.js';

const DEG = Math.PI / 180;

// ---- geometry -------------------------------------------------------------

export function pointSegDistance(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d2 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  const d3 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d4 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// Distance between segment AB and segment CD (0 when they intersect).
export function segSegDistance(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

// Distance between segment AB and the axis-aligned rect (x0,y0)-(x1,y1), 0 when
// the segment touches, crosses or lies inside it. The corners are the reason the
// four-edge minimum is not enough on its own: a member wholly INSIDE the box
// crosses no edge, so an endpoint-inside test has to come first.
// A degenerate rect (zero width and/or height) collapses to the point/segment
// distance, which is exactly what a marquee that has not moved yet should mean.
export function segRectDistance(ax, ay, bx, by, x0, y0, x1, y1) {
  const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
  const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
  const inside = (px, py) => px >= rx0 && px <= rx1 && py >= ry0 && py <= ry1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  return Math.min(
    segSegDistance(ax, ay, bx, by, rx0, ry0, rx1, ry0),
    segSegDistance(ax, ay, bx, by, rx1, ry0, rx1, ry1),
    segSegDistance(ax, ay, bx, by, rx1, ry1, rx0, ry1),
    segSegDistance(ax, ay, bx, by, rx0, ry1, rx0, ry0),
  );
}

// Screen-px hit radius → world metres, clamped so it stays usable at any zoom.
export function hitTol(zoom) {
  const b = CONFIG.build;
  const z = zoom > 0 ? zoom : 1;
  return Math.min(b.hitMaxWorld, Math.max(b.hitMinWorld, b.hitPx / z));
}

// ---- design helpers -------------------------------------------------------

export function nodeMap(design) {
  const m = new Map();
  if (design) for (const n of design.nodes) m.set(n.id, n);
  return m;
}

export function memberEnds(design, m, map) {
  const byId = map || nodeMap(design);
  return [byId.get(m.a), byId.get(m.b)];
}

export function memberLength(design, m, map) {
  const [a, b] = memberEnds(design, m, map);
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---- snapping -------------------------------------------------------------

// Returns {x, y, nodeId|null, anchorId|null, kind:'node'|'anchor'|'grid'}.
//
// opts (all optional; omitting every one of them is the original mouse
// behaviour, unchanged):
//   chainNodeId  this node gets an enlarged radius, so chain-building off the
//                endpoint you just placed is forgiving (CONFIG.build.chainSnapMul)
//   radiusMul    multiplies the NODE and ANCHOR radii — CONFIG.touch.snapMul
//                for touch gestures, so the preview endpoint pops decisively
//                onto a joint. The GRID is deliberately not scaled: it is a
//                quantisation, not a target, and 0.5 m is 0.5 m on every input.
//   ignoreNodeId this node is invisible to the snap (the node a drag is HOLDING
//                must not snap to itself, and it must not merge the grid point
//                under it back onto itself either)
//   noNodes      skip design nodes entirely: anchors and the grid only. Dropping
//                a dragged node exactly onto another one would make a coincident
//                pair, not a joint.
export function snapPoint(x, y, design, terrain, opts) {
  const B = CONFIG.build;
  const o = opts || {};
  const chainId = o.chainNodeId || null;
  const mul = o.radiusMul > 0 ? o.radiusMul : 1;
  const ignore = o.ignoreNodeId || null;

  // 1. existing design nodes (nearest wins)
  let best = null, bestD = Infinity;
  if (design && !o.noNodes) {
    for (const n of design.nodes) {
      if (n.id === ignore) continue;
      const r = (n.id === chainId ? B.nodeSnap * B.chainSnapMul : B.nodeSnap) * mul;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= r && d < bestD) { bestD = d; best = n; }
    }
  }
  if (best) {
    return { x: best.x, y: best.y, nodeId: best.id, anchorId: best.anchorId || null, kind: 'node' };
  }

  // 2. terrain anchors (nearest wins; anchor carries its own radius)
  let anchor = null, anchorD = Infinity;
  if (terrain && terrain.anchors) {
    for (const a of terrain.anchors) {
      const r = (a.r !== undefined ? a.r : B.anchorSnap) * mul;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d <= r && d < anchorD) { anchorD = d; anchor = a; }
    }
  }
  if (anchor) {
    // reuse the node already sitting on this anchor, if any
    let existing = null;
    if (design) {
      for (const n of design.nodes) {
        if (n.id !== ignore && n.anchorId === anchor.id) { existing = n; break; }
      }
    }
    return {
      x: anchor.x, y: anchor.y,
      nodeId: existing ? existing.id : null,
      anchorId: anchor.id,
      kind: 'anchor',
    };
  }

  // 3. grid — but never invent a second node on top of an existing one
  const g = B.gridSnap;
  const gx = Math.round(x / g) * g, gy = Math.round(y / g) * g;
  if (design && !o.noNodes) {
    for (const n of design.nodes) {
      if (n.id === ignore) continue;
      if (Math.abs(n.x - gx) <= B.mergeEps && Math.abs(n.y - gy) <= B.mergeEps) {
        return { x: n.x, y: n.y, nodeId: n.id, anchorId: n.anchorId || null, kind: 'node' };
      }
    }
  }
  return { x: gx, y: gy, nodeId: null, anchorId: null, kind: 'grid' };
}

// ---- hit tests ------------------------------------------------------------

// Nearest member id within tol of (x,y), or null. Half the member thickness is
// added to the tolerance so fat concrete is as easy to hit as thin cable.
export function hitTestMember(x, y, design, tol) {
  if (!design) return null;
  const byId = nodeMap(design);
  let bestId = null, bestD = Infinity;
  for (const m of design.members) {
    const a = byId.get(m.a), b = byId.get(m.b);
    if (!a || !b) continue;
    const mat = MATERIALS[m.mat];
    const t = tol + (mat ? mat.thickness * 0.5 : 0);
    const d = pointSegDistance(x, y, a.x, a.y, b.x, b.y);
    if (d <= t && d < bestD) { bestD = d; bestId = m.id; }
  }
  return bestId;
}

// All member ids within tol of the pointer path segment (eraser drag).
export function hitTestMembersAlong(x0, y0, x1, y1, design, tol) {
  const out = [];
  if (!design) return out;
  const byId = nodeMap(design);
  for (const m of design.members) {
    const a = byId.get(m.a), b = byId.get(m.b);
    if (!a || !b) continue;
    const mat = MATERIALS[m.mat];
    const t = tol + (mat ? mat.thickness * 0.5 : 0);
    if (segSegDistance(x0, y0, x1, y1, a.x, a.y, b.x, b.y) <= t) out.push(m.id);
  }
  return out;
}

// All member ids the marquee rect (x0,y0)-(x1,y1) touches — the box-delete
// tool's selection. `pad` is added to half the member thickness, so the test is
// against the member as drawn (CONFIG.build.marqueeHitPad). Order follows
// design.members, so the returned list is deterministic.
export function hitTestMembersInRect(x0, y0, x1, y1, design, pad) {
  const out = [];
  if (!design) return out;
  const byId = nodeMap(design);
  for (const m of design.members) {
    const a = byId.get(m.a), b = byId.get(m.b);
    if (!a || !b) continue;
    const mat = MATERIALS[m.mat];
    const t = (pad || 0) + (mat ? mat.thickness * 0.5 : 0);
    if (segRectDistance(a.x, a.y, b.x, b.y, x0, y0, x1, y1) <= t) out.push(m.id);
  }
  return out;
}

export function hitTestNode(x, y, design, tol) {
  if (!design) return null;
  let bestId = null, bestD = Infinity;
  for (const n of design.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= tol && d < bestD) { bestD = d; bestId = n.id; }
  }
  return bestId;
}

// ---- validity -------------------------------------------------------------

const OK = { ok: true, reason: '' };
function no(reason) { return { ok: false, reason }; }

function inZone(zone, x) {
  return x >= zone.x0 - 1e-6 && x <= zone.x1 + 1e-6;
}

// Angle (deg) between two directions.
function angleBetween(ax, ay, bx, by) {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 180;
  let c = (ax * bx + ay * by) / (la * lb);
  c = c < -1 ? -1 : c > 1 ? 1 : c;
  return Math.acos(c) / DEG;
}

// True when a member already joins these two node ids.
function duplicateMember(design, id0, id1) {
  if (!id0 || !id1) return false;
  for (const m of design.members) {
    if ((m.a === id0 && m.b === id1) || (m.a === id1 && m.b === id0)) return true;
  }
  return false;
}

// A new member leaving `nodeId` toward (tx,ty) that is nearly parallel to an
// existing member at the same node is a mis-drag, not a design.
function tooCloseToNeighbour(design, byId, nodeId, fromX, fromY, tx, ty) {
  if (!nodeId) return false;
  const dx = tx - fromX, dy = ty - fromY;
  for (const m of design.members) {
    let other = null;
    if (m.a === nodeId) other = byId.get(m.b);
    else if (m.b === nodeId) other = byId.get(m.a);
    if (!other) continue;
    if (angleBetween(dx, dy, other.x - fromX, other.y - fromY) < CONFIG.build.minAngleDeg) return true;
  }
  return false;
}

// THE PLACE, not the design: the refusals that are a property of WHERE the
// member would be — its length, the build zone, the ground it would sit in or
// cut through. Split out of validate() because these, and only these, are what
// the reach circle draws: they are true of a location whatever else is standing
// nearby, so they can be turned into a shape. Returns '' when the place is fine.
export function geometryReason(p0, p1, mat, terrain, level) {
  const B = CONFIG.build;
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (len < mat.minLength) return 'too short';
  if (len > mat.maxLength) return 'too long';

  // build zone: both endpoints inside → the whole (straight) member is inside
  if (level && level.buildZone) {
    if (!inZone(level.buildZone, p0.x) || !inZone(level.buildZone, p1.x)) {
      return 'outside build zone';
    }
  }

  // terrain: endpoints may touch the ground but not sink into it
  if (terrain && terrain.heightAt) {
    if (p0.y < terrain.heightAt(p0.x) - B.groundTol) return 'underground';
    if (p1.y < terrain.heightAt(p1.x) - B.groundTol) return 'underground';
    const n = B.midSamples;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      if (y < terrain.heightAt(x) - B.midGroundTol) return 'through the ground';
    }
  }
  return '';
}

// True when this material may not be used in this level at all.
function wrongMaterial(mat, level) {
  return !!(level && level.materials && level.materials.length && !level.materials.includes(mat.id));
}

function overBudget(p0, p1, mat, budgetLeft) {
  if (budgetLeft === undefined || budgetLeft === null) return false;
  const cost = Math.hypot(p1.x - p0.x, p1.y - p0.y) * mat.costPerMeter;
  return cost > budgetLeft + CONFIG.build.budgetEps;
}

// Returns {ok, reason} for a ghost member p0→p1 of material `mat`.
// p0/p1 are snapPoint() results ({x, y, nodeId, anchorId}).
//
// The order of the checks is part of the contract: 'same point' outranks
// 'too short' (a zero-length stub is not a short member, it is a mis-click), and
// 'over budget' comes last so a member that is both illegal and unaffordable
// reports the illegality.
export function validate(p0, p1, mat, design, terrain, level, budgetLeft) {
  if (!mat) return no('no material');
  if (wrongMaterial(mat, level)) return no('not available here');
  if (p0.nodeId && p0.nodeId === p1.nodeId) return no('same point');

  const geo = geometryReason(p0, p1, mat, terrain, level);
  if (geo) return no(geo);

  // …and THE DESIGN: refusals about what is already standing here. These are
  // deliberately NOT part of the reach circle — see reachGeom.
  if (design) {
    if (duplicateMember(design, p0.nodeId, p1.nodeId)) return no('already built');
    const byId = nodeMap(design);
    if (tooCloseToNeighbour(design, byId, p0.nodeId, p0.x, p0.y, p1.x, p1.y) ||
        tooCloseToNeighbour(design, byId, p1.nodeId, p1.x, p1.y, p0.x, p0.y)) {
      return no('overlaps a member');
    }
  }

  if (overBudget(p0, p1, mat, budgetLeft)) return no('over budget');
  return OK;
}

// ---- the reach circle (BUILDING v4) ---------------------------------------

export const REACH_OK = 0;       // a click here builds
export const REACH_BAD = 1;      // the geometry refuses (dark, hatched)
export const REACH_BUDGET = 2;   // the money refuses (amber band)

// How far a material can span, full stop. Deliberately NOT a function of the
// budget: reach is physics, and a beam does not get shorter because the player
// is broke. The wallet gets its own band inside the circle (affordRadius).
export function reachRadius(mat) {
  return mat && mat.maxLength > 0 ? mat.maxLength : 0;
}

// Metres of this material the remaining budget still buys — the radius of the
// affordable disc inside the reach circle. The budgetEps slack is validate()'s
// own, carried here so the drawn boundary and the accepted placement are the
// SAME line rather than two lines a few centimetres apart.
export function affordRadius(mat, budgetLeft) {
  if (!mat || !mat.costPerMeter) return Infinity;
  if (budgetLeft === undefined || budgetLeft === null) return Infinity;
  return Math.max(0, (budgetLeft + CONFIG.build.budgetEps) / mat.costPerMeter);
}

// What validate() says about a member from `start` to an ALREADY SNAPPED end.
export function classifySnapped(start, end, mat, design, terrain, level, budgetLeft) {
  const v = validate(start, end, mat, design, terrain, level, budgetLeft);
  if (v.ok) return REACH_OK;
  return v.reason === 'over budget' ? REACH_BUDGET : REACH_BAD;
}

// What happens if the player clicks the RAW world point (x, y) with a run armed
// at `start`: the point is snapped first, exactly as the pointer flow snaps it
// (`snapOpts` is the same opts object the gesture would pass — radiusMul for a
// touch), and then validate() decides. This is the CLICK-TIME truth, and the
// tests use it to check that the drawn circle does not lie.
export function classifyReach(start, x, y, mat, design, terrain, level, budgetLeft, snapOpts) {
  const end = snapPoint(x, y, design, terrain, snapOpts);
  return classifySnapped(start, end, mat, design, terrain, level, budgetLeft);
}

// WHAT THE CIRCLE DRAWS. Geometry and money only: the length limits, the build
// zone, the ground, and what the wallet can still pay for.
//
// It deliberately does NOT ask about the design. A point a few centimetres off
// an existing joint fails validate() for a SOCIAL reason — the member is already
// there, or the new one would leave its neighbour at under minAngleDeg — and
// those refusals painted the circle with dark blotches clinging to every beam
// the player had built, which is exactly the nagging v4 exists to delete. Worse,
// they were usually WRONG about the click: a tap near a joint snaps ONTO it and
// places a perfectly legal member. So the circle shows the place, the click
// still checks everything, and the handful of genuine social refusals get the
// red pulse they always had.
export function reachGeom(start, end, mat, terrain, level, budgetLeft) {
  if (!mat || wrongMaterial(mat, level)) return REACH_BAD;
  if (geometryReason(start, end, mat, terrain, level)) return REACH_BAD;
  return overBudget(start, end, mat, budgetLeft) ? REACH_BUDGET : REACH_OK;
}

// reachGeom at a RAW world point: snap first, exactly like a click.
export function classifyReachGeom(start, x, y, mat, design, terrain, level, budgetLeft, snapOpts) {
  const end = snapPoint(x, y, design, terrain, snapOpts);
  return reachGeom(start, end, mat, terrain, level, budgetLeft);
}
