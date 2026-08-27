# DAM BUILDER — ARCHITECTURE CONTRACT

**Owner of this file: FABLE (game director).** This file is the single source of
truth for shared interfaces. No agent may change an interface without Fable
updating this document first. If you need a change, report WHY to your parent;
do not silently break the contract.

---

## 1. Technology

- HTML + CSS + vanilla JS (ES modules), Canvas 2D. No frameworks, no build step.
- PWA like `../maxgear`: `manifest.webmanifest` + `sw.js` versioned precache with
  opt-in updates ("UPDATE READY" button). All paths **relative** (GitHub Pages
  subpath). Runs via `python3 -m http.server` locally or GitHub Pages.
- Must work with mouse **and** touch (Pointer Events; pinch zoom, drag pan).
- Physics modules (`src/physics/*`, `src/build/materials.js`, `src/levels/levels.js`,
  `src/core/terrain.js`) must be **DOM-free** so they run under Node for tests.

## 2. Coordinate system & units

- World units are **meters**, **y-up** (gravity is −y). The renderer does the
  single y-flip: `screenY = h/2 − (y − cam.y)·zoom`.
- Terrain is a heightfield polyline left→right. Levels span roughly x ∈ [0, 60..150],
  dam heights 5–15 m.
- Fixed physics timestep `CONFIG.physics.dt = 1/60`, accumulator clamped to
  0.25 s. Sim speed 0.25/1/2/4 = fractional/multiple ticks per frame.
- **Determinism**: no `Math.random()` in physics. Visual effects may use randomness.

## 3. Simulation update loop (owned by core/game.js)

Per physics tick during `sim` phase, **in this order**:

```
coupling.updateObstructions(structure, water)   // structure → water geometry
water.stepWater(water, dt)                      // bulk water movement
coupling.applyWaterForces(structure, water, dt) // water → node force accumulators
constraints.stepStructure(structure, terrain, dt) // verlet + solver + ground
stress.updateStress(structure, dt, time)        // strain→load→damage→breaks
modes.update(dt)                                // objectives, win/fail
effects.step(dt)                                // visual only (every frame ok)
```

Render every animation frame (interpolation not required for v1).

## 4. File ownership

```
FABLE (do not edit without Fable):
  index.html  manifest.webmanifest  sw.js  ARCHITECTURE.md  README.md
  src/main.js  src/config.js
  src/core/game.js  src/core/state.js  src/core/events.js
  src/core/terrain.js  src/core/camera.js  src/core/input.js
  src/rendering/loupe.js  (touch placement magnifier)

OPUS A — Physics & Simulation:
  src/physics/structures.js   (nodes/members/debris data + instantiate)
  src/physics/constraints.js  (verlet integration + iterative solver + ground collision)
  src/physics/stress.js       (strain→load→damage→break, failure record)
  src/physics/water.js        (1-D shallow-water column grid)
  src/physics/coupling.js     (two-way water↔structure interface)
  tests/*                     (Node test scenes 1–8, `node tests/run.js`)

OPUS B — Construction & Gameplay:
  src/build/builder.js        (design editing: place/connect/delete/ghost)
  src/build/snapping.js       (grid/node/anchor snapping, validity)
  src/build/materials.js      (material data, pure data module)
  src/build/modes.js          (phase flow, countdown, objectives, win/fail, stats)

OPUS C — Rendering, UX & Content:
  styles.css
  src/rendering/renderer.js   src/rendering/waterRenderer.js  src/rendering/effects.js
  src/ui/hud.js  src/ui/screens.js  src/ui/debug.js  src/ui/titleScene.js
  src/levels/levels.js  src/levels/levelLoader.js
```

Rule: only the owner performs major edits to a file. Everyone may READ anything.

## 5. Core shared data structures

### Terrain (created by `core/terrain.js`)

