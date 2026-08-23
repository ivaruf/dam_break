// STUB — OPUS B owns. Snapping + placement validity. Contract §10. DOM-free.

import { CONFIG } from '../config.js';

// Returns {x, y, nodeId|null, anchorId|null} for a world point.
export function snapPoint(x, y, design, terrain) {
  for (const n of design.nodes) {
    if (Math.hypot(n.x - x, n.y - y) <= CONFIG.build.nodeSnap) {
      return { x: n.x, y: n.y, nodeId: n.id, anchorId: n.anchorId || null };
    }
  }
  for (const a of terrain.anchors) {
    if (Math.hypot(a.x - x, a.y - y) <= CONFIG.build.anchorSnap) {
      return { x: a.x, y: a.y, nodeId: null, anchorId: a.id };
    }
  }
  const g = CONFIG.build.gridSnap;
  return { x: Math.round(x / g) * g, y: Math.round(y / g) * g, nodeId: null, anchorId: null };
}

// Returns {ok, reason} for a ghost member from p0 to p1 with material mat.
export function validate(p0, p1, mat, design, terrain, level, budgetLeft) {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (len < mat.minLength) return { ok: false, reason: 'too short' };
  if (len > mat.maxLength) return { ok: false, reason: 'too long' };
  if (len * mat.costPerMeter > budgetLeft) return { ok: false, reason: 'over budget' };
  return { ok: true, reason: '' };
}
