// OPUS C owns. Campaign level data, pure data, DOM-free (must run under Node).
// Format: ARCHITECTURE.md §8. Last entry = sandbox (screens.js does
// emit('ui:level', {index: LEVELS.length}) for the sandbox button; game.js
// does LEVELS[index-1]).
//
// THE DAM LINE (see src/build/modes.js damLineX): for 'retain'/'survive'
// levels it is level.buildZone.x1; for 'protect' levels it is objective.x0.
// Every flood source and initial pond must sit upstream (smaller x) of that
// line, or it permanently counts against retention (see modes.js totalIn).
//
// OPUS C EXTENSION — `props` (decorative only, never affects gameplay):
//
//   props: [
//     {type:'pine',  x: 8},              // y omitted -> terrain.heightAt(x)
//     {type:'tree',  x: 12, scale: 1.2},
//     {type:'rock',  x: 30},
//     {type:'house', x: 74},             // used to dress a protect-zone village
//     {type:'sign',  x: 26},             // marker post near a dam site
//   ]
//
// Allowed `type` values EXACTLY: 'pine' | 'tree' | 'rock' | 'house' | 'sign'.
// Optional `y` (world elevation, y-up; default = terrain.heightAt(x)) and
// `scale` (default 1). levelLoader.js normalises/resolves these. Kept out of
// every level's buildZone and off the dam site itself so they never obscure
// the structure the player is building.