```js
createTerrain(points, anchorSpecs) => terrain
terrain = {
  points,            // [[x,y],...] left→right ground surface
  anchors,           // [{id, x, y, r}]  r = snap radius (default 0.9)
  minX, maxX,
  heightAt(x),       // piecewise-linear ground elevation (clamped outside range)
}
```

### Design (build-time; produced by builder, consumed by structures.instantiate)

```js
design = {
  nodes:   [{id, x, y, anchorId}],   // anchorId: terrain anchor id or null
  members: [{id, a, b, mat}],        // a/b = node ids, mat = material id string
}
```

### Material (schema; data lives in `src/build/materials.js`)

```js
{
  id, name, color, darkColor,
  costPerMeter, massPerMeter,
  thickness,            // meters; visual width AND water-sealing width
  stiffness,            // 0..1 constraint stiffness per solver iteration
  tensionLimit,         // strain (ΔL/L) at load = 1.0 in tension
  compressionLimit,     // strain at load = 1.0 in compression (positive number)
  tensionOnly,          // true for cable: no compression resistance, no water seal
  minLength, maxLength, // build constraints (meters)
  sealing,              // true if it blocks water (cable: false)
}
```

### Structure (runtime physics; owned by Opus A)

```js
structures.instantiate(design, terrain, materials) => structure
structure = {
  nodes: [{
    id, x, y, px, py,     // verlet current + previous
    invMass,              // 0 when anchored
    anchored, ax, ay,     // anchor world position when anchored
    fx, fy,               // EXTERNAL force accumulator (water writes, solver consumes+clears)
    onGround,             // set by collision pass
  }],
  members: [{
    id, a, b,             // node object refs
    mat,                  // material object ref
    restLength, broken,
    strain,               // signed (ΔL/L), + = tension
    load,                 // utilization ≥ 0; 1.0 = at limit (uses tension/compression limit by sign)
    loadSign,             // +1 tension, −1 compression
    damage,               // 0..1 accumulated; break at ≥ 1
  }],
  debris: [],             // broken free pieces, same node/member shapes, no build meaning
  time, brokenCount, maxLoad,
  firstFailure,           // null | {memberId, mode:'tension'|'compression', time, x, y}
}
```

**Force convention**: anything external (water, wind later) ADDS to `node.fx/fy`
(game-newtons). `constraints.stepStructure` applies `a = f·invMass + g`, then
zeroes the accumulators. Nobody else zeroes them.

### Water (owned by Opus A) — v2: PIC/FLIP particle-grid fluid (DIRECTOR DECISION)

v2 replaces the v1 column heightfield with a **PIC/FLIP hybrid**: the water IS
particles (typed arrays), advected through a MAC grid pressure solve
(incompressible, Gauss-Seidel fixed iterations, solid cells from terrain).
Structural members enter the fluid as **capsule colliders**; water→structure
forces come from the fluid solve itself (solid-boundary pressure and/or
contact impulses), so hydrostatics, wave impact, leak jets, overtopping and
splashes all EMERGE — nothing is scripted. No external engine or dependency:
hand-rolled, DOM-free, deterministic (fixed timestep, fixed iteration order,
no Math.random; seeding/emission jitter must be hash-based).

**Public API compatibility is mandatory.** The v1 query surface stays:
`createWater(terrain, cfg)`, `stepWater`, `addWater{x0,x1,surface}`,
`addSource{x,rate,duration,delay}`, `surfaceAt/depthAt/velAt/volumeBetween`,
`stats.totalIn`, and the derived per-column arrays `x0, cellW, n, bed, depth,
vel` are REBUILT each tick from particle binning so renderer/modes/HUD keep
working unchanged. New v2 surface for renderer/coupling:

```js
water.pcount, water.ppx, water.ppy, water.pvx, water.pvy  // particle state (typed arrays)
water.setColliders(water, capsules)  // [{ax,ay,bx,by,r,ref}] from coupling; replaces blocked-interval rasterization
water.colliderForces                 // per-ref accumulated {fx, fy, applicationY…} from the solve
```

