// QA scenario (page context via tools/drive.mjs --eval).
// THE Definition-of-Done finale: build two visibly different dams, release the
// SAME flood against both, and require meaningfully different results.
//
// Dam A (weak): a single line of unbraced timber posts.
// Dam B (strong): concrete wall face + timber triangulation + anchored base.
const { game, emit } = window.DAM;

function clearDesign(S) {
  S.design.nodes.length = 0;
  S.design.members.length = 0;
}

function damSite(S) {
  // build across the middle anchors of the level
  const as = [...S.terrain.anchors].sort((p, q) => p.x - q.x);
  const mid = as[Math.floor(as.length / 2)];
  return { as, x: mid.x, ground: S.terrain.heightAt(mid.x) };
}

let uid = 0;
const N = (S, x, y, anchorId = null) => {
  const id = 'qn' + (++uid);
  S.design.nodes.push({ id, x, y, anchorId });
  return id;
};
const M = (S, a, b, mat) => S.design.members.push({ id: 'qmm' + (++uid), a, b, mat });

function buildWeak(S, h) {
  const { x, ground } = damSite(S);
  // lone timber posts stacked into a tall unbraced wall
  let prev = N(S, x, ground, nearestAnchor(S, x));
  for (let y = ground + 1.5; y <= ground + h; y += 1.5) {
    const n = N(S, x, y);
    M(S, prev, n, 'timber');
    prev = n;
  }
}

function nearestAnchor(S, x) {
  let best = null, bd = 1e9;
  for (const a of S.terrain.anchors) {
    const d = Math.abs(a.x - x);
    if (d < bd) { bd = d; best = a; }
  }
  return best && bd < 1.0 ? best.id : null;
}

function buildStrong(S, h) {
  const { as } = damSite(S);
  const mats = S.level.materials;
  const face = mats.includes('concrete') ? 'concrete' : mats[0];
  const brace = mats.includes('steel') ? 'steel' : mats[0];
  const x = as[Math.floor(as.length / 2)].x;
  const g = (xx) => S.terrain.heightAt(xx);

  // vertical face in short segments + rear support column + triangulated bracing
  const rows = [];
  const step = 1.5;
  for (let y = g(x); y <= g(x) + h + 0.01; y += step) rows.push(y);
  const faceIds = rows.map((y, i) => N(S, x, y, i === 0 ? nearestAnchor(S, x) : null));
  for (let i = 1; i < faceIds.length; i++) M(S, faceIds[i - 1], faceIds[i], face);

  const bx = x + 2.2;
  const backIds = rows.slice(0, -1).map((y, i) => N(S, bx, y, i === 0 ? nearestAnchor(S, bx) : null));
  for (let i = 1; i < backIds.length; i++) M(S, backIds[i - 1], backIds[i], brace);
  M(S, faceIds[0], backIds[0], face); // base tie
  for (let i = 0; i < backIds.length; i++) {
    M(S, faceIds[i], backIds[i], brace);                      // horizontal ties
    if (i + 1 < faceIds.length) M(S, backIds[i], faceIds[i + 1], brace); // diagonals
    if (i + 1 < backIds.length) M(S, faceIds[i], backIds[i + 1], brace); // counter-diagonals
  }
}

async function runSim(maxSeconds) {
  game.release();
  game.setSpeed(4);
  const t0 = performance.now();
  while (game.getScene().phase === 'sim' && performance.now() - t0 < maxSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const S = game.getScene();
  const st = S.structure;
  return {
    endPhase: S.phase,
    simTime: +S.simTime.toFixed(1),
    broken: st ? st.brokenCount : -1,
    maxLoad: st ? +st.maxLoad.toFixed(2) : -1,
    firstFailure: st && st.firstFailure ? st.firstFailure.mode + '@' + st.firstFailure.time.toFixed(1) + 's' : null,
    stats: S.stats,
  };
}

const H = 5; // dam height above ground (m)

emit('ui:level', { index: 1 });
await new Promise((r) => setTimeout(r, 400));
let S = game.getScene();
clearDesign(S);
buildWeak(S, H);
const weak = await runSim(50);

emit('ui:level', { index: 1 });
await new Promise((r) => setTimeout(r, 400));
S = game.getScene();
clearDesign(S);
buildStrong(S, H);
const strong = await runSim(50);

return {
  weak, strong,
  verdict: {
    weakBrokeMore: weak.broken > strong.broken,
    differentOutcome: weak.broken !== strong.broken || (weak.stats && strong.stats && weak.stats.win !== strong.stats.win),
  },
};
