// OPUS B owns. Snapping, placement validity, hit tests. Contract §10. DOM-free.
//
// Priority for snapPoint(): existing design node > terrain anchor > grid.
// validate() is the single authority on "may this member exist" — the builder
// never places anything it rejects, and the ghost shows its `reason` verbatim.

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
// opts.chainNodeId gets an enlarged radius so chain-building off the endpoint
// you just placed is forgiving (CONFIG.build.chainSnapMul).
export function snapPoint(x, y, design, terrain, opts) {
  const B = CONFIG.build;
  const chainId = (opts && opts.chainNodeId) || null;

  // 1. existing design nodes (nearest wins)
  let best = null, bestD = Infinity;
  if (design) {
    for (const n of design.nodes) {
      const r = n.id === chainId ? B.nodeSnap * B.chainSnapMul : B.nodeSnap;
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
      const r = a.r !== undefined ? a.r : B.anchorSnap;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d <= r && d < anchorD) { anchorD = d; anchor = a; }
    }
  }
  if (anchor) {
    // reuse the node already sitting on this anchor, if any
    let existing = null;
    if (design) for (const n of design.nodes) if (n.anchorId === anchor.id) { existing = n; break; }
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
  if (design) {
    for (const n of design.nodes) {
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

// Returns {ok, reason} for a ghost member p0→p1 of material `mat`.
// p0/p1 are snapPoint() results ({x, y, nodeId, anchorId}).
export function validate(p0, p1, mat, design, terrain, level, budgetLeft) {
  const B = CONFIG.build;
  if (!mat) return no('no material');
  if (level && level.materials && level.materials.length && !level.materials.includes(mat.id)) {
    return no('not available here');
  }

  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (p0.nodeId && p0.nodeId === p1.nodeId) return no('same point');
  if (len < mat.minLength) return no('too short');
  if (len > mat.maxLength) return no('too long');

  // build zone: both endpoints inside → the whole (straight) member is inside
  if (level && level.buildZone) {
    if (!inZone(level.buildZone, p0.x) || !inZone(level.buildZone, p1.x)) {
      return no('outside build zone');
    }
  }

  // terrain: endpoints may touch the ground but not sink into it
  if (terrain && terrain.heightAt) {
    if (p0.y < terrain.heightAt(p0.x) - B.groundTol) return no('underground');
    if (p1.y < terrain.heightAt(p1.x) - B.groundTol) return no('underground');
    const n = B.midSamples;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      if (y < terrain.heightAt(x) - B.midGroundTol) return no('through the ground');
    }
  }

  if (design) {
    if (duplicateMember(design, p0.nodeId, p1.nodeId)) return no('already built');
    const byId = nodeMap(design);
    if (tooCloseToNeighbour(design, byId, p0.nodeId, p0.x, p0.y, p1.x, p1.y) ||
        tooCloseToNeighbour(design, byId, p1.nodeId, p1.x, p1.y, p0.x, p0.y)) {
      return no('overlaps a member');
    }
  }

  const cost = len * mat.costPerMeter;
  if (budgetLeft !== undefined && budgetLeft !== null && cost > budgetLeft + B.budgetEps) {
    return no('over budget');
  }

  return OK;
}