Hard gates before integration (tests/run.js equivalents): analytic hydrostatic
total force on a wall within ±30% of ½ρgH², bottom-quartile band ≥ 3× top
band; a settled reservoir is CALM (flat surface, no popcorn, steady wall load);
ZERO tunneling through a sealed wall (substep CFL clamp); dam-break front with
impact peak ≥ 2.5× its static follow-on; hole → jet + faster drain; overtop;
progressive collapse; exact two-run determinism; perf ≥ 4000 particles + 250
members ≤ 6 ms/tick in Node on this machine.

```js
water.createWater(terrain, cfg) => water
water = {
  x0, cellW, n,               // grid origin, cell width (CONFIG.water.cellW), cell count
  bed,                        // Float32Array(n) terrain elevation at cell centers
  depth,                      // Float32Array(n) water depth ≥ 0
  vel,                        // Float32Array(n+1) horizontal velocity at boundaries
  blocked,                    // Array(n+1) of null | [[y0,y1],...] merged blocked intervals per boundary
  stats: { totalIn, /* volume added by sources */ },
}
water.stepWater(water, dt)
water.addWater(water, {x0, x1, surface})            // instant fill to surface elevation
water.addSource(water, {x, rate, duration, delay})  // inflow (m²/s in 2-D world)
water.setBoundaryBlocks(water, blocked)             // coupling writes obstruction geometry
water.surfaceAt(water, x)   // bed+depth elevation (bed height where dry)
water.depthAt(water, x)
water.velAt(water, x)       // horizontal velocity
water.volumeBetween(water, x0, x1)
```

Required behavior: downhill flow, accumulation against blocked boundaries,
rising reservoir, flow through un-blocked y-intervals (leaks ∝ gap size and
head difference; orifice-like), overtopping when surface exceeds the blocked
crest (weir-like), momentum so a flood front arrives as a moving wave.

### Coupling (owned by Opus A) — THE most important module

```js
coupling.updateObstructions(structure, water)   // v2: name kept for compat
  // Build the capsule collider list from every unbroken member with
  // mat.sealing (radius from mat.thickness/2) and hand it to
  // water.setColliders. Broken members drop out → breach emerges physically.

coupling.applyWaterForces(structure, water, dt)
  // Distribute water.colliderForces (from the fluid solve) onto the two end
  // nodes of each member by lever arm; scale knobs live in CONFIG.coupling.
  // Buoyancy + drag on submerged nodes and debris via the fluid velocity field.
  // Emits the SAME events with the same semantics: 'water:impact' (strong
  // fast-water hits, ≥3 m/s), 'breach' {x,y,flow} and 'overtop' {x,flow}
  // re-firing ~0.3 s while flow persists, derived from particle flux through
  // gaps in / over a mostly-sealed dam region (renderer nappe/jets read these
  // until the particle-true rendering round replaces them).
```

Water depth MUST increase load (hydrostatic), and fast water MUST hit harder
than still water (dynamic term). Both directions of the interaction are
mandatory: dam blocks/redirects water; water loads and destroys dam.

### Damage model (stress.js; thresholds in CONFIG.damage) — v2.1 adds bending + creep

```
axialLoad = |strain| / limit (slenderness-reduced in compression)
bendLoad  = m.waterFperp · len / (8 · CONFIG.damage.bendScale · mat.bending)
load      = max(axialLoad, bendLoad)

load < creepStart(0.7)  safe
creepStart – 1.0        creep: damage += mat.creepRate · (load−creepStart)/(1−creepStart) · dt
                        (timber fast: ~0.85 sustained fails in ~25–35 s; steel ~20× slower)
1.0 – 1.2               damage += (load − 1) · damageRate · dt   (creep still applies)
> 1.2                   fastRate band
load ≥ hardBreak(1.6)   instant break
damage ≥ 1              break
```

