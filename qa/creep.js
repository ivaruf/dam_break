// QA scenario: sustained-load creep repro (page context via tools/drive.mjs).
// Build a SEALED single-material truss on a deep level, dial the crest so the
// face sits high-but-under-limit, release, and watch damage grow over time.
// Params: QA_LEVEL (default 3), QA_MAT ('timber'), QA_CREST, QA_DY,
// QA_WATCH_TO (sim s before slow-mo + screenshot; 0 = run to result).
const LEVEL = window.QA_LEVEL || 3;
const MAT = window.QA_MAT || 'timber';
const CREST = window.QA_CREST || 8.4;
const DY = window.QA_DY || 0.9;
const WATCH_TO = window.QA_WATCH_TO ?? 0;

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
const M = (a, b) => S.design.members.push({ id: 'qmm' + (++uid), a, b, mat: MAT });

// columns: anchors + ground-founded intermediates every ~4 m, engineered-style
const as = [...S.terrain.anchors].sort((p, q) => p.x - q.x);
const xs = [];
for (let i = 0; i < as.length; i++) {
  xs.push({ x: as[i].x, aid: as[i].id });
  if (i + 1 < as.length) {
    const gap = as[i + 1].x - as[i].x;
    const extra = Math.max(0, Math.ceil(gap / 4.0) - 1);
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
  for (let k = 1; k <= subs; k++) { const n = N(c.x, Math.min(base, bases[ci] + k * DY)); M(prev, n); prev = n; }
  const nodes = [prev];
  for (let r = 1; r <= rows; r++) { const n = N(c.x, base + r * DY); M(prev, n); prev = n; nodes[r] = n; }
  return nodes;
});
for (let r = 1; r <= rows; r++) for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r]);
for (let r = 0; r < rows; r++) for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r + 1]);

game.release();
game.setSpeed(4);

// sample the stress story: max load, max damage, broken count over time
const samples = [];
const t0 = performance.now();
while (game.getScene().phase === 'sim' && performance.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 300));
  const s = game.getScene();
  const st = s.structure;
  if (st) {
    let maxDmg = 0, maxLoad = 0, creeping = 0;
    for (const m of st.members) {
      if (m.broken) continue;
      if (m.damage > maxDmg) maxDmg = m.damage;
      if (m.load > maxLoad) maxLoad = m.load;
      if (m.damage > 0.02 && m.load < 1) creeping++;
    }
    samples.push({ t: +s.simTime.toFixed(1), maxLoad: +maxLoad.toFixed(2), maxDmg: +maxDmg.toFixed(2), creeping, broken: st.brokenCount });
  }
  if (WATCH_TO > 0 && s.simTime >= WATCH_TO) { game.setSpeed(0.25); break; }
}

const S2 = game.getScene();
const ff = S2.structure && S2.structure.firstFailure;
return {
  mat: MAT, crest: CREST, endPhase: S2.phase, simTime: +S2.simTime.toFixed(1),
  broken: S2.structure ? S2.structure.brokenCount : -1,
  firstFailure: ff ? { mode: ff.mode, sustained: !!ff.sustained, t: +ff.time.toFixed(1) } : null,
  win: S2.stats ? S2.stats.win : null,
  cause: S2.stats ? S2.stats.cause : null,
  timeline: samples.filter((_, i) => i % 4 === 0 || i === samples.length - 1),
};
