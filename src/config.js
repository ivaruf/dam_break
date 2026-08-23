// DAM BUILDER — central tunables. FABLE owns this file; agents propose values.
// No magic numbers in module code: if you need a knob, add it here.

export const CONFIG = {
  physics: {
    dt: 1 / 60,            // fixed physics timestep (s)
    maxAccum: 0.25,        // clamp on frame-time accumulator (s)
    substeps: 3,           // verlet substeps per tick
    iterations: 10,        // constraint solver iterations per substep
    gravity: 9.8,          // m/s², applied as −y
    groundFriction: 0.75,  // tangential velocity kept per ground contact (0..1 damping factor)
    groundBounce: 0.0,
    nodeBaseMass: 0.5,     // kg added to every node besides member shares
    velDamping: 0.996,     // global verlet damping per substep
  },

  water: {
    cellW: 0.4,            // column width (m)
    g: 9.8,
    damping: 0.995,        // per-tick velocity damping
    maxVel: 18,            // clamp (m/s)
    minDepth: 0.005,       // below this a cell renders/acts as dry (m)
    transferCap: 0.45,     // max fraction of a cell's water leaving per tick (stability)
    orificeCoeff: 0.75,    // leak-through-gap discharge coefficient
    weirCoeff: 0.6,        // overtopping discharge coefficient
  },

  coupling: {
    density: 1.0,          // game water density (forces scale below)
    pressureScale: 55,     // hydrostatic force scale (N per m·m-depth)
    impactScale: 26,       // dynamic ρv² force scale
    dragScale: 8,          // drag on submerged nodes/debris
    buoyancyScale: 30,     // uplift on submerged nodes
    impactEventMin: 120,   // min impulse magnitude to emit 'water:impact'
    sampleStep: 0.35,      // segment sampling step for pressure integration (m)
  },

  damage: {
    safe: 0.8,             // below: no concern
    damageRate: 0.9,       // damage/s per unit overload in 1.0–1.2 band
    fastRate: 4.0,         // damage/s per unit overload above 1.2
    hardBreak: 1.6,        // instant break at this load
    slenderness: 0.35,     // compression limit reduction k·(len/refLen)²
    slenderRefLen: 3.0,    // m
  },

  build: {
    nodeSnap: 0.6,         // m
    anchorSnap: 0.9,       // m
    gridSnap: 0.5,         // m
    minAngleDeg: 8,        // reject members nearly parallel to an existing one at same node
  },

  render: {
    stressWarn: 0.8,       // start visual warning
    flashHz: 5,
    maxParticles: 900,
    shakeMax: 5,           // px
  },

  debug: { enabled: false },
};
