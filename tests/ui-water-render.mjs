// Water v2 renderer harness: exercises the PARTICLE metaball path in
// rendering/waterRenderer.js under Node.
//
// The other ui-* harnesses run that module's FALLBACK path, because their
// canvas stub has no getContext and the renderer then degrades to plain
// per-particle discs on the main context. That is worth having, but it means
// nothing in CI ever touched the offscreen compositing — the part with the
// composite-operation state machine in it. So this harness reuses the ui-smoke
// stubs and then replaces document.createElement with one that hands out
// tallying 2-D contexts, which is enough for the renderer to take the real
// route: sprite ladder, coverage mask, blur, gain, depth stack, foam, surface.
//
// Run directly:  node tests/ui-water-render.mjs
import { readFileSync } from 'fs';
const head = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8').split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

// ---- offscreen canvas stub ------------------------------------------------

const tally = Object.create(null);
function bump(name) { tally[name] = (tally[name] || 0) + 1; }
function resetTally() { for (const k of Object.keys(tally)) delete tally[k]; }

function makeOffscreenCtx(canvas) {
  const ctx = {
    canvas,
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    filter: 'none',
  };
  const noop = (n) => (..._a) => { bump(n); };
  for (const n of ['clearRect', 'fillRect', 'save', 'restore', 'beginPath', 'rect',
    'clip', 'moveTo', 'lineTo', 'arc', 'closePath', 'fill', 'stroke', 'drawImage',
    'setLineDash', 'translate', 'ellipse', 'quadraticCurveTo', 'fillText']) ctx[n] = noop(n);
  ctx.measureText = (t) => ({ width: String(t).length * 7 });
  ctx.createRadialGradient = () => { bump('createRadialGradient'); return { addColorStop() {} }; };
  ctx.createLinearGradient = ctx.createRadialGradient;
  ctx.createPattern = () => null;
  return ctx;
}

const realCreate = globalThis.document.createElement;
globalThis.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (String(tag).toLowerCase() === 'canvas') {
    let ctx = null;
    el.getContext = () => (ctx = ctx || makeOffscreenCtx(el));
  }
  return el;
};

// ---- boot ----------------------------------------------------------------

const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const game = await import(ROOT + '/src/core/game.js');
const waterRenderer = await import(ROOT + '/src/rendering/waterRenderer.js');
const canvas = document.getElementById('game');

let problems = 0;
function check(label, ok, extra) {
  if (!ok) problems++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (extra === undefined ? '' : '   ' + extra));
}

game.boot(canvas);
game.loadLevel(3);              // deep reservoir: plenty of particles
const S = game.getScene();

let now = 1000;
const frame = (n) => { for (let i = 0; i < n; i++) { now += 16.7; game.frame(now); } };

frame(20);
game.release();
frame(240);                     // let the flood build a body of water

const st = waterRenderer.stats();
check('particles reached the renderer', st.particles > 200, 'p=' + st.particles);
check('offscreen compositing path taken', st.offscreen === true);
check('buffer allocated at reduced resolution',
  st.buf > 0 && st.buf < canvas.width, 'buf=' + st.buf + ' canvas=' + canvas.width);
check('sprites drawn for the surface particles', st.sprites > 0, 'sprites=' + st.sprites);
check('dirty rect is a fraction of the buffer',
  st.dirty > 0 && st.dirty <= 1, 'dirty=' + st.dirty.toFixed(2));
check('render cost recorded', st.ms >= 0);

// The water pass must be clipped to the terrain every frame, or a reservoir
// bleeds down through the ground.
resetTally();
frame(1);
check('water pass clips to the terrain', (tally.clip || 0) > 0, 'clip=' + (tally.clip || 0));
check('offscreen blits happen', (tally.drawImage || 0) > 10, 'drawImage=' + (tally.drawImage || 0));

// Frozen sim, two identical frames: identical draw counts. Rendering the same
// particle state twice may never differ (no Math.random in this module).
game.setSpeed(0);
frame(2);
resetTally();
frame(1);
const a = JSON.stringify(tally);
resetTally();
frame(1);
const b = JSON.stringify(tally);
check('deterministic for a frozen sim', a === b);
game.setSpeed(1);

// Both smoothing routes: the ctx.filter blur (browsers that have it) and the
// bilinear down/up bounce (everything else).
let threw = null;
try {
  frame(3);                                  // with ctx.filter present
  // Hand out contexts that have no `filter` from here on, then resize the main
  // canvas: that is what makes the renderer throw its offscreen layers away and
  // build new ones, which is the only way to get it onto the other branch.
  const prev = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = prev(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      const g = el.getContext;
      el.getContext = () => { const x = g(); x.filter = undefined; return x; };
    }
    return el;
  };
  canvas.width = 900; canvas.height = 620;
  canvas.clientWidth = 450; canvas.clientHeight = 310;
  frame(6);
} catch (e) { threw = e; }
check('survives a context without ctx.filter', !threw, threw ? threw.message : '');
check('still compositing offscreen after the resize',
  waterRenderer.stats().offscreen === true && waterRenderer.stats().buf === 450,
  'buf=' + waterRenderer.stats().buf);

// Zoom + pan sweep: LOD floors, huge kernels, and the water entirely off-screen.
threw = null;
try {
  for (const z of [0.4, 1.5, 6, 20, 60, 120]) {
    S.camera.zoom = z;
    frame(3);
  }
  S.camera.zoom = 12;
  S.camera.x = 100000;                      // nothing visible at all
  frame(3);
} catch (e) { threw = e; }
check('survives the zoom sweep and an empty view', !threw, threw ? threw.message : '');
const far = waterRenderer.stats();
check('no sprites drawn when the water is off-screen', far.sprites === 0, 'sprites=' + far.sprites);

console.log('\nPROBLEMS: ' + problems);
process.exit(problems === 0 ? 0 : 1);
