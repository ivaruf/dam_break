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

  // v2: bulk water is the PIC/FLIP fluid (CONFIG.fluid). These keys drive the
  // derived per-column arrays that the renderer/HUD/modes still read.
  water: {
    cellW: 0.4,            // derived-column width (m)
    g: 9.8,
    minDepth: 0.005,       // below this a cell renders/acts as dry (m)
  },

  // --- OPUS A: PIC/FLIP particle fluid (water v2) -----------------------
  // The water IS particles; the arrays in CONFIG.water above are now DERIVED
  // per tick from particle binning (renderer/modes/HUD read them unchanged).
  fluid: {
    // --- MAC grid ---
    h: 0.45,               // cell size (m). Pressure resolution AND the size of
                           // the staircase a thin member seals: below ~0.35 the
                           // solve gets expensive, above ~0.6 gaps stop leaking.
    yPad: 1.5,             // m of grid below the lowest terrain point
    yHead: 9,              // m of grid above the highest terrain point (splash room)
    maxCells: 90000,       // safety valve: coarsen h rather than blow this budget

    // --- particles ---
    spacing: 0.30,         // seed pitch (m); particle volume = spacing² (m² here)
    spacingSpanRef: 70,    // m of terrain span at which `spacing` applies. Wider
                           // levels hold proportionally more water, so particles
                           // grow with sqrt(span) and the COUNT stays bounded.
    spacingMax: 0.46,
    radiusFrac: 0.46,      // particle radius / spacing (collision radius)
    separation: 0.95,      // push-apart rest distance in units of spacing: under
                           // 1.0, so a freshly seeded lattice is already relaxed
    separationIters: 2,
    maxParticles: 16000,
    seedJitter: 0.04,      // fraction of spacing (hash-based, never Math.random)

    // --- inflow (addSource) ---
    // A source is an INLET, not a tap: it injects rate·dt m² per tick through a
    // rectangle of height rate/sourceSpeed and width sourceSpeed·dt, moving
    // downhill at sourceSpeed. Dropping the same water through a narrow spout
    // instead builds a needle-thin tower over the source (measured: 16 m of
    // "depth" on level 5) because the plateau cannot drain it as fast as it lands.
    sourceSpeed: 5,        // m/s the inflow arrives at
    sourceSlopeEps: 0.02,  // |dy/dx| below which the inlet just aims +x

    // --- stepping ---
    maxSpeed: 18,          // m/s clamp per component-sum (explosion guard)
    maxSubsteps: 8,
    moveFrac: 0.5,         // max advection per substep in particle radii — the
                           // no-tunnelling guarantee, with push-out along the
                           // entry normal doing the rest
    flip: 0.9,             // PIC/FLIP blend (1 = pure FLIP, lively but noisy)

    // --- pressure solve ---
    pressureIters: 40,     // Gauss-Seidel sweeps per tick (warm-started)
    primeIters: 400,       // one-off sweeps on the FIRST solve so a pre-filled
                           // reservoir starts already hydrostatic (no initial sag)
    sor: 1.6,              // over-relaxation
    driftK: 0.02,          // density-drift compensation: pushes over-packed cells
                           // apart through the solve, which is what keeps a deep
                           // reservoir from slowly compressing and boiling

    // --- solids ---
    solidPad: 0.16,        // m a capsule reaches past its own radius when claiming
                           // a cell as solid: a member thinner than a cell must
                           // still seal the cell it passes through
    terrainSolidFrac: 0.5, // fraction of a cell the terrain must fill to be solid
    wallFriction: 0.8,     // tangential velocity kept per wall/bed contact. Water
                           // is nearly frictionless: much below this a shallow
                           // sheet on a flat plateau stops draining, much above it
                           // and lone particles ping around the reservoir.
    restitution: 0.0,      // water does not bounce

    // --- compat rasterisation (blocked/sealed/crest for renderer + events) ---
    blockReach: 0.2,       // cells a member's blocked interval reaches beyond its
                           // own x-span. v1 needed a full cell here to keep the
                           // COLUMN solver watertight; v2 seals with capsules, so
                           // this must stay small — a blocked boundary the capsule
                           // does not actually cover reports sloshing water as
                           // gapFlow and fires phantom breaches.

    // Event floor in PARTICLES per second. The v1 flux thresholds
    // (coupling.breachFlowMin / overtopFlowMin) were written for a continuous
    // model; measured particle flux is quantised at pvol per crossing, so 0.05
    // m²/s is HALF A DROPLET and one splash over the crest would announce
    // "OVERTOPPED". This floor is what makes an event mean a real, running stream.
    eventFlowParticles: 3,

    // --- derived diagnostics (renderer compat) ---
    flowTau: 0.18,         // s; EMA on per-boundary particle flux, so a jet reads
                           // as a steady jet instead of per-particle flicker
    velTau: 0.10,          // s; EMA on the derived column velocities
    forceTau: 0.05,        // s; EMA on member forces — short enough to keep a
                           // wave's impact peak, long enough to kill 1-frame spikes
    volSmoothPasses: 1,    // [1 2 1] passes over the binned column volume before
                           // it becomes `depth`. One particle is 0.09 m² and a
                           // column is 0.4 m wide, so raw binning gives the
                           // surface a ±0.25 m saw-tooth that is pure sampling
                           // noise. Volume-preserving, so retention stays exact.
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

    // --- OPUS A: obstruction rasterisation ------------------------------
    mergeEps: 0.12,        // m; blocked intervals this close fuse (watertight wall).
                           // Well under the 0.5 m build grid, so a gap a player
                           // can actually draw still leaks.
    groundSealEps: 0.3,    // m; a member foot this close to the sill seals to bed
    groundSealSink: 1.0,   // m the sealed foot is pushed below the sill
    maxIntervals: 24,      // per boundary before collapsing to one span
    vertEps: 1e-4,         // degenerate-geometry epsilon

    // --- OPUS A: force shaping ------------------------------------------
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
    waterDeep: '#07294f',               // richer, colder deep water
    waterMid: '#1b6aae',
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
    bedShadow: 'rgba(4, 14, 24, 0.34)', // contact shading where water meets the bed
    bedShadowPx: 7,                     // device px of that soft band
    smoothPasses: 2,
    minSpanCells: 1,

    // surface sheen: a sky reflection sitting just under the waterline
    waterSheen: '#cfefff',
    waterSheenAlpha: 0.13,
    waterSheenPx: 3.5,                  // device px of sheen band under the line
    waterShoreAlpha: 0.30,              // alpha at the very surface (shallows show the bed)

    // ---- OVERTOPPING NAPPE (deterministic, drawn from water.weirFlow) ----
    // One translucent sheet per contiguous overtopping run, on a ballistic
    // trajectory from the crest to the toe. Never particles: a cloud of sprites
    // at the dam face is exactly what hid the structure before.
    nappeMinFlow: 0.015,                // m²/s of weir flow before a sheet appears
    nappeColor: '#bfe6ff',
    nappeAlphaTop: 0.60,                // at the crest
    nappeAlphaToe: 0.22,                // where it lands
    nappeMinTh: 0.20,                   // m sheet thickness clamp
    nappeMaxTh: 2.0,
    nappeMaxVel: 7.5,                   // m/s cap so a huge head still pours down the
                                        // face instead of being launched off it
    nappeMinPx: 11,                     // device px: a hydraulically-correct sheet can
                                        // be 3 px thin and then reads as a wire, not water
    nappeVelCoeff: 0.55,                // × sqrt(2 g H): lower hugs the face,
                                        // which reads as pouring rather than launching
    nappeSteps: 16,                      // trajectory samples
    nappeMaxRun: 26,                    // m before the sheet is abandoned
    nappeEdge: 'rgba(226, 244, 255, 0.55)',   // bright lip at the crest
    toeFoamColor: 'rgba(226, 244, 255, 0.30)',
    toeFoamR: 0.55,                     // m foam radius at the toe, × flow scale

    // ---- LEAK / BREACH JETS (deterministic, from water.gapFlow + blocked) --
    jetMinFlow: 0.012,                  // m²/s of orifice flow before a jet appears
    jetColor: '#9ed4fb',
    jetAlphaNear: 0.70,                 // at the gap mouth
    jetAlphaFar: 0.20,                  // at the landing point
    jetMinTh: 0.06,                     // m
    jetMaxTh: 0.8,
    jetMinPx: 7,                        // device px floor, same reason as nappeMinPx
    jetVelCoeff: 0.9,                   // × sqrt(2 g head)
    jetSteps: 14,
    jetMaxDraw: 3,                      // only the biggest gaps get a jet: a lattice
                                        // has many tiny ones and a spider-web of
                                        // hairline arcs reads as noise, not a leak
    jetMaxRun: 34,                      // m
    jetSplashR: 0.5,                    // m, × flow scale
    jetSplashAlpha: 0.34,
    jetCore: 'rgba(255, 255, 255, 0.35)',  // bright centreline of a hard jet
    jetHardFlow: 0.6,                   // m²/s where a jet reads as "hard"

    // breach attention cue (decorative, effects.js)
    ringLife: 0.9,                      // seconds of REAL time (not sim time)
    ringCooldown: 1.2,                  // s between cues anywhere (they must stay rare)
    ringSiteMemory: 6,                  // s a site stays "already announced"
    maxRings: 2,                        // live cues; more than this is a scribble
    ringColor: '#ffe4a0',
    ringR0: 0.35,                       // m
    ringR1: 2.6,                        // m
    ringWidthPx: 3.5,
    maxMist: 16,                         // hard cap on live mist sprites
    maxFoam: 14,                        // ditto for foam puffs
    foamSpriteAlpha: 0.24,              // per-sprite cap (was 0.8: they stacked white)
    mistAlpha: 0.09,                    // per-sprite cap: bounds cumulative haze

    // submerged structure readability
    wetAlpha: 0.82,                     // alpha of members redrawn over the water
    wetTint: '#8fd6ff',
    wetTintMix: 0.18,                   // how far the wet tint pulls the material colour
    stubColor: '#2b3138',               // torn ends left where a member broke
    stubLen: 0.45,                      // m of stub drawn from each surviving node
    stubJag: 3,                          // jagged segments per stub

    // effects
    particleGravity: 11,                // m/s² on decorative particles
    particleDrag: 0.4,                  // per second
    sprayLife: 0.85,
    splinterLife: 1.5,
    mistLife: 1.1,
    breakParticles: 18,
    impactParticles: 9,
    breachRate: 9,                      // particles/s at a breach mouth: the JET is
                                        // drawn by waterRenderer, this is only torn spray
    overtopRate: 5,                     // ditto — the nappe sheet is the waterfall
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
