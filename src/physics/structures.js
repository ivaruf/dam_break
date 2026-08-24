// OPUS A owns. Nodes / members / debris data + instantiate.
// Contract: ARCHITECTURE.md §5 "Structure". DOM-free, deterministic (no Math.random).
//
// Node masses come from the member massPerMeter (half to each end) plus
// CONFIG.physics.nodeBaseMass. Anchored nodes get invMass 0 and are pinned to
// the terrain anchor position.
//
// The solver in constraints.js is XPBD, so every member needs a *compliance*
// (inverse spring stiffness). Materials only publish a normalised `stiffness`
// (0..1), so we map that to a real axial stiffness EA (newtons per unit strain)
// here. That mapping is what makes `member.strain` a physically meaningful
// quantity — the axial force in a member is  F = strain · EA — which is what
// stress.js turns into load/damage.

import { CONFIG } from '../config.js';

// ---- material → spring ---------------------------------------------------

// EA in game-newtons per unit strain. mat.stiffness 0..1 is mapped through
// s/(eps + 1−s) so the top of the range spreads out hard (concrete ≫ timber).
export function axialStiffness(mat) {
  const P = CONFIG.physics;
  const raw = mat && typeof mat.stiffness === 'number' ? mat.stiffness : 0.9;
  const s = Math.max(0, Math.min(P.stiffMax, raw));
  return P.axialStiffness * (s / (P.stiffEps + (1 - s)));
}

// XPBD compliance alpha = 1/k = L/EA  (metres per newton).
export function memberCompliance(mat, restLength) {
  const ea = axialStiffness(mat);
  if (!(ea > 0)) return 0;
  return Math.max(restLength, CONFIG.physics.minMemberLen) / ea;
}

// Axial force capacity at load = 1.0 (informational; used by tests/tuning).
export function memberCapacity(mat, tension) {
  const lim = tension ? mat.tensionLimit : mat.compressionLimit;
  return axialStiffness(mat) * lim;
}

// ---- construction --------------------------------------------------------

function makeNode(id, x, y, anchored) {
  return {
    id,
    x, y, px: x, py: y,
    vx: 0, vy: 0,              // metres/second, refreshed by constraints.js
    invMass: anchored ? 0 : 1,
    mass: CONFIG.physics.nodeBaseMass,
    anchored, ax: x, ay: y,
    fx: 0, fy: 0,              // EXTERNAL accumulator (water writes, solver clears)
    lfx: 0, lfy: 0,            // last tick's fx/fy, kept for the F2 force arrows
    onGround: false,
    contact: false,            // ground contact armed this substep
    groundY: 0, groundNx: 0, groundNy: 1,
    nAccum: 0,                 // normal push accumulated by the contact solver
    area: 0,                   // displaced cross-section (m² per unit width)
    submerged: 0,              // 0..1, set by coupling
  };
}

function finishNode(n) {
  n.invMass = n.anchored ? 0 : 1 / Math.max(n.mass, CONFIG.physics.minNodeMass);
}

function makeMember(id, a, b, mat) {
  const restLength = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    id, a, b, mat,
    restLength,
    broken: false,
    strain: 0,
    load: 0,
    loadSign: 1,
    damage: 0,
    // v2.1 water-load / bending fields. Declared here (not lazily by coupling)
    // because the renderer and HUD read them during the BUILD phase, before any
    // water tick has run — `undefined` there would put NaN in the bow geometry.
    waterFx: 0, waterFy: 0, waterFperp: 0, bendLoad: 0,
    tensionOnly: !!(mat && mat.tensionOnly),
    sealing: !!(mat && mat.sealing && !mat.tensionOnly),
    compliance: memberCompliance(mat, restLength),
    lambda: 0,                 // XPBD multiplier, reset each substep
  };
}

