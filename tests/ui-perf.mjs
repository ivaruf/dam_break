// 250-member load test: measures OUR per-frame JS cost (canvas is stubbed, so
// this isolates loop/allocation overhead, not GPU rasterisation).
import { readFileSync } from 'fs';
const src = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8');
// reuse smoke.mjs's stubs by importing everything up to the "run" section
const head = src.split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

// Repo root as a file: URL, derived from this file's own location, so the
// harness runs from any cwd.
const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const game = await import(ROOT + '/src/core/game.js');
const { MATERIALS } = await import(ROOT + '/src/build/materials.js');
const canvas = document.getElementById('game');

game.boot(canvas);
game.loadLevel(1);
const S = game.getScene();

// hand-build a dense truss across the dam site: 2 rows x N bays, braced
const bz = S.level.buildZone || { x0: S.terrain.minX + 5, x1: S.terrain.minX + 20 };
const y0 = S.terrain.heightAt((bz.x0 + bz.x1) / 2);
const bays = 42, dx = (bz.x1 - bz.x0) / bays, rows = 3, dy = 0.9;
let id = 1;
const nid = (r, c) => 'n' + (r * (bays + 1) + c + 1);
for (let r = 0; r <= rows; r++) {
  for (let c = 0; c <= bays; c++) {
    S.design.nodes.push({ id: nid(r, c), x: bz.x0 + c * dx, y: y0 + r * dy, anchorId: null });
  }
}
const mats = Object.keys(MATERIALS);
function add(a, b) { S.design.members.push({ id: 'm' + id++, a, b, mat: mats[id % mats.length] }); }
for (let r = 0; r <= rows; r++) for (let c = 0; c < bays; c++) add(nid(r, c), nid(r, c + 1));
for (let r = 0; r < rows; r++) for (let c = 0; c <= bays; c += 2) add(nid(r, c), nid(r + 1, c));
for (let r = 0; r < rows; r++) for (let c = 0; c < bays; c += 2) add(nid(r, c), nid(r + 1, c + 1));
console.log('members:', S.design.members.length, 'nodes:', S.design.nodes.length);

function bench(label, n) {
  let t = 1000;
  game.frame(t); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { t += 16.7; game.frame(t); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(label.padEnd(28), ms.toFixed(3) + ' ms/frame', '→', (1000 / ms).toFixed(0) + ' fps ceiling');
}

bench('build phase (design+ghost)', 200);
game.release();
console.log('physics members:', game.getScene().structure.members.length);
bench('sim phase (physics+render)', 200);
const dbg = await import(ROOT + '/src/ui/debug.js');
dbg.toggle();
bench('sim + F2 debug overlay', 100);
