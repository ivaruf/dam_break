// STUB — OPUS A owns. Verlet integration + iterative constraint solver +
// ground collision. Contract: ARCHITECTURE.md §5. DOM-free.

import { CONFIG } from '../config.js';

export function stepStructure(structure, terrain, dt) {
  const g = CONFIG.physics.gravity;
  for (const n of structure.nodes) {
    if (n.invMass === 0) { n.fx = 0; n.fy = 0; continue; }
    const vx = (n.x - n.px) * CONFIG.physics.velDamping;
    const vy = (n.y - n.py) * CONFIG.physics.velDamping;
    n.px = n.x; n.py = n.y;
    n.x += vx + n.fx * n.invMass * dt * dt;
    n.y += vy + (n.fy * n.invMass - g) * dt * dt;
    n.fx = 0; n.fy = 0;
    const ground = terrain.heightAt(n.x);
    if (n.y < ground) { n.y = ground; n.onGround = true; } else n.onGround = false;
  }
  for (let it = 0; it < CONFIG.physics.iterations; it++) {
    for (const m of structure.members) {
      if (m.broken) continue;
      const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      const diff = (len - m.restLength) / len;
      const wA = m.a.invMass, wB = m.b.invMass, wSum = wA + wB;
      if (wSum === 0) continue;
      const k = (m.mat && m.mat.stiffness) || 0.9;
      m.a.x += dx * diff * k * (wA / wSum);
      m.a.y += dy * diff * k * (wA / wSum);
      m.b.x -= dx * diff * k * (wB / wSum);
      m.b.y -= dy * diff * k * (wB / wSum);
    }
  }
  structure.time += dt;
}
