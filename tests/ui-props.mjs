// Exercises the OPUS C level extensions the loader will feed the renderer:
// decorative props (all five types, with and without an explicit y) and a
// protect-objective zone with its hatch + label.
import { readFileSync } from 'fs';
const head = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8').split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

// Repo root as a file: URL, derived from this file's own location, so the
// harness runs from any cwd.
const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const game = await import(ROOT + '/src/core/game.js');
const canvas = document.getElementById('game');
game.boot(canvas);
game.loadLevel(1);
const S = game.getScene();

const t = S.terrain;
S.level.props = [
  { type: 'pine', x: t.minX + 4, y: t.heightAt(t.minX + 4), scale: 1 },
  { type: 'tree', x: t.minX + 8, y: t.heightAt(t.minX + 8), scale: 1.3 },
  { type: 'rock', x: t.minX + 12, y: t.heightAt(t.minX + 12), scale: 0.8 },
  { type: 'house', x: t.maxX - 6, y: t.heightAt(t.maxX - 6), scale: 1 },
  { type: 'sign', x: t.minX + 20, y: t.heightAt(t.minX + 20), scale: 1 },
  { type: 'bogus', x: t.minX + 22, y: 0, scale: 1 },          // unknown type: must be skipped
  { type: 'pine', x: NaN, y: 0, scale: 1 },                   // bad x: must be skipped
  { type: 'tree', x: t.minX + 3 },                            // y/scale missing: must not throw
];
S.level.objective = { type: 'protect', x0: t.maxX - 14, x1: t.maxX - 2, maxDepth: 0.3, duration: 40 };

let ok = true;
try {
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 16.7; game.frame(now); }
  game.release();
  for (let i = 0; i < 60; i++) { now += 16.7; game.frame(now); }
  // and at extreme zooms, where prop/label culling and LOD kick in
  for (const z of [3, 2.5, 8, 40, 90]) {
    S.camera.zoom = z;
    for (let i = 0; i < 5; i++) { now += 16.7; game.frame(now); }
  }
} catch (e) { ok = false; console.log('THREW:', e.stack.split('\n').slice(0, 5).join('\n')); }
console.log(ok ? 'props + protect zone + zoom sweep: OK' : 'FAILED');