export function instantiate(design, terrain, materials) {
  const src = design || { nodes: [], members: [] };
  const anchorById = new Map();
  if (terrain && terrain.anchors) for (const a of terrain.anchors) anchorById.set(a.id, a);

  const nodeById = new Map();
  const nodes = [];
  for (const dn of src.nodes || []) {
    const anchor = dn.anchorId != null ? anchorById.get(dn.anchorId) : null;
    const anchored = !!anchor || !!dn.anchorId;
    const x = anchor ? anchor.x : dn.x;
    const y = anchor ? anchor.y : dn.y;
    const node = makeNode(dn.id, x, y, anchored);
    nodeById.set(dn.id, node);
    nodes.push(node);
  }

  const memberById = new Map();
  const members = [];
  for (const dm of src.members || []) {
    const a = nodeById.get(dm.a);
    const b = nodeById.get(dm.b);
    const mat = materials ? materials[dm.mat] : null;
    if (!a || !b || a === b || !mat) continue;
    const m = makeMember(dm.id, a, b, mat);
    if (!(m.restLength > 0)) continue;
    const halfMass = (mat.massPerMeter || 0) * m.restLength * 0.5;
    const halfArea = (mat.thickness || 0) * m.restLength * 0.5;
    a.mass += halfMass; b.mass += halfMass;
    a.area += halfArea; b.area += halfArea;
    memberById.set(m.id, m);
    members.push(m);
  }

  for (const n of nodes) finishNode(n);

  return {
    nodes, members,
    debris: [],
    nodeById, memberById,
    time: 0,
    brokenCount: 0,
    maxLoad: 0,
    firstFailure: null,
    nextDebrisId: 0,
    obstructionsDirty: true,   // set on every break: the water profile changed
  };
}

// ---- debris --------------------------------------------------------------

// A broken member becomes a free piece shaped exactly like a member (a/b/mat)
// but with its own unconstrained verlet nodes, so the renderer can draw it and
// the water can carry it downstream.
export function spawnDebris(structure, member) {
  const P = CONFIG.physics;
  if (P.maxDebris <= 0) return null;
  const mat = member.mat;
  const half = (mat.massPerMeter || 0) * member.restLength * 0.5 + P.nodeBaseMass;
  const area = (mat.thickness || 0) * member.restLength * 0.5;

  const piece = {
    id: 'd' + structure.nextDebrisId++,
    srcId: member.id,
    a: debrisNode(member.a, half, area),
    b: debrisNode(member.b, half, area),
    mat,
    restLength: member.restLength,
    broken: false,
    strain: 0, load: 0, loadSign: 1, damage: 0,
    waterFx: 0, waterFy: 0, waterFperp: 0, bendLoad: 0,   // same reason as makeMember
    tensionOnly: false,
    sealing: false,
    compliance: memberCompliance(mat, member.restLength),
    lambda: 0,
    age: 0,
  };

  // the surviving structure genuinely gets lighter
  releaseMass(member.a, half - P.nodeBaseMass);
  releaseMass(member.b, half - P.nodeBaseMass);

  structure.debris.push(piece);
  while (structure.debris.length > P.maxDebris) structure.debris.shift();
  return piece;
}

function debrisNode(from, mass, area) {
  return {
    id: from.id + '*',
    x: from.x, y: from.y,
    // inherit velocity from the node it tore off (anchored nodes have none)
    px: from.anchored ? from.x : from.px,
    py: from.anchored ? from.y : from.py,
    vx: 0, vy: 0,
    invMass: 1 / Math.max(mass, CONFIG.physics.minNodeMass),
    mass,
    anchored: false, ax: from.x, ay: from.y,
    fx: 0, fy: 0,
    lfx: 0, lfy: 0,
    onGround: false,
    contact: false,
    groundY: 0, groundNx: 0, groundNy: 1,
    nAccum: 0,
    area,
    submerged: 0,
  };
}

function releaseMass(node, amount) {
  node.mass = Math.max(CONFIG.physics.minNodeMass, node.mass - amount);
  if (!node.anchored) node.invMass = 1 / node.mass;
}
