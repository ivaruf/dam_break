// STUB — OPUS A owns. Contract: ARCHITECTURE.md §5 "Structure". DOM-free.

export function instantiate(design, terrain, materials) {
  const nodeById = new Map();
  const nodes = design.nodes.map((n) => {
    const anchored = !!n.anchorId;
    const node = {
      id: n.id, x: n.x, y: n.y, px: n.x, py: n.y,
      invMass: anchored ? 0 : 1,
      anchored, ax: n.x, ay: n.y,
      fx: 0, fy: 0, onGround: false,
    };
    nodeById.set(n.id, node);
    return node;
  });
  const members = design.members.map((m) => {
    const a = nodeById.get(m.a), b = nodeById.get(m.b);
    return {
      id: m.id, a, b, mat: materials[m.mat],
      restLength: Math.hypot(b.x - a.x, b.y - a.y),
      broken: false, strain: 0, load: 0, loadSign: 1, damage: 0,
    };
  });
  return {
    nodes, members, debris: [],
    time: 0, brokenCount: 0, maxLoad: 0, firstFailure: null,
  };
}
