// QA scenario: steady OVERTOPPING over an intact dam (the "white cloud" repro).
// Level 3 (deep reservoir): a strong sealed truss built deliberately short, so
// the reservoir rises over the crest and pours down the face while the dam
// itself stays intact — the worst case for dam/stress readability.
const LEVEL = window.QA_LEVEL || 3;
const CREST = window.QA_CREST || 7.4;   // below the level's fill target -> weir flow
const DY = window.QA_DY || 0.9;
const WATCH_TO = window.QA_WATCH_TO || 55; // sim seconds before slow-mo + shot

const { game, emit } = window.DAM;
emit('ui:level', { index: LEVEL });
await new Promise((r) => setTimeout(r, 400));
const S = game.getScene();
S.design.nodes.length = 0;
S.design.members.length = 0;

let uid = 0;
const N = (x, y, anchorId = null) => {
  const id = 'qn' + (++uid);
  S.design.nodes.push({ id, x, y, anchorId });
  return id;
};
const M = (a, b, mat) => S.design.members.push({ id: 'qmm' + (++uid), a, b, mat });

const as = [...S.terrain.anchors].sort((p, q) => p.x - q.x);
const xs = [];
for (let i = 0; i < as.length; i++) {
  xs.push({ x: as[i].x, aid: as[i].id });
  if (i + 1 < as.length) {
    const gap = as[i + 1].x - as[i].x;
    const extra = Math.max(0, Math.ceil(gap / 4.5) - 1);
    for (let k = 1; k <= extra; k++) xs.push({ x: as[i].x + (gap * k) / (extra + 1), aid: null });
  }
}
xs.sort((p, q) => p.x - q.x);

const bases = xs.map((c) => S.terrain.heightAt(c.x));
const base = Math.max(...bases);
const rows = Math.max(1, Math.ceil((CREST - base) / DY));
const grid = xs.map((c, ci) => {
  let prev = N(c.x, bases[ci], c.aid);
  const subs = Math.max(0, Math.ceil((base - bases[ci]) / DY - 1e-6));
  for (let k = 1; k <= subs; k++) {
    const n = N(c.x, Math.min(base, bases[ci] + k * DY));
    M(prev, n, 'concrete');
    prev = n;
  }
  const nodes = [prev];
  for (let r = 1; r <= rows; r++) {
    const n = N(c.x, base + r * DY);
    M(prev, n, 'concrete');
    prev = n;
    nodes[r] = n;
  }
  return nodes;
});
for (let r = 1; r <= rows; r++) {
  for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r], 'steel');
}
for (let r = 0; r < rows; r++) {
  for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r + 1], 'steel');
}

game.release();
game.setSpeed(4);
const t0 = performance.now();
while (game.getScene().phase === 'sim' && game.getScene().simTime < WATCH_TO &&
       performance.now() - t0 < 90000) {
  await new Promise((r) => setTimeout(r, 200));
}
game.setSpeed(0.5); // slow so the driver screenshot catches mid-pour

const st = game.getScene().structure;
return {
  level: S.level.id, simTime: +game.getScene().simTime.toFixed(1), phase: game.getScene().phase,
  broken: st ? st.brokenCount : -1, maxLoad: st ? +st.maxLoad.toFixed(2) : -1,
};