Coupling writes per-member lateral water force each tick: `m.waterFx`,
`m.waterFy`, `m.waterFperp` (component ⊥ to member axis; + = left of a→b).
stress.js sets `m.bendLoad` — an EMA (`CONFIG.damage.bendTau`, 0.15 s) of the
instantaneous moment ratio, so the fluid's one-tick sim-start pressure
transient can't decide a rating while a real wave (≥1 s) still registers.
Rendering: lateral bow ∝ bendLoad, direction along waterFx/waterFy.
`firstFailure.mode` gains `'bending'`; `firstFailure.sustained` and the
`member:break` payload's `sustained` are set on EVERY break (true when the
final load was < 1.0 — a creep failure; false for overload). Material schema
gains `bending` (moment capacity, derived ∝ thickness² · tension),
`creepRate` (damage/s at load 1.0), `headRating` (display-only meters, shown
in the HUD; current: timber 3, steel 7, concrete 8, cable 0).

On break: member.broken = true, spawn debris piece (Opus A), record
firstFailure if null, return/emit `'member:break' {id, x, y, mode, matId}`.
Recommended: slenderness reduces effective compression limit
(`limit / (1 + k·(len/refLen)²)`) so long unbraced beams buckle.

## 6. Events (core/events.js) — canonical names

```js
import { on, off, emit } from '../core/events.js';
```

| event            | payload                                        | emitter |
|------------------|------------------------------------------------|---------|
| `member:break`   | `{id, x, y, mode, matId, load, sustained}` (mode incl. 'bending'; load = pre-break severity; sustained = creep failure) | stress  |
| `water:impact`   | `{x, y, speed, magnitude, dir}` (dir = ±1 flow sign) | coupling|
| `breach`         | `{x, y, flow}` — re-fires ~every 0.3 s while flow lasts | coupling|
| `overtop`        | `{x, flow}` — re-fires ~every 0.3 s while flow lasts | coupling|
| `sim:start` / `sim:reset` | `{}`                                  | game    |
| `level:win` / `level:fail`| `{stats}` (fail adds `{cause}`)       | modes   |
| `phase:change`   | `{phase}`                                      | game    |
| `ui:release` `ui:retry` `ui:edit` `ui:menu` `ui:speed{v}` `ui:material{id}` `ui:tool{id}` `ui:undo` `ui:redo` `ui:delete` `ui:clear` | | hud |
| `ui:level`       | `{index}` (1-based campaign index)             | screens |
| `design:change`  | `{action:'place'\|'delete', id}` (sounds/UI refresh) | builder |
| `input:down/move/up` | `{x, y, px, py, id, button, cancel, ptype}` (ptype: 'touch'\|'mouse'\|'pen' — drives the touch loupe) | input   |
| `input:pan` `{dx,dy}` px · `input:zoom` `{px,py,factor}` · `input:key` `{key}` | | input |

Stats object (modes.js builds it; result screen shows it):

```js
{retained, peakDepth, maxLoad, brokenCount, cost, survivalTime, win, cause}
```

## 7. Game phases (core/game.js owns the machine)

`title → levelselect → build → sim → result` (+ `paused`). Countdown mode:
`build` runs with a live timer AND live water already flowing from far
upstream (the flood is physically visible approaching); when it arrives the
phase auto-switches to `sim` (building locks). Free build: `RELEASE WATER`
button emits `ui:release`. Retry = re-instantiate structure from design +
fresh water; must be near-instant.

Game exposes to other modules (import `src/core/game.js`):

```js
game.getScene() => {phase, terrain, water, structure, design, level, camera,
                    simSpeed, buildTimer, simTime, stats}
// ghost + selection + tool + hover state live in build/builder.js getBuilder()
game.loadLevel(id) · game.release() · game.retry() · game.toEdit() ·
game.setSpeed(v) · game.loadTestScene(i)  // physics test scenes 1–8
```

## 8. Level format (data in src/levels/levels.js, pure data)