export const LEVELS = [
  // ------------------------------------------------------------------ 1 --
  // intended solution: a braced timber wall on the short 2.5 m sill between
  // A(29,3.8) and B(31.5,3.8), 3 rows to a crest of 6.2 m: 16 members,
  // about $400. The sill is deliberately short enough that a plain braced
  // rectangle seals it — this level only has to teach drag-to-build.
  // difficulty note: the only level (with 2) where the naive braced wall is
  // meant to win outright. Retention target is a forgiving 70%.
  {
    id: 'level-01',
    name: 'First Trickle',
    subtitle: 'Build a small wall. Hold back the stream.',
    mode: 'freebuild',
    terrain: [
      [0, 8], [6, 6.5], [10, 5], [14, 3.8], [18, 3], [23, 3], [26, 3.4],
      [29, 3.8], [31.5, 3.8], [34, 2.2], [40, 0.5], [48, -1], [58, -2],
    ],
    anchors: [[29, 3.8], [31.5, 3.8]],
    buildZone: { x0: 27, x1: 32 },
    water: {
      initial: [{ x0: 18, x1: 25, surface: 3.6 }],
      flood: { x: 2, rate: 1.89, duration: 28, delay: 0 },
    },
    budget: 560,
    materials: ['timber'],
    objective: { type: 'retain', minRetention: 0.7, duration: 40 },
    hints: ['Drag between anchors to build. Triangles resist collapse — a bare rectangle will lean.'],
    props: [
      { type: 'pine', x: 3 }, { type: 'pine', x: 8 }, { type: 'tree', x: 13, scale: 1.1 },
      { type: 'rock', x: 24 }, { type: 'sign', x: 25 }, { type: 'rock', x: 42 },
    ],
  },

  // ------------------------------------------------------------------ 2 --
  // intended solution: a braced timber wall across the 3.5 m sill
  // A(33,4.6)-B(36.5,4.6), 4 rows to a crest of 7.4 m: 16 members, about $520. Steel is unlocked but not needed.
  // difficulty note: deeper water than 1 and a wider sill, so an UNBRACED
  // rectangle should visibly rack before it seals. Still naive-winnable by
  // design — bracing is the lesson, not material choice.
  {
    id: 'level-02',
    name: 'Rising Current',
    subtitle: 'Wider water needs braced triangles, not just posts.',
    mode: 'freebuild',
    terrain: [
      [0, 11], [6, 9], [12, 7], [17, 5.2], [21, 4], [27, 4], [30, 4.3],
      [33, 4.6], [36.5, 4.6], [39, 2.8], [45, 1], [54, -0.5], [68, -2],
    ],
    anchors: [[33, 4.6], [36.5, 4.6]],
    buildZone: { x0: 31, x1: 37 },
    water: {
      initial: [{ x0: 21, x1: 27, surface: 4.3 }],
      flood: { x: 2, rate: 2.2, duration: 28, delay: 0 },
    },
    budget: 720,
    materials: ['timber', 'steel'],
    objective: { type: 'retain', minRetention: 0.75, duration: 45 },
    hints: [
      'Diagonals stop the wall from racking sideways.',
      'Triangulate every bay — steel is available if timber alone won\'t hold.',
    ],
    props: [
      { type: 'pine', x: 3 }, { type: 'pine', x: 9 }, { type: 'tree', x: 14, scale: 1.05 },
      { type: 'rock', x: 29 }, { type: 'sign', x: 30 }, { type: 'rock', x: 55 },
    ],
  },

  // ------------------------------------------------------------------ 3 --
  // intended solution: the sill A(40,4.2)-B(49,4.2) is 9 m long — wider than
  // ANY sealing material can span in one piece (steel maxes at 7 m, timber 5,
  // concrete 3). Found an extra column on the channel bed near x=44.5, which
  // splits it into two ~4.5 m bays that steel rungs can cross. Concrete
  // verticals take the compression of 6 m of water, steel rungs + diagonals
  // take the bending. ~43 members, roughly $7,900.
  // difficulty note: the first level that cannot be solved by a wall on the
  // anchors alone. Retention is 92%, so a face with gaps in it fails even if
  // nothing breaks. Fable: check the mid-channel pier reads as intentional.
  {
    id: 'level-03',
    name: 'Under Pressure',
    subtitle: 'Deep water, and a sill too long to span in one piece.',
    mode: 'freebuild',
    terrain: [
      [0, 14], [7, 11], [14, 8], [20, 5.5], [25, 3], [34, 3], [38, 3.2],
      [40, 4.2], [44, 3.0], [49, 4.2], [52, 2], [60, -1], [75, -3],
    ],
    anchors: [[40, 4.2], [49, 4.2]],
    buildZone: { x0: 38, x1: 50 },
    water: {
      initial: [{ x0: 25, x1: 34, surface: 3.6 }],
      flood: { x: 2, rate: 7.04, duration: 30, delay: 0 },
    },
    budget: 10970,
    materials: ['timber', 'steel', 'concrete'],
    objective: { type: 'retain', minRetention: 0.92, duration: 45 },
    hints: [
      'Nothing you own can span this sill in one piece — put a column down on the channel bed.',
      'Concrete carries huge compression: stack it for the columns, brace with steel.',
    ],
    props: [
      { type: 'pine', x: 8 }, { type: 'pine', x: 15, scale: 1.1 },
      { type: 'rock', x: 36 }, { type: 'sign', x: 37 }, { type: 'rock', x: 54 },
    ],
  },

  // ------------------------------------------------------------------ 4 --
  // intended solution: the banks A(30,4.6) and B(41,3.4) are 11 m apart and sit
  // at DIFFERENT heights, on a sill that slopes away downstream. Two columns
  // founded on the sill (x=33.7, x=37.3) split the crossing into three ~3.7 m
  // bays; concrete verticals, steel rungs and diagonals, cable corner ties.
  // 31 members, about $6,280.
  // difficulty note: the naive flat-crested wall puts one column on each bank
  // and tries to rung 11 m straight across — every rung and every diagonal is
  // refused (nothing reaches past steel's 7 m), so it fails with an open face.
  // The lesson is "foundations go where the ground is, not where the anchors
  // are". Note the sill deliberately does NOT dip: a hollow between the banks
  // would pond water that still counts as retained, and a single post on the
  // downstream lip would win the level by accident.
  {
    id: 'level-04',
    name: 'Poor Ground',
    subtitle: "The straight line doesn't reach. Stand columns in between.",
    mode: 'freebuild',
    terrain: [
      [0, 10], [6, 8], [12, 6], [17, 4.5], [21, 3.6], [26, 3.6], [30, 4.6],
      [34, 4.2], [37, 3.9], [41, 3.4], [44, 1.5], [52, -0.5], [68, -2.5],
    ],
    anchors: [[30, 4.6], [41, 3.4]],
    buildZone: { x0: 28, x1: 42 },
    water: {
      initial: [{ x0: 21, x1: 26, surface: 3.9 }],
      flood: { x: 2, rate: 3.55, duration: 26, delay: 0 },
    },
    budget: 9110,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.85, duration: 45 },
    hints: [
      'The gap between the banks is too wide for anything that can also hold water.',
      'Stand two columns on the sill between them, then rung across the short bays.',
    ],
    props: [
      { type: 'pine', x: 3 }, { type: 'pine', x: 9, scale: 1.1 }, { type: 'tree', x: 15 },
      { type: 'rock', x: 24 }, { type: 'sign', x: 26 }, { type: 'rock', x: 45 },
    ],
  },

  // ------------------------------------------------------------------ 5 --
  // intended solution: an 8 m sill A(32,3.6)-B(40,3.8) needing one pier on the
  // bed near x=36, built in STEEL THROUGHOUT (crest 7.4 m, ~$5,550) because
  // what arrives is not a rising pond but 120 m2 of water off the ledge at
  // x=3-10 in six seconds. Timber bracing splits under that impact.
  // difficulty note: the whole point is the contrast, and it is measured —
  // the same geometry in timber breaks (2 members unbraced, 17 braced) while
  // the steel version takes 18% load and holds. In freebuild the flood clock
  // starts at RELEASE, so the delay is just a short beat before the pulse
  // drops off the ledge. tests/levels-winnable.mjs asserts both sides.
  // (Countdown mode is PARKED per user decision — `countdown` kept for when
  // timed play returns; the old tuning was delay 30 against a 35 s timer.)
  {
    id: 'level-05',
    name: 'The Wave',
    subtitle: 'A reservoir waits on the ledge above. It falls when you say so.',
    mode: 'freebuild',
    terrain: [
      [0, 15], [3, 12], [10, 12], [13, 11], [16, 3], [20, 2.8], [26, 2.8],
      [29, 3.2], [32, 3.6], [36, 2.9], [40, 3.8], [43, 2], [52, -0.5], [65, -2.5],
    ],
    anchors: [[32, 3.6], [40, 3.8]],
    buildZone: { x0: 30, x1: 41 },
    water: {
      initial: [],
      // rate 28 (was 20 under countdown): a wave meeting a standing dam piles
      // up more gently than one that met a wall appearing mid-flow, so the
      // pulse is fatter to keep the timber-breaks/steel-holds contrast.
      flood: { x: 5, rate: 28, duration: 6, delay: 2 },
    },
    budget: 7710,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.8, duration: 45 },
    hints: [
      'The moment you release, that pond drops off the ledge — build for the impact, not just the depth.',
      'A sudden impact is not the same as deep water. Steel takes a hit; timber splits.',
    ],
    props: [
      { type: 'pine', x: 4 }, { type: 'pine', x: 9, scale: 1.1 }, { type: 'rock', x: 14 },
      { type: 'tree', x: 18 }, { type: 'sign', x: 29 }, { type: 'rock', x: 46 },
    ],
  },

  // ------------------------------------------------------------------ 6 --
  // intended solution: two 8 m sills, A(38,4.0)-B(46,4.0)-C(54,4.0), so two
  // piers on the bed (x=42, x=50) split them into four ~4 m bays. The money
  // lesson: steel rungs across the bays, but CABLE for the diagonals — the
  // diagonal only ever pulls, and cable buys ~2.6x the tensile strength per
  // dollar. Roughly $3,600 against a deliberately tight budget.
  // difficulty note: budget is only ~1.19x the intended solution, so reflexively
  // X-bracing everything in steel runs out of money before the crossing is
  // closed. This is the only level tuned on cost rather than geometry.
  {
    id: 'level-06',
    name: 'Broad Water',
    subtitle: 'A long, flat crossing on a short budget.',
    mode: 'freebuild',
    terrain: [
      [0, 9], [7, 7], [14, 5], [19, 4], [23, 3.5], [30, 3.5], [34, 3.7],
      [38, 4.0], [42, 3.3], [46, 4.0], [50, 3.3], [54, 4.0], [58, 2],
      [68, -0.5], [85, -2.5],
    ],
    anchors: [[38, 4.0], [46, 4.0], [54, 4.0]],
    buildZone: { x0: 36, x1: 55 },
    water: {
      initial: [{ x0: 23, x1: 30, surface: 4.0 }],
      flood: { x: 2, rate: 4.53, duration: 33, delay: 0 },
    },
    budget: 7380,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.95, duration: 45 },
    hints: [
      'Two long sills, two piers. Steel for the rungs — it is the only thing that reaches.',
      'A diagonal only ever pulls. Cable pulls for a fraction of steel\'s price.',
    ],
    props: [
      { type: 'pine', x: 8 }, { type: 'pine', x: 15 }, { type: 'tree', x: 20, scale: 1.1 },
      { type: 'rock', x: 33 }, { type: 'sign', x: 35 }, { type: 'rock', x: 60 },
    ],
  },

  // ------------------------------------------------------------------ 7 --
  // intended solution: the valley steps up halfway across. The cheap answer is
  // the UPPER bench C(38,6.2)-D(41,6.2) — only a 3 m sill and 2.4 m of height
  // is needed there, about $340 of timber, because the bench is already most
  // of the way up. The lower sill A(31,4.6)-B(34,4.6) also works but costs
  // roughly double for the same result.
  // difficulty note: naive-winnable ON PURPOSE, like 1 and 2 — a braced wall
  // on either pair of anchors seals. The lesson is reading the terrain for the
  // cheaper option, which the budget rewards but does not force.
  {
    id: 'level-07',
    name: 'Two Steps',
    subtitle: 'The ground steps up halfway across. Use it.',
    mode: 'freebuild',
    terrain: [
      [0, 11], [6, 9], [12, 7], [16, 5.5], [20, 4], [25, 4], [28, 4.3],
      [31, 4.6], [34, 4.6], [35, 6.2], [38, 6.2], [41, 6.2], [44, 4],
      [52, 1], [62, -1], [78, -3],
    ],
    anchors: [[31, 4.6], [34, 4.6], [38, 6.2], [41, 6.2]],
    buildZone: { x0: 29, x1: 42 },
    water: {
      initial: [{ x0: 20, x1: 25, surface: 4.3 }],
      flood: { x: 2, rate: 3.78, duration: 27, delay: 0 },
    },
    budget: 480,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.85, duration: 45 },
    hints: [
      "The ledge partway up isn't just scenery — a wall started there needs far less height.",
      'Anchors sit at two elevations: build from whichever gives you the cheaper wall.',
    ],
    props: [
      { type: 'pine', x: 4 }, { type: 'pine', x: 10 }, { type: 'tree', x: 16, scale: 1.1 },
      { type: 'rock', x: 27 }, { type: 'sign', x: 28 }, { type: 'rock', x: 47 },
    ],
  },

  // ------------------------------------------------------------------ 8 --
  // intended solution: the same pier-on-the-bed shape as 3 and 6 — an 8 m sill
  // A(33,4.6)-B(41,4.8) with one column at x=37 — but there are only 16
  // seconds before the flood arrives, so it must be built in one confident
  // pass: timber verticals, steel rungs, steel diagonals. Roughly $3,940.
  // difficulty note: heavy and nearly immediate flood (starts at t=3s) with a
  // 85% retention target, so there is no room for a leaking face. (Countdown
  // PARKED: this was tuned as a 16 s build timer — when timed play returns,
  // confirm ~14 members is placeable in 16 s by a player who knows the shape.)
  {
    id: 'level-08',
    name: 'Flash Flood',
    subtitle: 'A violent flood, all at once. Your wall meets it head on.',
    mode: 'freebuild', // countdown PARKED; was a 16 s timer
    terrain: [
      [0, 12], [6, 10], [12, 7.5], [17, 5.5], [21, 4], [27, 4], [30, 4.3],
      [33, 4.6], [37, 3.9], [41, 4.8], [44, 2.5], [54, 0], [68, -2.5],
    ],
    anchors: [[33, 4.6], [41, 4.8]],
    buildZone: { x0: 31, x1: 42 },
    water: {
      initial: [],
      flood: { x: 2, rate: 9.09, duration: 11, delay: 2 },
    },
    budget: 5470,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.85, duration: 40 },
    hints: [
      'You know this shape by now: pier on the bed, rungs across, brace it.',
      'Build the face watertight, then brace it — this flood punishes every gap.',
    ],
    props: [
      { type: 'pine', x: 3 }, { type: 'pine', x: 9 },
      { type: 'rock', x: 29 }, { type: 'sign', x: 30 }, { type: 'rock', x: 46 },
    ],
  },

  // ------------------------------------------------------------------ 9 --
  // intended solution: an 8 m sill A(35,4.7)-B(43,4.9) with one pier at x=39,
  // built only to a MODEST crest (~7.2 m, roughly $1,880). The level is won by
  // letting the reservoir overtop deliberately into the natural notch at
  // x=45-52 (floor ~1.2 m) instead of trying to hold everything: the notch
  // swallows the spill, and the ridge at x=54 keeps it out of the village at
  // x=58-68.
  // difficulty note: objective is `protect`, not `retain`, so height is
  // actively punished — build too tall and the reservoir tops the ridge in one
  // sheet instead of trickling into the notch. Naive walls fail because their
  // open face dumps water straight down the channel and floods the village.
  {
    id: 'level-09',
    name: 'Spillway',
    subtitle: 'Let the river have a little. Save the village.',
    mode: 'freebuild',
    terrain: [
      [0, 13], [8, 9], [16, 5], [22, 4], [28, 4], [32, 4.4], [35, 4.7],
      [39, 4.1], [43, 4.9], [45, 1.4], [50, 1.2], [54, 3.3], [58, 2.0],
      [68, 1.8], [78, -1.5], [95, -3.5],
    ],
    anchors: [[35, 4.7], [43, 4.9]],
    buildZone: { x0: 33, x1: 44 },
    water: {
      initial: [],
      flood: { x: 2, rate: 4.5, duration: 25, delay: 0 },
    },
    budget: 2540,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'protect', x0: 58, x1: 68, maxDepth: 0.3, duration: 50 },
    hints: [
      "You don't need to hold every drop — the notch just downstream can take the overflow.",
      'Build to a sensible height, not the tallest one you can afford.',
    ],
    props: [
      { type: 'pine', x: 8 }, { type: 'pine', x: 16, scale: 1.1 },
      { type: 'rock', x: 31 }, { type: 'sign', x: 32 }, { type: 'rock', x: 48 },
      { type: 'tree', x: 55 }, { type: 'house', x: 60 }, { type: 'house', x: 63, scale: 0.9 },
      { type: 'house', x: 66 },
    ],
  },

  // ----------------------------------------------------------------- 10 --
  // intended solution: everything at once. Two 8 m sills
  // A(55,6.0)-B(63,6.2)-C(71,6.4) needing two piers on the bed (x=59, x=67),
  // concrete verticals for 7 m of water, steel rungs and diagonals across four
  // ~4 m bays, and cable ties from each outer base to the opposite crest so
  // the whole dam cannot rack as one piece. Crest around 12.8 m. Roughly
  // $16,000 against a $22,000 budget.
  // difficulty note: deepest reservoir in the game. 93%
  // retention means the face has to be genuinely watertight, not merely
  // standing. Fable: this is the level to tune LAST — everything before it
  // teaches one piece of this dam.
  {
    id: 'level-10',
    name: 'The Big One',
    subtitle: "Everything you've learned, at full scale.",
    mode: 'freebuild', // countdown PARKED; was a 38 s timer
    terrain: [
      [0, 20], [10, 16], [20, 12], [28, 8], [34, 5], [44, 5], [50, 5.5],
      [55, 6.0], [59, 5.2], [63, 6.2], [67, 5.4], [71, 6.4], [75, 3],
      [88, 0], [110, -4],
    ],
    anchors: [[55, 6.0], [63, 6.2], [71, 6.4]],
    buildZone: { x0: 53, x1: 72 },
    water: {
      initial: [],
      flood: { x: 2, rate: 6.68, duration: 55, delay: 3 },
    },
    budget: 22560,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'retain', minRetention: 0.88, duration: 60 },
    hints: [
      'Two sills, two piers, concrete columns, steel bracing — everything you have learned.',
      'Tie the outer columns to the opposite crest with cable so the dam cannot rack.',
    ],
    props: [
      { type: 'pine', x: 12 }, { type: 'pine', x: 22 }, { type: 'pine', x: 30, scale: 1.1 },
      { type: 'rock', x: 50 }, { type: 'sign', x: 51 }, { type: 'rock', x: 76 },
      { type: 'pine', x: 88 },
    ],
  },

  // ----------------------------------------------------------------- 11 --
  // intended solution: none — sandbox. Budget and materials are effectively
  // unlimited and the flood never really stops; the point is free play.
  // difficulty note: n/a. Deliberately survivable with nothing built.
  {
    id: 'sandbox',
    name: 'Sandbox',
    subtitle: 'No rules. No budget limit. Just water.',
    mode: 'freebuild',
    terrain: [
      [0, 18], [20, 12], [38, 6], [55, 4], [70, 4], [85, 4.3], [100, 2],
      [120, -1], [145, -4],
    ],
    anchors: [[58, 4], [63, 4], [68, 4], [73, 4.2]],
    buildZone: null,
    water: {
      initial: [{ x0: 0, x1: 20, surface: 14 }],
      flood: { x: 5, rate: 12, duration: 1000, delay: 0 },
    },
    budget: 120000,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    objective: { type: 'survive', duration: 120 },
    hints: [],
    props: [
      { type: 'pine', x: 5 }, { type: 'pine', x: 25 }, { type: 'tree', x: 40 },
      { type: 'rock', x: 50 }, { type: 'sign', x: 56 }, { type: 'rock', x: 80 },
      { type: 'house', x: 110 },
    ],
  },
];
