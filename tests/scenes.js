// OPUS A owns. Node-only physics test scenes 1-8, plus level-spec plumbing.
// DOM-free: testLevel(i) must work standalone (also loaded by the browser via
// game.loadTestScene(i)). Level shape: ARCHITECTURE.md §8, plus isTest:true and
// testDesign {nodes, members} for scenes that need a prebuilt structure.
//
// Every tunable number lives in P below so Opus A can retune without hunting
// through the builders.

const P = {
  scene1: {
    terrain: [[0, 0], [20, 0]],
    beamA: [9, 5],
    beamB: [11, 5],
    survive: 5,
  },
  scene2: {
    terrain: [[0, 0], [24, 0]],
    t0: [4, 0], t1: [8, 0], t2y: 3.5,
    s0: [14, 0], s1: [18, 0], s2y: 3.5,
    survive: 6,
  },
  scene3: {
    terrain: [[0, 0], [60, 0]],
    wallX: 24, wallHeight: 4, wallWidth: 1, wallSpacing: 1, wallMat: 'timber',
    waterX0: 0, waterX1: 23, waterSurface: 1.5,
    survive: 20,
  },
  scene4: {
    terrain: [[0, 0], [60, 0]],
    wallX: 24, wallHeight: 9, wallSpacing: 1,
    weakWidth: 1, weakMat: 'timber',
    // 2 m keeps every concrete member (rung 2 m, diagonal 2.24 m) inside
    // MATERIALS.concrete.maxLength = 3 m, so the scene is buildable in-game.
    strongWidth: 2, strongMat: 'concrete',
    waterX0: 0, waterX1: 23, waterSurface: 8,
    survive: 15,
  },
  scene5: {
    terrain: [[0, 0], [60, 0]],
    wallX: 24, wallHeight: 6, wallWidth: 1, wallSpacing: 1, wallMat: 'concrete',
    waterX0: 0, waterX1: 23, waterSurface: 5,
    // two bays out: concrete is 0.85 m thick, so removing a single 1 m bay
    // leaves only a ~0.15 m slot. Two bays gives an unmistakable ~1.2 m hole.
    holeY0: 2.2, holeY1: 4.3,
    damX: 24, upstream: [0, 23], downstream: [25, 60],
    survive: 20,
  },
  scene6: {
    terrain: [[0, 12], [10, 12], [14, 0], [60, 0]],
    // width 1.2 makes the wall one that only just holds the calm pond, so the
    // extra load the moving front brings is what decides it
    wallX: 30, wallHeight: 6, wallWidth: 1.2, wallSpacing: 1, wallMat: 'timber',
    pondX0: 14, pondX1: 29, pondSurface: 4,
    plateauX0: 0, plateauX1: 10, plateauY: 12,
    damX: 30, upstream: [14, 29], downstream: [31, 60],
    survive: 20,
  },
  scene7: {
    terrain: [[0, 0], [60, 0]],
    wallX: 24, wallHeight: 3, wallWidth: 2, wallSpacing: 1, wallMat: 'concrete',
    waterX0: 0, waterX1: 23, waterSurface: 1,
    floodX: 2, floodRate: 6, floodDuration: 60, floodDelay: 0,
    damX: 24, upstream: [0, 23], downstream: [25, 60],
    survive: 30,
  },
  scene8: {
    terrain: [[0, 0], [60, 0]],
    // over-tall, coarsely braced timber: the base bays go first, then the load
    // walks up the wall over the next second or two
    wallX: 24, wallHeight: 11, wallWidth: 3, wallSpacing: 1.5, wallMat: 'timber',
    waterX0: 0, waterX1: 23, waterSurface: 10,
    damX: 24, upstream: [0, 23], downstream: [25, 60],
    survive: 30,
  },
};

