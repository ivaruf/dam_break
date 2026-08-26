// DAM BREAK — central tunables. FABLE owns this file; agents propose values.
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

    // --- v2.1 BENDING: a long unsupported span snaps under deep water ------
    // bendLoad = |m.waterFperp| · len / (8 · bendScale · mat.bending)
    // The numerator is the peak moment in a simply-supported span carrying a
    // distributed transverse load (M = F·L/8), so the denominator is a MOMENT
    // CAPACITY in game newton-metres: bendScale is the global scale and
    // mat.bending the material's share of it (timber = 1.00).
    //
    // 1000 is set from the head ratings the design asks for. Hydrostatic force
    // on a face is ½·pressureScale·ρ·g·H², so the bottom panel of a face with
    // bays of length L under head H carries F ≈ 269·L·(2H−L) game newtons and
    // therefore a moment of ≈ 34·L²·(2H−L). At bendScale 1000 a timber panel in
    // the level-typical 2.5 m bay reaches its limit at H ≈ 3 m, steel at ≈ 7 m —
    // exactly the published headRatings, and tests/run.js RATINGS gates them.
    // Raising this makes every material tolerate longer unsupported spans;
    // it does not touch axial strength at all.
    bendScale: 1000,

    // A span does not develop its full static moment from a load pulse shorter
    // than its own response time — that is the dynamic load factor, and without
    // it bending is decided by whichever single tick the pressure solve spiked
    // on. m.bendLoad is therefore an EMA of the instantaneous moment ratio with
    // this time constant, measured in seconds of SIM time (deterministic: it is
    // a function of dt, never of frame rate).
    //
    // 0.15 s is chosen against the two pulses that matter. The reservoir's
    // spin-up transient at sim start is ~0.4 s wide and hands a face 10–19x its
    // hydrostatic load (a property of the fluid's first half-second, not of the
    // dam); at 0.15 s it is attenuated to ~0.6, enough that a correctly built
    // concrete face is not destroyed by tick 20. A real wave impact loads a face
    // for a second or more and still registers ~85–90% — so a flood front's
    // bending spike absolutely does still snap a long span. Set 0 to disable.
    bendTau: 0.15,

    // --- v2.1 CREEP: sustained near-limit load destroys weak material ------
    // Above creepStart, damage += mat.creepRate · (load−creepStart)/(1−creepStart) · dt
    // ALWAYS — it stacks with the >1.0 overload bands rather than replacing
    // them. 0.7 is deliberately below render.stressWarn (0.8): by the time a
    // member is drawn as stressed it is already being consumed, so a dam that
    // merely "holds" at 0.95 is living on borrowed time. Per-material rates
    // live in materials.js (timber ~30 s at a sustained 0.85, steel 20×
    // slower); at load 1.0 the factor is exactly 1, so creepRate reads as
    // damage per second at the limit.
    creepStart: 0.7,
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

    // --- box-delete tool (marquee section erase, OPUS B) ---
    // Drag a box, everything it touches highlights, release deletes the lot as
    // ONE undo step. A member counts when its SEGMENT comes within
    // marqueeHitPad + thickness/2 of the rect, so the test is about the member
    // as DRAWN: fat concrete grazing the edge of the box is inside it, and a
    // hairline cable just outside is not. World metres, not screen px — the
    // marquee is a world-space rectangle and must select the same members at
    // every zoom.
    marqueeHitPad: 0.06,   // m of slack beyond half the member thickness
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

  // ---- BUILDING v4: THE REACH CIRCLE (Fable) ----------------------------
  // Every placement constraint, turned into visible geometry. Arming a start
  // (a click/tap on an anchor or an existing joint) spawns a circle centred
  // there whose radius is ALWAYS the material's maxLength — reach is physics,
  // and physics does not get cheaper when you are broke. Inside it:
  //   • the LIT region is exactly the set of points whose snapped position
  //     validate() would accept — drawn translucent green;
  //   • geometry refusals (too short, underground, through the ground, outside
  //     the zone, duplicate, overlap) are DARK and hatched: "physics says no";
  //   • money refusals are a distinct AMBER band beyond budgetLeft/costPerMeter:
  //     "the wallet says no". The two must never be confusable.
  // The region is sampled on a polar grid through snapping.classifyReach(), so
  // the picture cannot disagree with the rule it is drawing.
  reach: {
    animMs: 200,           // expansion of a freshly armed circle …
    fadeMs: 160,           // … and the contraction of the rim when the girder
                           // commits and the circle goes. Both decorative and
                           // frame-counter driven (renderer.js) — never a clock,
                           // so two runs of a level draw the same frames.
    angleSteps: 96,        // rays out from the armed start (3.75° apart) …
    radiusSteps: 20,       // … each cut into this many rings to FIND the legal
                           // band, then bisected this many times to place its
    bisectSteps: 6,        // ends: 5 m / 20 / 2^6 ≈ 4 mm. Neighbouring rays'
                           // ends are joined into one continuous polygon, so a
                           // straight build-zone edge comes out straight and the
                           // ground edge follows the ground. ~3 000 samples,
                           // ~2.5 ms, once per arm — never per frame.
    minPx: 6,              // screen radius below which the circle is not drawn

    okColor: '#7fff9a',    // the ghost's own OK green: "build anywhere in here"
    fillAlpha: 0.115,
    edgeAlpha: 0.5,
    edgePx: 1.6,

    invalidColor: '#050a0f',   // geometry refusal: the ground, the zone, itself
    invalidAlpha: 0.42,
    hatchColor: 'rgba(190, 215, 235, 0.16)',
    hatchGapPx: 9,
    hatchPx: 1,

    budgetColor: '#ffb347',    // money refusal: reachable, unaffordable
    budgetAlpha: 0.16,
    budgetEdgeAlpha: 0.55,
    budgetDash: [6, 5],

    pulseMs: 320,          // a refused click flashes ONCE and says nothing: the
    pulseAlpha: 0.5,       // dark slices go red, the amber band flares, or — for
    localPulseM: 0.55,     // a refusal the circle does not draw (already built,
                           // overlaps a member) — this radius of red at the click
    badPulseColor: '#ff5a3c',
    budgetPulseColor: '#ffc46b',
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

    // ---- DAMAGE v2.1 FEEDBACK: BENDING + CREEP (renderer.js) -------------
    // Bending is a DIFFERENT failure from axial compression and must not look
    // like it: the member bows LATERALLY, pushed along the water force
    // (m.waterFx/waterFy), not to a hash-picked side. When bendLoad governs,
    // this bow replaces the axial one — two bows on one member fight and read
    // as noise. bendBowFrom deliberately matches stressFrom so the handover
    // happens exactly where the axial bow would otherwise have started.
    bendBowFrom: 0.35,                  // bendLoad where the lateral bow appears
    bendBowMax: 0.30,                   // m sagitta at bendLoad 1.0, reference span
    bendBowCap: 1.5,                    // bendLoad clamp (past the limit it is breaking,
                                        // not bending further)
    bendBowRefLen: 4,                   // m span that earns the full bendBowMax
    bendBowLenMax: 1.6,                 // × cap on that length scaling
    bendBowLenFrac: 0.16,               // hard cap: sagitta ≤ this × member length,
                                        // so a short member never draws as a banana
    bendCrackSpread: 0.26,              // crack ticks span this fraction of the member,
                                        // centred on midspan (where bending snaps it)

    // A member whose damage is GROWING gets a slow amber halo — deliberately
    // unlike the fast white >stressWarn flash, because "degrading right now"
    // and "overloaded right now" are different warnings and the player must be
    // able to tell them apart at a glance.
    creepEps: 1e-5,                     // damage growth per frame that counts as creeping
    creepHold: 0.6,                     // s of sim time the cue holds after the last growth
                                        // (so it does not strobe on quantised deltas)
    creepPulseHz: 0.55,                 // slow, vs flashHz = 5
    creepPulseAlpha: 0.45,
    creepPulsePx: 4.2,                  // device px the halo extends past the member
                                        // at the top of its breath (it pulses in
                                        // width as well as alpha)
    creepPulseColor: '#ffb347',
    brokenColor: '#3b4147',
    debrisAlpha: 0.9,
    nodeColor: '#e8f2fa',
    nodePx: 3.4,
    selectColor: '#ffffff',
    selectPx: 3,

    // ---- box-delete marquee (build tool, drawn by renderer.drawMarquee) ----
    // The rect is a PREVIEW of a destructive action, so it is drawn in the
    // danger family and nothing else in the build phase uses that family — a
    // player cannot mistake it for the build zone (blue) or a ghost (green).
    marqueeFill: 'rgba(255, 90, 60, 0.09)',
    marqueeLine: '#ff6a5a',
    marqueeDash: [7, 5],            // its own dash, tighter than R.dash, so the
                                    // marquee edge does not read as a zone edge
    marqueeHitColor: '#ff5a3c',
    marqueeHitAlpha: 0.5,           // halo behind a member the box has caught
    marqueeHitDashAlpha: 0.9,       // dashed overstroke on the member itself
    marqueeCursorPx: 11,            // half-size of the idle box-delete cursor
    marqueeMinPx: 3,                // below this the rect is a click, not a box

    // ---- BUILDING v4 cues (renderer.js reads builder state only) ----------
    // The ARMED START is the joint the live reach circle is drawn from. It is
    // the centre of the picture rather than a separate promise, so it is a
    // steady ring, not a pulsing one — and it is drawn even when it sits on a
    // bare anchor with no design node on it yet, because otherwise the first
    // click of a dam would appear to mark nothing.
    chainHeadPx: 7.5,               // ring radius, device px
    chainHeadColor: '#7fff9a',      // the ghost's own OK green: "build from here"
    chainHeadLinePx: 2.2,
    chainHeadAlpha: 0.9,
    // (the breathing pulse retired with the chain: the armed start only exists
    //  while its circle does, and a live circle needs no second attention cue)

    // A node LIFTED by a press-and-hold drag: bigger than a design node, with a
    // soft halo so it reads as "in the air", and red the moment the move would
    // be illegal (a beam past its material's span, over budget, out of zone).
    dragNodePx: 6.5,
    dragNodeColor: '#ffffff',
    dragNodeGlowPx: 7,
    dragNodeGlowAlpha: 0.22,

    // ---- frame-the-build-zone button (hud.js -> camera.fitZone) ------------
    zoneFrameHeadroom: 8,           // m of world above the zone's lowest ground
    zoneFrameBelow: 1,              // …and m below it: the anchors sit ON that
                                    // line and a dam needs its foundation in
                                    // shot, so the ground is never the very
                                    // last row of pixels
    zoneFrameSamples: 24,           // terrain samples across the zone

    // ghost + labels
    ghostOk: '#7fff9a',
    ghostBad: '#ff6a5a',
    ghostAlpha: 0.75,
    labelFontPx: 12,
    labelPadPx: 5,
    // CSS px from the top of the canvas to the BUILD ZONE / PROTECT captions.
    // They used to sit at 22 device px, which on a phone is under the HUD's top
    // row — on a narrow countdown level the caption printed straight through the
    // flood timer. This clears the whole top row in both orientations.
    zoneLabelTopPx: 76,
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

    // ---- WATER v2: PARTICLE METABALL BODY (rendering/waterRenderer.js) ----
    // The bulk water is drawn FROM THE PARTICLES: cached radial sprites
    // accumulated with 'lighter' into a reduced-resolution offscreen buffer,
    // gained/clamped into one body with a defined edge, then depth-tinted by
    // morphological erosion of that mask. Nothing here reads water.depth: a
    // waterfall plume pollutes the derived columns, and the particles do not lie.
    blobBufScale: 0.5,         // offscreen buffer resolution vs device pixels.
                               // Half is the sweet spot: at 1/3 the waterline
                               // upscales into a 6 px smear, at 1 the blend cost
                               // triples for detail nobody sees through water.
    blobRadiusMul: 2.0,        // metaball kernel radius / particle spacing. Below
                               // ~1.5 the lattice does not fuse and a calm
                               // reservoir shows dots; above ~2 thin streams fatten.
    blobMinBufPx: 1.7,         // kernel radius floor in BUFFER px (far-zoom LOD:
                               // the body stays a body instead of dissolving)
    blobPeak: 1.0,             // per-particle sprite alpha before the gain
    blobGainPasses: 2,         // 'lighter' self-blits; silhouette gain = 2^n. With
                               // blobPeak this is the soft threshold that fuses
                               // the blobs into one body with a defined edge.
    blobSmooth: 0.75,          // mask blur radius in particle spacings, applied
                               // BEFORE the gain: kills the per-particle lattice
                               // ripple that otherwise reads as a lumpy crust.
    blobBodyAlpha: 0.58,       // base body opacity — LOW on purpose, so a puddle
                               // or a wave tongue shows the bed through it
    blobBodyColor: '#3a97d2',
    blobDeepColor: '#08375f',
    blobDepthBands: [0.15, 0.6, 1.6, 3.5],  // m below the free surface
    blobDepthAlphas: [0.30, 0.30, 0.32, 0.34],
    blobThinTest: 0.5,         // m of horizontal erosion applied to the whole
                               // depth stack: water narrower than ~2× this is a
                               // stream, not a body, so it keeps its light colour.
                               // Without it a 10 m waterfall renders as deep
                               // reservoir, because it does have water above it.
    blobRimShift: 0.10,        // m: mask − mask↓ = crisp surface line
    blobRimColor: '#cdeeff',
    blobRimMinThick: 0.3,      // m of water that must sit UNDER a stretch of
                               // surface before it earns a waterline highlight
    blobRimAlpha: 0.5,
    blobSheenShift: 0.30,      // m: the wider soft sky-sheen band under the line
    blobSheenColor: '#8fcdf2',
    blobSheenAlpha: 0.13,
    blobFuse: true,            // fuse interior grid cells into rects (perf)
    blobFuseMin: 3,            // min particles/cell before a cell can be interior
    blobFuseFrac: 0.55,        // ... or this fraction of a full cell, whichever is
                               // larger (the cell grows when zoomed out)
    blobGridMinPx: 5,          // device-px floor on the occupancy cell size
    blobGridMaxCells: 90000,   // safety valve on the occupancy grid
    blobFoamSpeed: 4.2,        // m/s where a particle starts carrying foam
    blobFoamFull: 9,           // m/s for full foam weight
    blobFoamMax: 900,          // hard cap on foam sprites per frame
    blobFoamR: 0.75,           // foam sprite radius in units of particle spacing
    blobFoamSprite: 0.3,       // per-sprite alpha (they stack: keep it low)
    blobFoamAlpha: 0.55,       // whole-layer alpha cap — foam can never go opaque
    blobFoamColor: '#eaf7ff',

    // ---- RETIRED in water v2 -------------------------------------------
    // The nappe/jet knobs below are dead: the real fluid pours over the crest
    // and squirts through the breach by itself, so drawing a hand-traced
    // ballistic sheet on top of it only fought the simulation. Kept so nothing
    // that still reads CONFIG.render.* breaks; delete on the next config sweep.
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
    maxMist: 8,                          // hard cap on live mist sprites
    maxFoam: 8,                         // ditto for foam puffs
    foamSpriteAlpha: 0.24,              // per-sprite cap (was 0.8: they stacked white)
    mistAlpha: 0.07,                    // per-sprite cap: bounds cumulative haze

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
    impactParticles: 4,
    breachRate: 3,                      // particles/s at a breach mouth. The breach flow
                                        // is REAL FLUID tearing through the gap now, so
                                        // this is a thin torn-spray garnish, nothing more
    overtopRate: 1.6,                   // ditto — the fluid ITSELF is the waterfall
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

    // water v2 debug layers (cycled with P while the F2 overlay is up):
    // particles → particles+pressure → pressure → none
    dbgParticlePx: 2.4,                 // device px per particle dot
    dbgParticleMax: 14000,              // safety cap on dots per frame
    dbgSpeedRef: 8,                     // m/s at the top of the speed ramp
    dbgSpeedRamp: ['#2a4bff', '#00b7ff', '#3dffd0', '#ffe066', '#ff5a3c'],
    dbgPressAlpha: 0.55,                // alpha of the fullest pressure cell
    dbgPressColor: '#ff8348',           // hot end of the pressure heat map
    dbgPressCold: '#1b3fa0',            // cold end
    dbgPressMinPx: 1.5,                 // stop drawing cells smaller than this
    dbgLayerLabel: true,                // name the active layer in the panel
    dbgPanelTopPx: 58,                  // device px below the top edge: clears the
                                        // HUD title, which used to sit on the FPS line

    // hud / screens
    timerUrgent: 10,                    // s remaining where the timer goes urgent
    toastMs: 1600,
    stressBarWarn: 0.8,

    // ---- TITLE DIORAMA (src/ui/titleScene.js) ---------------------------
    // The menu backdrop is not a decoration: it is the real engine running a
    // scripted valley — same terrain/fluid/coupling/solver/damage pipeline the
    // game uses — on its own read-only instances. Everything the loop does is a
    // consequence of these numbers, so this block IS the storyboard.
    //
    // The whole design rests on one relation from the damage model:
    //   bendLoad ≈ 0.034 · L² · (2H − L)      (L = face bay, H = head, timber)
    // At L = 2.25 m and a full head H = 4.5 m that is ≈ 1.16 — just past the
    // limit, which is exactly "JUST weak enough": the face spends the fill
    // climbing through the creep band (0.7+) where the amber halo and the
    // lateral bow live, tops out slightly overloaded, and then dies of
    // accumulated damage a few seconds later instead of snapping the instant
    // the water arrives. Lengthen the bay or raise the crest and it fails
    // during the fill; shorten either and it never fails at all.
    title: {
      enabled: true,
      levelId: 'title-diorama',     // renderer caches hills/strata under this id

      // ---- timing (SIM seconds; the whole loop is a function of these) ----
      // MEASURED storyboard at these numbers — printed by
      // `node tests/ui-title.mjs --timeline`, and gated by its assertions:
      //   0.0–1.2   a calm pond (surface 7.4) against a whole dam, face at 0.3
      //   1.2–5.0   the river appears down the left wall and runs at the dam
      //   5.0–6.5   the front arrives: surface 7.8 → 8.7, and the face goes from
      //             load 0.32 to 1.02 in a second and a half
      //   6.5–14.1  the long phase, and the one that matters. The reservoir works
      //             between 8.9 and 9.8 against a 10.1 m crest and slops over it
      //             in bursts (33 `overtop` events). The face sits at 0.96–1.17:
      //             bowing along the water force, amber creep halo up, crack
      //             ticks growing, damage 0.06 → 0.93 — visibly dying, and still
      //             holding. This is what "about to fail" looks like.
      //   14.15     the bottom face bay snaps in BENDING at load 1.23
      //   14.75+    the bottom brace (2.55) and the lower tie (2.15) go with it;
      //             the upper brace follows at 16.4. Four of eight members gone.
      //   14–19     the reservoir tears out through the hole, 9.7 → 8.3, and
      //             washes the wreck downstream past the sign, the stand of
      //             trees and the house
      //   18.9–20   the cut
      // The tail is short on purpose. Left running to 24 s the downstream plain
      // fills, the two water bodies merge, and the last third of the loop is a
      // lake with no dam in it — which is the one thing the title screen must
      // never be showing.
      loop: 20,                     // s per cycle, then everything is rebuilt
      timeScale: 1,                 // sim seconds per real second
      maxCatchUp: 0.05,             // s of accumulator kept. Deliberately UNDER
                                    // two ticks: coming back to the menu after
                                    // a level must not fast-forward a burst of
                                    // physics, and a slow frame should slow the
                                    // diorama down rather than stutter it.
      maxTicks: 2,                  // hard cap on physics ticks per frame
      fadeIn: 0.55,                 // s of black at the top of the loop
      fadeOut: 1.1,                 // s of black at the end — the cut that hides
                                    // the reservoir refilling in one frame

      // ---- the valley ----
      // Three decisions here are all about the FRAME, not the geography:
      //
      // 1. The left wall tops out at 12.2 m, not 18. The fluid grid adds
      //    CONFIG.fluid.yHead (9 m) of splash room above the HIGHEST terrain
      //    point, so a decorative peak costs real pressure-solve cells.
      // 2. The downstream side is a floodplain at ~4.2 m, not a gorge down to
      //    zero. A 9 m drop behind the dam cannot be in shot at the same time as
      //    a reservoir low enough to sit under the menu text — the two together
      //    need 22 m of vertical, which means zooming out until the whole thing
      //    reads as a map. Raising the downstream ground buys the composition
      //    back and costs nothing dramatic: the breach still falls 5.8 m.
      // 3. It also raises the terrain MINIMUM, which is what renderer.js pins
      //    its parallax hills to (tLow + fraction·viewHeight). With the low
      //    point at −0.4 every ridge sat below the reservoir and the sky was
      //    empty; at 4.0 the far ridge crests just above the waterline.
      //
      // It runs to x=70 so the flood has somewhere to go: 30 m of plain keeps
      // the escaped water shallow instead of backing it up against the dam's toe.
      terrain: [
        [0, 12.2], [2.5, 11.8], [5, 11.2], [7.5, 10.2], [9.5, 8.6], [11.5, 7.0],
        [14, 5.9], [18, 5.2], [23, 4.9], [28, 5.0], [30.6, 5.3],
        [32.4, 5.6], [35.8, 5.6],
        [37.8, 4.6], [40, 4.1], [44.5, 3.7], [52, 3.1], [62, 2.4], [70, 2],
      ],
      // Props sit DOWNSTREAM on purpose. Everything upstream of the dam ends up
      // under 4 m of water, and a submerged pine reads as a mistake; everything
      // downstream is what the dam is for — so the frame contains a signpost, a
      // stand of trees and a house, and by t=17 the flood is going through all
      // of them. That is the whole game in one shot.
      props: [
        { type: 'sign', x: 36.8 }, { type: 'rock', x: 38.1, scale: 0.75 },
        { type: 'pine', x: 39.8, scale: 0.95 }, { type: 'tree', x: 41.2, scale: 0.8 },
        { type: 'house', x: 43 }, { type: 'pine', x: 45, scale: 0.85 },
        { type: 'tree', x: 46.6, scale: 0.9 },
      ],

      // ---- the dam: a two-column timber crib on the 2.6 m sill ----
      dam: {
        x0: 32.4, x1: 35.8,         // upstream face / downstream face. 3.4 m of
                                    // sill, not 2.6: at 2.6 the crib was half a metre
                                    // taller than it was wide and read as a sluice
                                    // GATE rather than a dam. Widening costs nothing
                                    // structurally — the ties get longer, and it is
                                    // rowH (the face bay) that decides bending.
        y: 5.6,                     // sill elevation (both feet anchored)
        rows: 2,                    // bays above the sill
        rowH: 2.25,                 // m per bay → crest 10.1, bay length L
        mat: 'timber',
      },

      // ---- water ----
      pond: { x0: 6, x1: 32.2, surface: 7.6 },   // ~48 m² already impounded
      flood: { x: 2, rate: 3.6, duration: 16, delay: 1.2 },
                                    // 58 m² down the left wall: surface 7.6 → 9.8.
                                    // Rate is the pacing knob for the whole loop. At
                                    // 5 m²/s the front arrived as a wall of water and
                                    // pinned the face at load 1.17 from t=6, which
                                    // failed it at t=12 and left eight dead seconds;
                                    // at 3.6 the rise is gradual, the strain phase
                                    // lasts six seconds, and the break lands at 14.6.

      // ---- camera (fixed cinematic framing; no player control) ----
      // The composition rule this settled on: the DOM text owns the top of the
      // frame, the water owns the bottom, and the crest of the dam is the line
      // between them. sillAt places the sill 81% of the way down, which puts the
      // crest at ~60% and the waterline just under the last line of menu text —
      // so the wordmark is never sitting on a moving surface. (At sillAt 0.64 it
      // was: the reservoir filled to exactly the height of the letterforms.)
      // MEASURED, so nobody has to guess again: these are NOT a useful
      // performance dial. waterRenderer's metaball pass confines itself to the
      // particle bounding box grown by the kernel, the blur and the deepest
      // depth-band shift — and that last term is 3.5 m, which at any sane zoom
      // is ~150 device px of padding on every side of a reservoir only ~130 px
      // deep. The dirty rectangle is therefore dominated by the padding, not by
      // the water, and pulling the framing from 38 m out to 43 m (34 px/m down
      // to 30) bought 0.3 ms of 5.7. 40 m is chosen for the picture alone.
      viewW: 40,                    // m of world across, when the aspect allows
      viewH: 22.5,                  // m of world down, ditto
      zoomInMax: 2.2,               // A portrait phone cannot have both: fit 26 m
                                    // of width and it shows 45 m of empty sky.
                                    // So a tall canvas zooms in — but only up to
                                    // this multiple of the fit-width zoom, or the
                                    // frame closes to three metres of dam.
      focusX: 34.1,                 // the dam site
      focusBias: 0.16,              // fraction of the view the focus sits RIGHT of
                                    // centre, so the reservoir owns the left half
      sillAt: 0.81,                 // screen fraction the sill sits at (landscape)
      sillAtTall: 0.80,             // ... on a portrait canvas: the diorama becomes
                                    // a lower band and the logo sits over the sky
      sway: 0.35,                   // m of horizontal drift over one loop (one full
                                    // period per loop, so the cut never jumps)
      breathe: 0.02,                // fraction of zoom breathed over one loop

      // ---- atmosphere ----
      // The renderer's parallax hills are pinned to the terrain's LOWEST point
      // and sized as a fraction of the view height, which puts them below this
      // valley's crest at this zoom — i.e. behind the terrain, invisible. Rather
      // than fight that (renderer.js is not ours to reshape), the diorama adds
      // its own single atmospheric term: a soft band of cool light lying along
      // the horizon, drawn over everything. It reads as valley air, it gives the
      // dark sky something to be dark AGAINST, and it costs one gradient.
      hazeColor: '#5aa8dc',
      hazeAlpha: 0.26,
      hazeTop: 13,                  // m above the sill where the band fades out
      hazeBottom: 0.5,              // m below it — the band sits in the SKY, peaking
                                    // just above the crest, so the dam and the
                                    // waterline are silhouetted against the brightest
                                    // part of the frame instead of against black

      // ---- level select: same diorama, pushed back ----
      levelsZoom: 0.90,
      levelsSillAt: 0.86,
      levelsSillAtTall: 0.86,
      levelsDim: 0.30,              // extra scrim alpha over the canvas
      dimColor: '#0d1b26',
    },
  },

  // Touch loupe: the magnifier that keeps a finger from hiding the point it is
  // placing. Centred on the FINGERTIP (touch building v3 has no offset cursor —
  // the snapped preview and its snap rings are drawn in the frame itself, and
  // the loupe's job is only to let the player SEE them under their own hand).
  loupe: {
    radiusPx: 52,          // circle radius (CSS px)
    zoom: 2.2,             // magnification of the frame region
    offsetPx: 88,          // fingertip -> loupe centre distance
    topClearancePx: 96,    // don't collide with the HUD top row
    ringPx: 3,
    ringOk: '#7fff9a',
    ringBad: '#ff5a3c',
    ringNeutral: '#35a7ff',
    cross: 'rgba(230, 245, 255, 0.9)',
    crossPx: 10,
    backing: 'rgba(6, 12, 18, 0.7)',
  },

  // ---- TOUCH FEEL (Fable) ------------------------------------------------
  // Building v4 (CONFIG.reach) is one gesture on both inputs, so these are no
  // longer a touch-only dialect: they are the body measurements a thumb needs.
  // snapMul makes joints POP under a fingertip, holdMs/holdSlopPx are the
  // press-and-hold that lifts a node (mouse too), tapMaxPx is how much a thumb
  // is allowed to roll as it leaves the glass and still count as a tap.
  touch: {
    snapMul: 2.0,          // node/anchor snap radii × this for a touch gesture.
                           // The grid stays 0.5 m: a thumb does not need a finer
                           // grid, it needs the preview to POP decisively onto
                           // the joint it is near instead of hovering off it.
    holdMs: 350,           // press-and-HOLD this long on an existing design node
                           // and the node lifts into a drag (mouse too)
    holdSlopPx: 10,        // CSS px of travel allowed during that hold. Past it
                           // the gesture is a slide — a beam, not a node move.
    tapMaxPx: 14,          // CSS px of travel under which a press+lift counts as
                           // a TAP. Looser than the mouse's CONFIG.build.tapMaxPx
                           // because a thumb rolls as it leaves the glass; a tap
                           // on the ARMED START is what ends a run.
  },

  levels: {
    tutorialKey: 'dam-builder-tut',     // localStorage flag for the level-1 tutorial
    tutorialLevel: 1,                   // campaign index that shows the tutorial
    minRunout: 15,                      // m of downstream runout every valley must have
  },

  debug: { enabled: false },
};
