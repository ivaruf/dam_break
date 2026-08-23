// QA scenario (runs in page via tools/drive.mjs --eval): boot into level 1,
// verify build phase, place one member programmatically, verify cost > 0.
const { game, emit } = window.DAM;
emit('ui:level', { index: 1 });
await new Promise((r) => setTimeout(r, 400));
const S = game.getScene();
if (S.phase !== 'build') return { fail: 'not in build phase: ' + S.phase };

const a = S.terrain.anchors;
if (!a.length) return { fail: 'no anchors' };
S.design.nodes.push({ id: 'q1', x: a[0].x, y: a[0].y, anchorId: a[0].id });
S.design.nodes.push({ id: 'q2', x: a[0].x, y: a[0].y + 2, anchorId: null });
S.design.members.push({ id: 'qm1', a: 'q1', b: 'q2', mat: S.level.materials[0] });
await new Promise((r) => setTimeout(r, 300));

const { designCost } = await import('./src/build/builder.js');
return {
  phase: S.phase,
  level: S.level.id,
  anchors: a.length,
  waterCells: S.water.n,
  cost: Math.round(designCost(S.design)),
};
