// DAM BUILDER — central tunables. FABLE owns this file; agents propose values.
// No magic numbers in module code: if you need a knob, add it here.

export const CONFIG = {
  physics: {
    dt: 1 / 60,            // fixed physics timestep (s)
    maxAccum: 0.25,        // clamp on frame-time accumulator (s)
    substeps: 6,           // verlet substeps per tick (XPBD likes small steps)
    iterations: 6,         // constraint solver iterations per substep
    gravity: 9.8,          // m/s², applied as −y
    groundFriction: 0.995, // tangential velocity kept per ground contact (0..1 damping factor)
    groundBounce: 0.0,
    nodeBaseMass: 0.5,     // kg added to every node besides member shares
    velDamping: 0.9995,    // global verlet damping per substep

    // --- OPUS A: solver material mapping -------------------------------
    // Members are XPBD constraints with compliance alpha = L/EA, so the
    // residual strain IS the elastic strain and stress.js can grade it.
    // EA (game-newtons per unit strain) = axialStiffness · s/(stiffEps + 1−s)
    axialStiffness: 150000, // base EA scale
    stiffEps: 0.03,        // spreads the top of mat.stiffness (0..1) apart
    stiffMax: 0.9995,      // clamp so stiffness = 1.0 stays finite
    minMemberLen: 0.05,    // m, compliance floor
    minNodeMass: 0.2,      // kg, invMass floor

    // --- OPUS A: ground contact ----------------------------------------
    groundMu: 0.7,         // Coulomb friction coefficient (foundation grip)
    groundStiction: 0.01,  // m/s of tangential motion killed outright (anti-creep)
    slopeEps: 0.05,        // m used to sample the terrain normal
    groundProbe: 0.5,      // m above terrain within which a node arms a contact
    maxNodeVel: 30,        // m/s clamp (explosion guard)

    // --- OPUS A: debris -------------------------------------------------
    maxDebris: 140,        // free pieces kept alive (oldest dropped)
    debrisIterations: 2,   // solver passes for the single-member debris pieces
    debrisDamping: 0.995,  // debris tumbles to rest a bit faster
  },

  water: {
    cellW: 0.4,            // column width (m)
    g: 9.8,
    damping: 0.998,        // per-tick velocity damping (a flood front must keep
                           // its momentum long enough to actually travel)
    maxVel: 18,            // clamp (m/s)
    minDepth: 0.005,       // below this a cell renders/acts as dry (m)
    transferCap: 0.45,     // max fraction of a cell's water leaving per tick (stability)
    orificeCoeff: 0.75,    // leak-through-gap discharge coefficient
    weirCoeff: 0.6,        // overtopping discharge coefficient

    // --- OPUS A ---------------------------------------------------------
    substeps: 2,           // flow substeps per physics tick (CFL headroom)
    sealEps: 0.03,         // m; a gap thinner than this counts as sealed
    weirDrownExp: 0.385,   // Villemonte drowned-weir exponent
  },

  coupling: {
    density: 1.0,          // game water density (forces scale below)
    pressureScale: 55,     // hydrostatic force scale (N per m·m-depth)
    impactScale: 70,       // dynamic ρv² force scale. This is THE knob for
                           // "a moving flood hits harder than a calm pool": at 70
                           // an equal-volume wave peaks ~4.2x the static pond's
                           // force, while the calm pond itself only gains ~8%
                           // (still water has almost no velocity to square).
    dragScale: 8,          // drag on submerged nodes/debris
    buoyancyScale: 30,     // uplift on submerged nodes
    impactEventMin: 120,   // min impulse magnitude to emit 'water:impact'
    impactSpeedMin: 3.0,   // m/s the water must actually be moving to count as a
                           // hit (a tall wall integrates a big force out of a
                           // slow current, and that is not an impact)
    sampleStep: 0.35,      // segment sampling step for pressure integration (m)

    // --- OPUS A: obstruction rasterisation ------------------------------
    mergeEps: 0.12,        // m; blocked intervals this close fuse (watertight wall).
                           // Well under the 0.5 m build grid, so a gap a player
                           // can actually draw still leaks.
    sealReachCells: 1.0,   // a member also seals boundaries this many cells beyond
                           // its own x-span, so a chain of members that has
                           // deflected still shares boundaries and stays watertight
    groundSealEps: 0.3,    // m; a member foot this close to the sill seals to bed
    groundSealSink: 1.0,   // m the sealed foot is pushed below the sill
    maxIntervals: 24,      // per boundary before collapsing to one span
    vertEps: 1e-4,         // degenerate-geometry epsilon

    // --- OPUS A: force shaping ------------------------------------------
    impactProbeCells: 5,   // cells upstream searched for the approach velocity
                           // (clear of the stalled water against the face)
    minNormalX: 0.1,       // below this |normal.x| a member takes no face load
    verticalScale: 1.0,    // vertical component on a battered (leaning) face
    submergeDepth: 0.3,    // m of depth for full buoyancy (smooth entry)
    dragImpulseCap: 0.6,   // max fraction of relative velocity removed per tick
    rampTime: 0.6,         // s to fade water load in at sim start (kills the
                           // step-load ring: the dam was built against the pond)

    // --- OPUS A: event rate limiting ------------------------------------
    impactCooldown: 0.4,   // s between 'water:impact' emissions
    eventMinInterval: 0.12,// s between emissions of the same kind
    flowRepeat: 0.3,       // s before one site re-announces an ongoing breach or
                           // overtop (keeps the effects layer's jet alive)
    eventOffFactor: 0.5,   // flow must fall to this fraction before re-arming
    breachFlowMin: 0.15,   // m²/s of gap flow that counts as a breach
    breachSealFrac: 0.6,   // the boundary must be this sealed to be a dam FACE
                           // rather than an open lattice water flows through
    overtopFlowMin: 0.05,  // m²/s of weir flow that counts as overtopping
  },

  damage: {
    safe: 0.8,             // below: no concern
    damageRate: 0.9,       // damage/s per unit overload in 1.0–1.2 band
    fastAbove: 1.2,        // load above which fastRate takes over
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

    // --- placement validity (OPUS B) ---
    mergeEps: 0.08,        // m — a grid point this close to a node reuses the node
    groundTol: 0.15,       // m an endpoint may sit below terrain (anchors, rounding)
    midGroundTol: 0.6,     // m the member interior may cut into terrain
    midSamples: 6,         // interior samples for the terrain-cut test
    budgetEps: 0.5,        // $ float slack when comparing cost to remaining budget

    // --- pointer feel (OPUS B) ---
    chainSnapMul: 1.7,     // snap radius multiplier on the node just placed (chaining)
    dragMinPx: 6,          // pointer travel before a ghost member appears (px)
    tapMaxPx: 12,          // travel under this = tap, not drag (px)
    tapMaxMs: 350,         // press shorter than this + small travel = tap (select)
    hitPx: 18,             // member hit-test radius in screen px
    hitMinWorld: 0.16,     // clamp on the hit radius (m)
    hitMaxWorld: 1.2,
    eraseTolMul: 1.35,     // eraser is more forgiving than selection
    undoDepth: 40,         // snapshot undo steps kept
    hintMs: 2200,          // how long a refusal reason stays on the HUD hint

    // --- objectives / win-fail (OPUS B, modes.js) ---
    modes: {
      startGrace: 2.0,          // s before retention can fail a level
      failGrace: 2.0,           // s retention must stay bad before failing
      protectGrace: 0.4,        // s the protected zone may be over depth
      retentionFailMargin: 0.15,// fail when retained < minRetention − this
      minInflow: 0.5,           // m² of water in before retention is meaningful
      collapseFrac: 0.4,        // >40% members broken = catastrophic collapse
      collapseRetention: 0.35,  // retention this low after a break = failed dam
      depthSampleEvery: 3,      // ticks between peak-depth / zone-depth sweeps
      damLineFrac: 0.5,         // dam line as fraction of terrain span when no zone
      // fallbacks for levels that leave an objective field out
      defaultDuration: 30,      // s
      defaultRetention: 0.8,
      defaultMaxDepth: 0.3,     // m
    },
  },

  render: {
    stressWarn: 0.8,       // start visual warning
    flashHz: 5,
    maxParticles: 900,
    shakeMax: 5,           // px

    // ---- OPUS C additions below: presentation-only knobs ------------------
    // backdrop
    skyTop: '#08131d',
    skyMid: '#10283a',
    skyLow: '#1b4258',
    hazeColor: 'rgba(120, 180, 220, 0.10)',
    hillColors: ['#122a39', '#183545', '#1f4254'],
    hillParallax: [0.22, 0.40, 0.62],   // 0 = pinned to camera, 1 = world-locked
    hillBaseY: [0.30, 0.22, 0.14],      // fraction of view height above terrain low
    hillAmp: [0.10, 0.08, 0.06],        // fraction of view height
    hillWaves: 3,

    // terrain
    terrainFill: '#2c3729',
    terrainDeep: '#161d16',
    terrainEdge: '#6d8f4e',
    terrainRock: '#697585',
    terrainEdgePx: 2.6,
    terrainSteepSlope: 1.3,             // |dy/dx| above this the edge reads as rock
    stratumColor: 'rgba(0, 0, 0, 0.16)',
    stratumStep: 3.5,                   // m between subsurface strata lines
    gridStep: 5,                        // m, faint build-phase world grid
    gridColor: 'rgba(130, 180, 215, 0.07)',

    // anchors + build zone
    anchorColor: '#ffd35a',
    anchorDark: '#8a6a12',
    anchorPx: 6.5,
    anchorHint: 'rgba(255, 211, 90, 0.20)',
    anchorHintLine: 'rgba(255, 211, 90, 0.45)',
    buildZoneLine: 'rgba(130, 195, 255, 0.55)',
    buildZoneFill: 'rgba(130, 195, 255, 0.045)',
    dash: [8, 7],
    protectFill: 'rgba(127, 255, 154, 0.05)',
    protectHatch: 'rgba(127, 255, 154, 0.10)',
    protectLine: 'rgba(127, 255, 154, 0.55)',

    // decorative props (level.props — never gameplay-affecting)
    propTree: '#315c37',
    propTreeDark: '#254627',
    propTrunk: '#4a3826',
    propRock: '#5b6672',
    propHouse: '#8a7358',
    propRoof: '#6d4038',
    propWindow: '#ffd35a',
    propSign: '#c8954a',
    propTreeH: 3.2,                     // m
    propPineH: 4.2,
    propRockR: 0.9,
    propHouseH: 2.6,
    propSignH: 1.8,
    propMinZoom: 3,                     // px/m below which props stop drawing

    // structure + stress
    memberMinPx: 2.2,
    memberOutline: 'rgba(6, 12, 18, 0.55)',
    memberOutlinePx: 1.2,
    tensionColor: '#7fdcff',
    compressionColor: '#ff8348',
    stressFrom: 0.35,                   // load where the color shift begins
    highlightAlpha: 0.35,               // steel top highlight
    grainAlpha: 0.30,                   // timber grain
    crackColor: 'rgba(15, 18, 22, 0.85)',
    crackTicksMax: 5,
    crackLenPx: 5,
    bowMax: 0.16,                       // m sagitta at load 1.0 (compression)
    cableSlackMin: 0.01,                // m of slack before a cable visibly hangs
    cableSagScale: 0.35,                // fraction of the geometric slack drawn as sag
    brokenColor: '#3b4147',
    debrisAlpha: 0.9,
    nodeColor: '#e8f2fa',
    nodePx: 3.4,
    selectColor: '#ffffff',
    selectPx: 3,

    // ghost + labels
    ghostOk: '#7fff9a',
    ghostBad: '#ff6a5a',
    ghostAlpha: 0.75,
    labelFontPx: 12,
    labelPadPx: 5,
    labelBg: 'rgba(8, 18, 26, 0.86)',
    labelFg: '#dfe9f0',

    // water
    waterDeep: '#0b3a68',
    waterMid: '#1c6fb4',
    waterShallow: '#49a8e0',
    waterAlpha: 0.74,                   // deep water: translucent ENOUGH that the
                                        // submerged dam stays inspectable
    waterShallowAlpha: 0.44,
    waterSurfaceColor: '#a5e2ff',
    waterSurfacePx: 2,
    waterDeepRef: 4,                    // m depth treated as "fully deep"
    waterSamplePx: 3,                   // min device-px spacing between surface samples
    waterBedOvershoot: 0.6,             // m the fill runs below the bed (clipped to
                                        // terrain) so no seam opens at the shoreline
    waveAmp: 0.10,                      // m
    waveLen: 3.4,                       // m
    waveSpeed: 2.1,                     // m/s phase travel
    waveVelMin: 0.5,                    // |vel| where undulation starts
    waveVelFull: 4.5,                   // |vel| for full amplitude
    waveDepthRef: 0.4,                  // m; shallower water undulates less
    foamVelMin: 2.0,
    foamColor: 'rgba(226, 244, 255, 0.55)',
    foamPx: 2,
    foamChance: 0.35,                   // fraction of fast cells that carry a streak
    foamDriftHz: 3,                     // how often the streak pattern re-hashes
    smoothPasses: 2,
    minSpanCells: 1,

    // effects
    particleGravity: 11,                // m/s² on decorative particles
    particleDrag: 0.4,                  // per second
    sprayLife: 0.85,
    splinterLife: 1.5,
    mistLife: 1.1,
    breakParticles: 18,
    impactParticles: 9,
    breachRate: 44,                     // particles/s while a breach flows
    overtopRate: 26,
    emitThrottle: 0.05,                 // s between re-emits from repeated events
    jetHold: 0.35,                      // s a breach/overtop keeps spraying after last event
    shakeDecay: 7,                      // exponential decay per second
    shakeBreak: 3.4,                    // px impulse for a big break
    shakeBigLoad: 1.6,                  // break load that earns a full-severity jolt
                                        // (matches damage.hardBreak)
    shakeMassRef: 40,                   // kg of broken piece that earns a full-strength shake
    shakeImpactRef: 900,                // water:impact magnitude for a full-strength shake

    // F2 debug overlay (ui/debug.js)
    dbgFontPx: 11,
    dbgColor: '#7dffa0',
    dbgDim: 'rgba(125, 255, 160, 0.45)',
    dbgWarn: '#ffd35a',
    dbgBad: '#ff5a3c',
    dbgBg: 'rgba(4, 10, 14, 0.72)',
    dbgVecScale: 0.35,                  // m of arrow per (m/s) of velocity
    dbgArrowEvery: 6,                   // draw a water velocity arrow every N boundaries
    dbgMinMemberPx: 34,                 // screen length before a load % label is drawn
    dbgBlockedPx: 3,                    // width of a blocked-interval bar

    // hud / screens
    timerUrgent: 10,                    // s remaining where the timer goes urgent
    toastMs: 1600,
    stressBarWarn: 0.8,
  },

  levels: {
    tutorialKey: 'dam-builder-tut',     // localStorage flag for the level-1 tutorial
    tutorialLevel: 1,                   // campaign index that shows the tutorial
    minRunout: 15,                      // m of downstream runout every valley must have
  },

  debug: { enabled: false },
};