// Shared level-spec defaults. Every scene overrides terrain/testDesign/water/
// objective/testMeta as needed.
function baseLevel(fields) {
  return {
    mode: 'freebuild',
    budget: 1e9,
    materials: ['timber', 'steel', 'concrete', 'cable'],
    buildZone: null,
    hints: [],
    isTest: true,
    water: {},
    ...fields,
  };
}

// Builds a vertical truss/wall centred on world x. width>0 gives two columns
// (x - width/2, x + width/2) tied by rungs and diagonals; width===0 gives a
// single column. Rows run base..base+height at `spacing`, last row snapped
// to exactly base+height. Bottom-row nodes get anchorId when anchorBase is
// true, in bookkeeping order so anchorPoints lines up with terrain anchor
// ids ('a0','a1',...); anchorIdOffset lets a caller with several structures
// shift the ids to match a concatenated anchors array.
// hole:{y0,y1} drops any member whose midpoint y falls in [y0,y1] — punches
// a real gap through the wall.
export function buildWall({
  x, base, height, width, mat, spacing = 1, braced = true,
  hole = null, anchorBase = true, idPrefix = 'w', anchorIdOffset = 0,
}) {
  const rows = [];
  let y = base;
  while (y < base + height - 1e-9) {
    rows.push(y);
    y += spacing;
  }
  rows.push(base + height);

  const hasTwoCols = width > 0;
  const xL = hasTwoCols ? x - width / 2 : x;
  const xR = hasTwoCols ? x + width / 2 : x;
  const cols = hasTwoCols ? ['L', 'R'] : ['C'];
  const colX = { L: xL, R: xR, C: xL };

  const nodes = [];
  const anchorPoints = [];
  let anchorCounter = 0;
  const grid = {};

  for (const col of cols) {
    grid[col] = [];
    for (let i = 0; i < rows.length; i++) {
      const nx = colX[col];
      const ny = rows[i];
      const isBottom = i === 0;
      const anchorId = (isBottom && anchorBase) ? `a${anchorIdOffset + anchorCounter++}` : null;
      if (isBottom && anchorBase) anchorPoints.push([nx, ny]);
      const node = { id: `${idPrefix}_${col}${i}`, x: nx, y: ny, anchorId };
      nodes.push(node);
      grid[col][i] = node;
    }
  }

  const members = [];
  const inHole = (ya, yb) => hole && (ya + yb) / 2 >= hole.y0 && (ya + yb) / 2 <= hole.y1;
  function addMember(id, a, b) {
    if (inHole(a.y, b.y)) return;
    members.push({ id, a: a.id, b: b.id, mat });
  }

  // verticals
  for (const col of cols) {
    for (let i = 0; i < rows.length - 1; i++) {
      addMember(`${idPrefix}_v${col}${i}`, grid[col][i], grid[col][i + 1]);
    }
  }
  // horizontal rungs
  if (hasTwoCols) {
    for (let i = 0; i < rows.length; i++) {
      addMember(`${idPrefix}_h${i}`, grid.L[i], grid.R[i]);
    }
  }
  // diagonals, alternating direction per bay
  if (hasTwoCols && braced) {
    for (let i = 0; i < rows.length - 1; i++) {
      if (i % 2 === 0) addMember(`${idPrefix}_d${i}`, grid.L[i], grid.R[i + 1]);
      else addMember(`${idPrefix}_d${i}`, grid.R[i], grid.L[i + 1]);
    }
  }

  const upstreamCol = hasTwoCols ? 'L' : 'C';
  const bottomMembers = rows.length >= 2 ? [`${idPrefix}_v${upstreamCol}0`] : [];
  const topMembers = rows.length >= 2 ? [`${idPrefix}_v${upstreamCol}${rows.length - 2}`] : [];

  return { nodes, members, anchorPoints, bottomMembers, topMembers };
}

