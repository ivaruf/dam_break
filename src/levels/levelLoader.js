// STUB — OPUS C owns. Level spec → runtime objects. Contract §8. DOM-free.

import { createTerrain } from '../core/terrain.js';

export function loadLevelSpec(spec) {
  const terrain = createTerrain(spec.terrain, spec.anchors || []);
  return { terrain, level: spec };
}
