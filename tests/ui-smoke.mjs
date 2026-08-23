// Headless integration smoke test for the DAM BUILDER render/UI stack.
// Stubs just enough DOM + Canvas2D to run game.boot() and real frames.
// Lives in tests/ but is NOT run by tests/run.js (Opus A owns that).
// Run directly:  node tests/ui-smoke.mjs
//
// The half of this file ABOVE the "---- run" marker is pure DOM/Canvas
// stubs with no imports: the other ui-*/levels-* harnesses read it and
// import it as a data: URL to reuse the stubs. Keep it import-free and
// keep anything using import.meta.url BELOW the marker (a data: URL has
// no base to resolve relative paths against).

// ---- element stub --------------------------------------------------------

class El {
  constructor(id, tag) {
    this.id = id || '';
    this.tagName = (tag || 'div').toUpperCase();
    this._cls = new Set();
    this.style = {};
    this.dataset = {};
    this._text = '';
    this.children = [];
    this.parentNode = null;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this._handlers = {};
    this.classList = {
      add: (c) => this._cls.add(c),
      remove: (c) => this._cls.delete(c),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !this._cls.has(c) : !!on;
        if (want) this._cls.add(c); else this._cls.delete(c);
        return want;
      },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return ''; }
  set innerHTML(_v) { for (const c of this.children) c.parentNode = null; this.children.length = 0; }
  get childElementCount() { return this.children.length; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  click() { for (const fn of this._handlers.click || []) fn({}); }
  querySelectorAll() { return []; }
}

// ---- canvas 2D stub -----------------------------------------------------

const calls = Object.create(null);
function tally(name) { calls[name] = (calls[name] || 0) + 1; }

function makeCtx(canvas) {
  const ctx = {
    canvas,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    globalAlpha: 1, textBaseline: '', lineDashOffset: 0, globalCompositeOperation: '',
  };
  const noop = (n) => (..._a) => { tally(n); };
  for (const n of ['clearRect', 'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'bezierCurveTo', 'arc', 'rect', 'closePath', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'clip', 'setLineDash', 'fillText', 'strokeText',
    'translate', 'rotate', 'scale', 'setTransform', 'resetTransform', 'ellipse',
    'drawImage', 'putImageData']) ctx[n] = noop(n);
  ctx.measureText = (t) => { tally('measureText'); return { width: String(t).length * 7 }; };
  ctx.createLinearGradient = () => {
    tally('createLinearGradient');
    return { addColorStop() {} };
  };
  ctx.createRadialGradient = ctx.createLinearGradient;
  ctx.createPattern = () => null;
  return ctx;
}

// ---- globals ------------------------------------------------------------

const registry = new Map();
function getEl(id) {
  let e = registry.get(id);
  if (!e) { e = new El(id, id === 'game' ? 'canvas' : 'div'); registry.set(id, e); }
  return e;
}

const canvas = getEl('game');
canvas.width = 800; canvas.height = 600;
canvas.clientWidth = 400; canvas.clientHeight = 300;   // dpr 2
const ctx = makeCtx(canvas);
canvas.getContext = () => ctx;

const speedBtns = ['0', '0.25', '1', '2', '4'].map((v, i) => {
  const b = new El('speed-' + i, 'button');
  b.dataset.speed = v;
  b._cls.add('speed-btn');
  return b;
});

globalThis.document = {
  getElementById: (id) => getEl(id),
  createElement: (tag) => new El('', tag),
  querySelectorAll: (sel) => (sel === '.speed-btn' ? speedBtns : []),
  addEventListener() {},
  documentElement: new El('root', 'html'),
  body: new El('body', 'body'),
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.window = {
  addEventListener() {},
  devicePixelRatio: 2,
  innerWidth: 400, innerHeight: 300,
  location: { protocol: 'http:' },
  localStorage: globalThis.localStorage,
};
// node ships a read-only navigator getter; only define it if we can
try { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined }, configurable: true }); }
catch { /* node's own navigator is fine — nothing under test reads it */ }
globalThis.requestAnimationFrame = () => 0;
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

// ---- run ----------------------------------------------------------------

// Repo root as a file: URL, derived from this file's own location, so the
// harness runs from any cwd.
const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');

const problems = [];
function guard(label, fn) {
  try { return fn(); }
  catch (e) { problems.push(label + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e)); return null; }
}

const game = await import(ROOT + '/src/core/game.js');
const { emit } = await import(ROOT + '/src/core/events.js');
const { LEVELS } = await import(ROOT + '/src/levels/levels.js');
const debug = await import(ROOT + '/src/ui/debug.js');
const builder = await import(ROOT + '/src/build/builder.js');