function scene1Level() {
  const p = P.scene1;
  return baseLevel({
    id: 'test-1', name: 'Test 1: Gravity Beam', subtitle: 'A single beam falls under gravity.',
    terrain: p.terrain,
    anchors: [],
    testDesign: {
      nodes: [
        { id: 'n0', x: p.beamA[0], y: p.beamA[1], anchorId: null },
        { id: 'n1', x: p.beamB[0], y: p.beamB[1], anchorId: null },
      ],
      members: [{ id: 'm0', a: 'n0', b: 'n1', mat: 'timber' }],
    },
    water: {},
    objective: { type: 'survive', duration: p.survive },
  });
}

export const SCENE2 = { triangleTop: 'T2', frameTops: ['S2', 'S3'], anchoredIds: ['T0', 'T1', 'S0', 'S1'] };

function scene2Level() {
  const p = P.scene2;
  const nodes = [
    { id: 'T0', x: p.t0[0], y: p.t0[1], anchorId: 'a0' },
    { id: 'T1', x: p.t1[0], y: p.t1[1], anchorId: 'a1' },
    { id: 'T2', x: (p.t0[0] + p.t1[0]) / 2, y: p.t2y, anchorId: null },
    { id: 'S0', x: p.s0[0], y: p.s0[1], anchorId: 'a2' },
    { id: 'S1', x: p.s1[0], y: p.s1[1], anchorId: 'a3' },
    { id: 'S2', x: p.s0[0], y: p.s2y, anchorId: null },
    { id: 'S3', x: p.s1[0], y: p.s2y, anchorId: null },
  ];
  const members = [
    { id: 'T_a', a: 'T0', b: 'T2', mat: 'timber' },
    { id: 'T_b', a: 'T1', b: 'T2', mat: 'timber' },
    { id: 'T_c', a: 'T0', b: 'T1', mat: 'timber' },
    { id: 'S_a', a: 'S0', b: 'S2', mat: 'timber' },
    { id: 'S_b', a: 'S1', b: 'S3', mat: 'timber' },
    { id: 'S_c', a: 'S2', b: 'S3', mat: 'timber' },
    { id: 'S_d', a: 'S0', b: 'S1', mat: 'timber' },
  ];
  return baseLevel({
    id: 'test-2', name: 'Test 2: Truss vs Frame',
    subtitle: 'A braced triangle resists lateral push; an unbraced frame racks.',
    terrain: p.terrain,
    anchors: [p.t0, p.t1, p.s0, p.s1],
    testDesign: { nodes, members },
    water: {},
    objective: { type: 'survive', duration: p.survive },
  });
}

function scene3Level() {
  const p = P.scene3;
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width: p.wallWidth,
    mat: p.wallMat, spacing: p.wallSpacing, braced: true, idPrefix: 'w3',
  });
  return baseLevel({
    id: 'test-3', name: 'Test 3: Shallow Water', subtitle: 'A wall holds back a shallow pond.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: p.waterX0, x1: p.waterX1, surface: p.waterSurface }] },
    objective: { type: 'survive', duration: p.survive },
  });
}

function scene4Level(opts) {
  const p = P.scene4;
  const variant = opts.variant === 'strong' ? 'strong' : 'weak';
  const width = variant === 'strong' ? p.strongWidth : p.weakWidth;
  const mat = variant === 'strong' ? p.strongMat : p.weakMat;
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width,
    mat, spacing: p.wallSpacing, braced: true, idPrefix: 'w4',
  });
  return baseLevel({
    id: 'test-4', name: `Test 4: Deep Water (${variant})`,
    subtitle: 'A wall holds back deep water; load should concentrate at the base.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: p.waterX0, x1: p.waterX1, surface: p.waterSurface }] },
    objective: { type: 'survive', duration: p.survive },
    testMeta: { bottomMembers: wall.bottomMembers, topMembers: wall.topMembers },
  });
}