```js
{
  id: 'level-01', name: 'First Trickle', subtitle: '...',
  mode: 'freebuild' | 'countdown',
  countdown: 90,                     // seconds (countdown mode)
  terrain: [[0,14],[20,6],...],      // y-up ground polyline
  anchors: [[x,y],...],
  buildZone: {x0, x1},               // building allowed only here (null = anywhere)
  water: {
    initial: [{x0, x1, surface}],    // pre-filled ponds
    flood:  {x, rate, duration, delay},
    floods: [{x, rate, duration, delay}, ...], // optional EXTRA pulses (the sim's
                                     // source list is plural already) — used for
                                     // multi-surge levels like 'aftershock'
  },
  budget: 12000,
  materials: ['timber','steel','concrete','cable'],
  objective: {type:'retain', minRetention:0.9, duration:45}
           | {type:'survive', duration:60}
           | {type:'protect', x0, x1, maxDepth:0.3, duration:60},
  hints: ['...'],
  props: [{type:'pine'|'tree'|'rock'|'house'|'sign', x, y?, scale?}], // decor only
  prebuilt: {                        // optional: a design already standing at load
    nodes: [[x, y], ...],            // ('repair the old dam' levels). Node ids are
    members: [[ai, bi, matId], ...], // 'p1'.., members 'pm1'.. (never collide with
  },                                 // the builder's 'n'/'m'). Its cost counts
                                     // against the budget; deleting refunds. Must
                                     // be player-buildable (levels-check gates it)
                                     // and must NOT win the level on its own
                                     // (levels-nodam runs with it standing).
}
```

`levelLoader.load(spec)` returns `{terrain, waterSetup, level}` ready for game.

## 9. Rendering contract (Opus C)

```js
renderer.render(ctx, camera, scene)        // terrain, anchors, buildZone, structure
renderer.renderStressOverlay(ctx, camera, scene, wetTest?)
   // documented exception to "renderer draws before waterRenderer":
   // waterRenderer calls this at the end of its own pass so overloaded
   // members stay readable under deep water. wetTest(x,y) is an optional
   // particle-true wetness probe waterRenderer supplies (column fallback
   // otherwise). waterRenderer also exports stats() — per-frame ms /
   // particles / sprites / dirty ratio for the F2 overlay and perf runs.
                                           // members colored by load (tension cool,
                                           // compression warm, flashing >0.8, thickness
                                           // + slight deform near failure), design ghosts
waterRenderer.render(ctx, camera, water)   // smoothed surface, depth gradient, foam
effects.step(dt) / effects.render(ctx, camera)  // spray, debris dust, cracks, camera shake (subtle)
debug.toggle() / debug.render(ctx, camera, scene)  // F2: forces, stress numbers, blocked intervals, vel vectors, FPS
```

Camera (`core/camera.js`, Fable): `{x, y, zoom, worldToScreen(x,y)=>[px,py],
screenToWorld(px,py)=>[x,y], pan(dxPx,dyPx), zoomAt(px,py,f), fit(terrain,canvas)}`.

HUD/screens (Opus C) are DOM elements in index.html + styles.css; hud.js updates
them from `game.getScene()` each frame and emits `ui:*` events. Mobile-first
sizing (min 44px touch targets).

## 10. Build interaction contract (Opus B)

- Pointer down on empty/node + drag = ghost member; release = place (both nodes
  created/merged via snapping). Right-click or eraser tool = delete member.
  Tap node/member selects. `input:*` events carry world coords already.
- Snapping: existing nodes (r≈0.6 m), anchors (r≈0.9), the armed reach circle's
  rim (r≈0.6, snapPoint opts.rim — lands at exactly maxLength, so max-length
  beams are one click), grid 0.5 m — in that order; then BOUNDARY REPAIR
  (snapping.snapEnd, r≈0.45): a gesture end whose snap refuses for a PLACE
  reason slides to the nearest legal spot (onto the ground surface, to the zone
  edge, inside maxLength) — never a node/anchor — so the reach circle's
  build/no-build edge is the true geometric line, smooth, not grid staircase.
  Max/min member length by material; cost preview on ghost; invalid = red ghost
  (over budget, too long, outside buildZone, inside terrain).
