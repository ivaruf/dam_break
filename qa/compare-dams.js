// QA acceptance (page context via tools/drive.mjs --eval).
// Definition-of-done finale on level 5 (The Wave): the SAME full-span braced
// wall geometry, built in timber vs steel, against the SAME falling flood —
// the results must differ meaningfully (timber splits, steel takes the hit).
//
// window.QA_SHOTMODE: run only the timber wall at 2x and stop shortly after
// the wave lands, so the driver screenshot catches the impact.
const LEVEL = window.QA_LEVEL || 5;
const CREST = window.QA_CREST || 7.4;
const DY = window.QA_DY || 0.9;
const SHOT = !!window.QA_SHOTMODE;

const { game, emit } = window.DAM;

let uid = 0;
function buildWall(S, mat, style) { // 'posts' | 'frame' | 'truss'
  S.design.nodes.length = 0;
  S.design.members.length = 0;
  const N = (x, y, anchorId = null) => {
    const id = 'qn' + (++uid);
    S.design.nodes.push({ id, x, y, anchorId });
    return id;
  };
  const M = (a, b) => S.design.members.push({ id: 'qmm' + (++uid), a, b, mat });

  // columns: one on each anchor, one mid-pier resting on bare ground
  const as = [...S.terrain.anchors].sort((p, q) => p.x - q.x);
  const xs = [as[0].x, (as[0].x + as[as.length - 1].x) / 2, as[as.length - 1].x];
  const anchorIds = [as[0].id, null, as[as.length - 1].id];

  // mirror of the harness 'engineered' builder: columns subdivided from their
  // own ground up to a shared base, then aligned rows every DY to the crest
  const bases = xs.map((x) => S.terrain.heightAt(x));
  const base = Math.max(...bases);
  const rows = Math.max(1, Math.ceil((CREST - base) / DY));

  const grid = xs.map((x, c) => {
    let prev = N(x, bases[c], anchorIds[c]);
    const subs = Math.max(0, Math.ceil((base - bases[c]) / DY - 1e-6));
    for (let k = 1; k <= subs; k++) {
      const n = N(x, Math.min(base, bases[c] + k * DY));
      M(prev, n);
      prev = n;
    }
    const nodes = [prev];
    for (let r = 1; r <= rows; r++) {
      const n = N(x, base + r * DY);
      M(prev, n);
      prev = n;
      nodes[r] = n;
    }
    return nodes;
  });

  if (style !== 'posts') {
    for (let r = 1; r <= rows; r++) {
      for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r]);
    }
    if (style === 'truss') {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c + 1 < grid.length; c++) M(grid[c][r], grid[c + 1][r + 1]);
      }
    }
  }
}

async function runOne(mat, style, speed, stopAfterImpact) {
  emit('ui:level', { index: LEVEL });
  await new Promise((r) => setTimeout(r, 400));
  const S = game.getScene();
  buildWall(S, mat, style);
  game.release();
  game.setSpeed(speed);
  const t0 = performance.now();
  while (game.getScene().phase === 'sim' && performance.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 200));
    const s = game.getScene();
    if (stopAfterImpact && s.structure &&
        (s.structure.brokenCount > 0 ? s.simTime >= s.structure.firstFailure.time + 1.2
                                     : s.simTime >= 36)) {
      game.setSpeed(0.25); // slow-mo for the screenshot
      return snapshot(s);
    }
  }
  return snapshot(game.getScene());
}

function snapshot(S) {
  const st = S.structure;
  return {
    mat: null, endPhase: S.phase, simTime: +S.simTime.toFixed(1),
    broken: st ? st.brokenCount : -1,
    maxLoad: st ? +st.maxLoad.toFixed(2) : -1,
    firstFailure: st && st.firstFailure
      ? st.firstFailure.mode + '@' + st.firstFailure.time.toFixed(1) + 's' : null,
    win: S.stats ? S.stats.win : null,
    retained: S.stats ? +S.stats.retained.toFixed(2) : null,
    cause: S.stats ? S.stats.cause : null,
  };
}

if (SHOT) {
  const shot = await runOne(window.QA_MAT || 'timber', window.QA_STYLE || 'truss', 2, true);
  return { shot };
}

// same geometry, same flood — only the material differs (the level's lesson:
// a sudden impact is not the same as deep water; steel takes a hit, timber splits)
const timber = await runOne('timber', 'truss', 4, false);
timber.mat = 'timber truss';
const steel = await runOne('steel', 'truss', 4, false);
steel.mat = 'steel truss';
return {
  timber, steel,
  verdict: {
    timberFailed: timber.win === false,
    timberBroke: timber.broken > 0,
    steelHeld: steel.broken === 0 && steel.win === true,
    differentOutcome: timber.win !== steel.win && timber.broken !== steel.broken,
  },
};