function scene5Level(opts) {
  const p = P.scene5;
  const variant = opts.variant === 'holed' ? 'holed' : 'sealed';
  const hole = variant === 'holed' ? { y0: p.holeY0, y1: p.holeY1 } : null;
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width: p.wallWidth,
    mat: p.wallMat, spacing: p.wallSpacing, braced: true, hole, idPrefix: 'w5',
  });
  return baseLevel({
    id: 'test-5', name: `Test 5: Hole In Dam (${variant})`,
    subtitle: 'A breach lets water through; a sealed wall should barely leak.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: p.waterX0, x1: p.waterX1, surface: p.waterSurface }] },
    objective: { type: 'survive', duration: p.survive },
    testMeta: { damX: p.damX, upstream: p.upstream, downstream: p.downstream },
  });
}

function scene6Level(opts) {
  const p = P.scene6;
  const variant = opts.variant === 'wave' ? 'wave' : 'static';
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width: p.wallWidth,
    mat: p.wallMat, spacing: p.wallSpacing, braced: true, idPrefix: 'w6',
  });
  const pondLen = p.pondX1 - p.pondX0;
  const plateauLen = p.plateauX1 - p.plateauX0;
  // Same total volume as the static pond: pond bed is flat at 0 over
  // [pondX0,pondX1], so pond volume = pondSurface * pondLen. Spread across
  // the flat plateau (bed = plateauY) of length plateauLen:
  //   plateauDepth * plateauLen == pondSurface * pondLen
  const plateauDepth = (p.pondSurface * pondLen) / plateauLen;
  const initial = variant === 'wave'
    ? [{ x0: p.plateauX0, x1: p.plateauX1, surface: p.plateauY + plateauDepth }]
    : [{ x0: p.pondX0, x1: p.pondX1, surface: p.pondSurface }];
  return baseLevel({
    id: 'test-6', name: `Test 6: Flood Wave (${variant})`,
    subtitle: 'A moving flood front should hit harder than a calm pond of equal volume.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial },
    objective: { type: 'survive', duration: p.survive },
    testMeta: { damX: p.damX, upstream: p.upstream, downstream: p.downstream },
  });
}

function scene7Level() {
  const p = P.scene7;
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width: p.wallWidth,
    mat: p.wallMat, spacing: p.wallSpacing, braced: true, idPrefix: 'w7',
  });
  return baseLevel({
    id: 'test-7', name: 'Test 7: Overtopping', subtitle: 'Rising water spills over the crest.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: {
      initial: [{ x0: p.waterX0, x1: p.waterX1, surface: p.waterSurface }],
      flood: { x: p.floodX, rate: p.floodRate, duration: p.floodDuration, delay: p.floodDelay },
    },
    objective: { type: 'survive', duration: p.survive },
    testMeta: { damX: p.damX, upstream: p.upstream, downstream: p.downstream },
  });
}

function scene8Level() {
  const p = P.scene8;
  const wall = buildWall({
    x: p.wallX, base: 0, height: p.wallHeight, width: p.wallWidth,
    mat: p.wallMat, spacing: p.wallSpacing, braced: true, idPrefix: 'w8',
  });
  return baseLevel({
    id: 'test-8', name: 'Test 8: Progressive Collapse',
    subtitle: 'A tall, thin, coarsely braced wall fails one member at a time.',
    terrain: p.terrain,
    anchors: wall.anchorPoints,
    testDesign: { nodes: wall.nodes, members: wall.members },
    water: { initial: [{ x0: p.waterX0, x1: p.waterX1, surface: p.waterSurface }] },
    objective: { type: 'survive', duration: p.survive },
    testMeta: { damX: p.damX, upstream: p.upstream, downstream: p.downstream },
  });
}

export function testLevel(i, opts = {}) {
  switch (i) {
    case 1: return scene1Level();
    case 2: return scene2Level();
    case 3: return scene3Level();
    case 4: return scene4Level(opts);
    case 5: return scene5Level(opts);
    case 6: return scene6Level(opts);
    case 7: return scene7Level();
    case 8: return scene8Level();
    default: throw new Error(`testLevel: unknown scene index ${i}`);
  }
}

export const SCENE_COUNT = 8;
export { P };