guard('boot', () => game.boot(canvas));

let t = 0;
function frames(n, step = 16.7) {
  for (let i = 0; i < n; i++) { t += step; game.frame(t); }
}

console.log('LEVELS:', LEVELS.length);

for (let li = 1; li <= LEVELS.length; li++) {
  const spec = LEVELS[li - 1];
  guard('loadLevel ' + li, () => game.loadLevel(li));
  const S = game.getScene();
  if (!S.terrain) { problems.push('level ' + li + ' produced no terrain'); continue; }

  guard('build frames ' + li, () => frames(10));

  // build a small dam by dragging between the first two anchors
  const A = S.terrain.anchors;
  if (A.length >= 2) {
    for (let k = 0; k + 1 < Math.min(A.length, 4); k++) {
      const a = A[k], b = A[k + 1];
      guard('drag ' + li + '/' + k, () => {
        emit('input:down', { x: a.x, y: a.y, px: 100, py: 100, id: 1, button: 0, cancel: false });
        emit('input:move', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 1, px: 140, py: 90, id: 1, button: 0, cancel: false });
        frames(2);
        emit('input:move', { x: b.x, y: b.y + 2, px: 180, py: 80, id: 1, button: 0, cancel: false });
        frames(2);
        emit('input:up', { x: b.x, y: b.y + 2, px: 180, py: 80, id: 1, button: 0, cancel: false });
      });
    }
    // hover + selection + eraser paths
    guard('hover ' + li, () => {
      emit('input:move', { x: A[0].x, y: A[0].y + 1, px: 120, py: 95, id: 1, button: -1, cancel: false, hover: true });
      frames(2);
    });
    guard('select ' + li, () => {
      const m = S.design.members[0];
      if (m) builder.getBuilder().selection = m.id;
      frames(2);
    });
    guard('erase-tool ' + li, () => {
      emit('ui:tool', { id: 'erase' });
      frames(2);
      emit('ui:tool', { id: 'erase' });
    });
  }

  guard('undo/redo ' + li, () => { emit('ui:undo', {}); frames(1); emit('ui:redo', {}); frames(1); });
  guard('material ' + li, () => {
    for (const id of spec.materials || []) { emit('ui:material', { id }); frames(1); }
  });

  guard('release ' + li, () => game.release());
  guard('sim frames ' + li, () => frames(90));

  // decorative event paths
  guard('fx events ' + li, () => {
    const st = game.getScene().structure;
    const m = st && st.members[0];
    if (m) emit('member:break', { id: m.id, x: m.a.x, y: m.a.y, mode: 'tension', matId: m.mat.id });
    emit('water:impact', { x: S.terrain.minX + 5, y: 5, speed: 6, magnitude: 1200 });
    emit('breach', { x: S.terrain.minX + 8, y: 4, flow: 1.2 });
    emit('overtop', { x: S.terrain.minX + 8, flow: 0.4 });
    frames(30);
  });

  guard('speeds ' + li, () => {
    for (const v of [0, 0.25, 2, 4, 1]) { game.setSpeed(v); frames(6); }
  });

  guard('debug ' + li, () => { debug.toggle(); frames(6); debug.toggle(); });
  guard('retry ' + li, () => { game.retry(); frames(20); });
  guard('edit ' + li, () => { game.toEdit(); frames(10); });
}

// result screen path
guard('result', () => {
  game.loadLevel(1);
  frames(5);
  game.release();
  frames(5);
  emit('level:fail', { stats: { retained: 0.4, peakDepth: 3.2, maxLoad: 1.4, brokenCount: 3, cost: 900, survivalTime: 12.5, win: false, cause: 'OVERTOPPED — THE RESERVOIR ROSE OVER THE CREST' } });
  frames(3);
});
guard('result-win', () => {
  game.loadLevel(1);
  frames(5);
  game.release();
  frames(5);
  emit('level:win', { stats: { retained: 0.95, peakDepth: 3.2, maxLoad: 0.7, brokenCount: 0, cost: 900, survivalTime: 40, win: true, cause: '' } });
  frames(3);
});

// tutorial buttons
guard('tutorial', () => {
  store.delete('dam-builder-tut');
  game.loadLevel(1);
  frames(2);
  getEl('btn-tut-next').click();
  getEl('btn-tut-next').click();
  getEl('btn-tut-next').click();
  getEl('btn-tut-skip').click();
});

console.log('\ncanvas ops:', Object.entries(calls).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, v]) => k + '=' + v).join(' '));
console.log('\nPROBLEMS:', problems.length);
for (const p of problems) console.log(' -', p);
process.exit(problems.length ? 1 : 0);
