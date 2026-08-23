// QA scenario: load LEVEL, build WALL ('strong'|'weak'|'none'), release, run
// the sim for WATCH seconds at SPEED, and leave the game mid-sim so the driver
// screenshot catches the action. Returns a compact status.
const LEVEL = window.QA_LEVEL || 3;
const WALL = window.QA_WALL || 'strong';
const WATCH = window.QA_WATCH || 8;
const SPEED = window.QA_SPEED || 1;

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
const nearestAnchor = (x) => {
  let best = null, bd = 1e9;
  for (const a of S.terrain.anchors) {
    const d = Math.abs(a.x - x);
    if (d < bd) { bd = d; best = a; }
  }
  return best && bd < 1.0 ? best.id : null;
};

const as = [...S.terrain.anchors].sort((p, q) => p.x - q.x);
const x = as[Math.floor(as.length / 2)].x;
const g = (xx) => S.terrain.heightAt(xx);
const H = window.QA_HEIGHT || 5;
const mats = S.level.materials;
const face = WALL === 'strong' && mats.includes('concrete') ? 'concrete' : mats[0];
const brace = WALL === 'strong' && mats.includes('steel') ? 'steel' : mats[0];

if (WALL !== 'none') {
  const rows = [];
  for (let y = g(x); y <= g(x) + H + 0.01; y += 1.5) rows.push(y);
  const faceIds = rows.map((y, i) => N(x, y, i === 0 ? nearestAnchor(x) : null));
  for (let i = 1; i < faceIds.length; i++) M(faceIds[i - 1], faceIds[i], face);
  if (WALL === 'strong') {
    const bx = x + 2.2;
    const backIds = rows.slice(0, -1).map((y, i) => N(bx, y, i === 0 ? nearestAnchor(bx) : null));
    for (let i = 1; i < backIds.length; i++) M(backIds[i - 1], backIds[i], brace);
    M(faceIds[0], backIds[0], face);
    for (let i = 0; i < backIds.length; i++) {
      M(faceIds[i], backIds[i], brace);
      if (i + 1 < faceIds.length) M(backIds[i], faceIds[i + 1], brace);
      if (i + 1 < backIds.length) M(faceIds[i], backIds[i + 1], brace);
    }
  }
}

game.release();
game.setSpeed(SPEED);
await new Promise((r) => setTimeout(r, WATCH * 1000));

const st = S.structure;
return {
  level: S.level.id, wall: WALL, phase: S.phase,
  simTime: +S.simTime.toFixed(1),
  broken: st ? st.brokenCount : -1,
  maxLoad: st ? +st.maxLoad.toFixed(2) : -1,
  stats: S.stats,
};