- Keys: 1–4 materials, Space release/pause, R retry, Delete remove selection,
  X box-delete tool, E erase.
- BUILDING v4 — THE REACH CIRCLE (all inputs: mouse, pen, touch): a build
  gesture may only START on a terrain anchor or an existing design joint (no
  free starts anywhere). Arming draws a circle of radius material.maxLength
  (NEVER budget-scaled) that expands ~200 ms; its lit region is
  snap-then-validate GEOMETRY ONLY (length annulus, build zone, terrain incl.
  mid-span cut) plus an amber band beyond budgetLeft/costPerMeter. A click
  anywhere lit commits the girder to the snapped point and THE CIRCLE
  DISMISSES — nothing stays armed; chaining is just re-arming the fresh
  joint. Press-drag-release inside the circle commits in one gesture.
  Outside: anchor/joint re-arms, member TAP selects, empty TAP dismisses;
  clicking the armed start cancels. A DRAG from any press that cannot build
  (build tool, no completion, no joint) PANS the camera past tapMax — and a
  pan never dismisses the circle. Refusals pulse (red = geometry, amber = budget,
  small local mark = design rules like 'already built'), no hint text except
  'over budget'. Split authority: snapping.geometryReason() draws the PLACE;
  validate() (geometry + design rules) judges the MEMBER on click.
  getBuilder().reach = null | {x, y, nodeId, anchorId, kind, r, rAfford,
  material, touch, t01, seq, version}; .chainHead mirrors the live circle's
  centre (always a real anchor/node, always null after a commit);
  .reachPulse = null | {kind:'bad'|'budget'|'local', x, y, seq}.
  snapPoint's chainNodeId option is no longer used by any gesture.
- NODE DRAGGING (mouse + touch): press-and-hold CONFIG.touch.holdMs (350 ms,
  slop holdSlopPx) on a design node lifts it; it follows the snapped pointer
  (anchors/grid only), attached members recompute live with validity; valid
  lift = ONE undo step (anchorId gained/lost on drop), invalid = full revert.
  Builder publishes getBuilder().chainHead {x,y,nodeId,anchorId,kind,pending}
  and .nodeDrag {nodeId,x,y,anchorId,ok,reason,touch,orig,members,snap};
  design:change gains {action:'move', id}. loupe.js is finger-centred.
- Budget: cost = Σ len·costPerMeter; builder refuses placement over budget.
- modes.js runs objectives: track retention via `water.volumeBetween` +
  `stats.totalIn`, protect-zone depth via `depthAt`, survival timer, and emits
  `level:win`/`level:fail` once, with the stats object of §6.

## 11. Config (src/config.js, Fable owns file; agents PROPOSE values)

All tunables live in `CONFIG`: `physics{dt, substeps, iterations, gravity,
groundFriction}`, `water{cellW, g, damping, maxVel, minDepth}`,
`coupling{pressureScale, impactScale, dragScale, buoyancyScale}`,
`damage{safe:0.8, damageRate, fastRate, hardBreak}`, `render{...}`,
`debug{enabled}`. No magic numbers scattered in code — add to CONFIG.

## 12. Test scenes (tests/, Opus A; also loadable in browser via game.loadTestScene)

1 single beam under gravity · 2 triangle truss · 3 wall vs shallow water ·
4 wall vs deep water (must load harder at bottom) · 5 hole in dam (leak jet) ·
6 flood wave impact (moving water breaks what still water wouldn't) ·
7 overtopping · 8 progressive collapse. `node tests/run.js` prints PASS/FAIL
with numeric assertions (e.g. "deep water bottom-member load > 2× top-member").

## 13. Priorities (when trading off)

1. water↔structure interaction  2. structural failure  3. player understanding
4. construction feel  5. water looks  6. performance (60fps target)  7. levels
8. UI polish  9. audio (skip for v1).
