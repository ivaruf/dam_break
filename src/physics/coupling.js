// STUB — OPUS A owns. THE critical module: two-way water ↔ structure interface.
// Contract: ARCHITECTURE.md §5 "Coupling". DOM-free, deterministic.

import { setBoundaryBlocks, depthAt, surfaceAt, velAt } from './water.js';
import { CONFIG } from '../config.js';

export function updateObstructions(structure, water) {
  // stub: no obstruction — water flows through the dam (Opus A must implement
  // member rasterization into blocked y-intervals per boundary)
  setBoundaryBlocks(water, new Array(water.n + 1).fill(null));
}

export function applyWaterForces(structure, water, dt) {
  const C = CONFIG.coupling;
  for (const m of structure.members) {
    if (m.broken || !m.mat || !m.mat.sealing) continue;
    const mx = (m.a.x + m.b.x) / 2;
    const my = (m.a.y + m.b.y) / 2;
    const dL = Math.max(0, surfaceAt(water, mx - 1) - my);
    const dR = Math.max(0, surfaceAt(water, mx + 1) - my);
    const f = (dL - dR) * C.pressureScale * C.density;
    m.a.fx += f / 2;
    m.b.fx += f / 2;
  }
}
