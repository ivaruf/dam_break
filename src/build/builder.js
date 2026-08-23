// STUB — OPUS B owns. Design editing: place/connect/delete/ghost/undo.
// Contract: ARCHITECTURE.md §10. Mutates the design object owned by game.js.

import { on } from '../core/events.js';
import { getScene } from '../core/game.js';
import { snapPoint, validate } from './snapping.js';
import { MATERIALS, MATERIAL_ORDER } from './materials.js';

const B = {
  level: null, terrain: null, design: null,
  material: 'timber',
  tool: 'build',          // build | erase
  ghost: null,            // {x0,y0,x1,y1, ok, cost, len, reason}
  drag: null,
  nextId: 1,
};

export function getBuilder() { return B; }

export function initBuilder() {
  on('input:down', onDown);
  on('input:move', onMove);
  on('input:up', onUp);
  on('ui:material', ({ id }) => { B.material = id; });
  on('ui:tool', ({ id }) => { B.tool = id; });
  on('input:key', ({ key }) => {
    const i = parseInt(key, 10);
    if (i >= 1 && i <= MATERIAL_ORDER.length) B.material = MATERIAL_ORDER[i - 1];
  });
}

export function startLevel(level, terrain, design) {
  B.level = level; B.terrain = terrain; B.design = design;
  B.material = (level.materials && level.materials[0]) || 'timber';
  B.ghost = null; B.drag = null; B.nextId = 1;
}

export function designCost(design) {
  let c = 0;
  for (const m of design.members) {
    const a = design.nodes.find((n) => n.id === m.a);
    const b = design.nodes.find((n) => n.id === m.b);
    c += Math.hypot(b.x - a.x, b.y - a.y) * MATERIALS[m.mat].costPerMeter;
  }
  return c;
}

export function budgetLeft() {
  if (!B.level) return 0;
  return B.level.budget - designCost(B.design);
}

function onDown(p) {
  if (getScene().phase !== 'build' || p.button === 2) return;
  const s = snapPoint(p.x, p.y, B.design, B.terrain);
  B.drag = { start: s };
}

function onMove(p) {
  if (!B.drag) return;
  const s = snapPoint(p.x, p.y, B.design, B.terrain);
  const mat = MATERIALS[B.material];
  const v = validate(B.drag.start, s, mat, B.design, B.terrain, B.level, budgetLeft());
  const len = Math.hypot(s.x - B.drag.start.x, s.y - B.drag.start.y);
  B.ghost = {
    x0: B.drag.start.x, y0: B.drag.start.y, x1: s.x, y1: s.y,
    ok: v.ok, reason: v.reason, len, cost: len * mat.costPerMeter, end: s,
  };
}

function onUp(p) {
  const drag = B.drag, ghost = B.ghost;
  B.drag = null; B.ghost = null;
  if (!drag || !ghost || p.cancel || !ghost.ok) return;
  const a = ensureNode(drag.start);
  const b = ensureNode(ghost.end);
  if (a === b) return;
  B.design.members.push({ id: 'm' + B.nextId++, a, b, mat: B.material });
}

function ensureNode(s) {
  if (s.nodeId) return s.nodeId;
  const id = 'n' + B.nextId++;
  B.design.nodes.push({ id, x: s.x, y: s.y, anchorId: s.anchorId });
  return id;
}
