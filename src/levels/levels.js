// STUB — OPUS C owns. Campaign level data, pure data, DOM-free.
// Format: ARCHITECTURE.md §8. Last entry = sandbox.

export const LEVELS = [
  {
    id: 'level-01',
    name: 'First Trickle',
    subtitle: 'Build a small wall. Hold back the stream.',
    mode: 'freebuild',
    terrain: [[0, 12], [14, 7], [24, 3], [34, 3], [44, 3.5], [60, 2.5]],
    anchors: [[26, 3], [29, 3], [32, 3]],
    buildZone: { x0: 24, x1: 34 },
    water: {
      initial: [{ x0: 0, x1: 12, surface: 9 }],
      flood: { x: 2, rate: 2.2, duration: 20, delay: 0 },
    },
    budget: 3000,
    materials: ['timber'],
    objective: { type: 'retain', minRetention: 0.7, duration: 40 },
    hints: ['Drag between anchors to build. Triangles are strong.'],
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    subtitle: 'No rules. Big flood.',
    mode: 'freebuild',
    terrain: [[0, 16], [20, 8], [35, 4], [55, 4], [70, 4.5], [90, 2]],
    anchors: [[38, 4], [42, 4], [46, 4], [50, 4]],
    buildZone: null,
    water: {
      initial: [{ x0: 0, x1: 18, surface: 12 }],
      flood: { x: 2, rate: 8, duration: 60, delay: 0 },
    },
    budget: 100000,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'survive', duration: 120 },
    hints: [],
  },
];
