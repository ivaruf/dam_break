// OPUS C. Shared rig for the campaign-tuning harnesses (levels-winnable,
// levels-intended, levels-nodam) — headless boot, scripted designs, one
// simulate() per run. Not run directly; not part of tests/run.js.
//
// The DOM/Canvas stubs come from the half of tests/ui-smoke.mjs above its
// "---- run" marker (single source of truth, imported as a data: URL).
//
// ONE PROCESS-WIDE RULE: the frame clock must stay monotonic across every
// simulate() call. game.js keeps `lastNow` at module scope, so restarting the
// clock per level makes dtReal negative and nothing ticks at all.

import { readFileSync } from 'fs';

const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');

let game = null, events = null, waterSim = null, modes = null;
let MATERIALS = null, LEVELS = null;
let outcome = null;
let clock = 0;

export async function boot() {
  if (game) return { game, events, MATERIALS, LEVELS };
  const head = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8')
    .split('// ---- run --')[0];
  await import('data:text/javascript,' + encodeURIComponent(head));

  game = await import(ROOT + '/src/core/game.js');
  events = await import(ROOT + '/src/core/events.js');
  waterSim = await import(ROOT + '/src/physics/water.js');
  modes = await import(ROOT + '/src/build/modes.js');
  ({ MATERIALS } = await import(ROOT + '/src/build/materials.js'));
  ({ LEVELS } = await import(ROOT + '/src/levels/levels.js'));

  game.boot(document.getElementById('game'));
  events.on('level:win', ({ stats }) => { outcome = { win: true, stats }; });
  events.on('level:fail', ({ stats }) => { outcome = { win: false, stats }; });
  return { game, events, MATERIALS, LEVELS };
}

// ---- design authoring ----------------------------------------------------

// A tiny builder over the live design object. Enforces the same length and
// budget rules the real builder does, and RECORDS refusals, so a design that
// cannot be afforded comes out visibly incomplete instead of silently cheating.
export function design(S) {
  const D = S.design;
  D.nodes.length = 0;
  D.members.length = 0;
  let id = 1;

  const api = {
    cost: 0,
    refused: [],
    nodes: D.nodes,
    members: D.members,

    // snaps to a terrain anchor when one is within tol, so row 0 is anchored
    node(x, y, tol = 0.4) {
      let anchorId = null;
      for (const a of S.terrain.anchors) {
        if (Math.abs(a.x - x) <= tol && Math.abs(a.y - y) <= tol) { anchorId = a.id; x = a.x; y = a.y; break; }
      }
      const n = { id: 'n' + id++, x, y, anchorId };
      D.nodes.push(n);
      return n;
    },

    beam(n1, n2, matId) {
      const mat = MATERIALS[matId];
      if (!mat || !n1 || !n2) return null;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y);
      if (L < mat.minLength) { api.refused.push(matId + ' too short ' + L.toFixed(2)); return null; }
      if (L > mat.maxLength) { api.refused.push(matId + ' too long ' + L.toFixed(2)); return null; }
      const c = L * mat.costPerMeter;
      if (api.cost + c > (S.level.budget || 0) + 0.5) { api.refused.push(matId + ' over budget'); return null; }
      api.cost += c;
      const m = { id: 'm' + id++, a: n1.id, b: n2.id, mat: matId };
      D.members.push(m);
      return m;
    },
  };
  return api;
}

// Anchors inside the build zone, left to right.
export function siteAnchors(S, opts) {
  const bz = S.level.buildZone;
  const lo = opts && opts.xMin !== undefined ? opts.xMin : -Infinity;
  const hi = opts && opts.xMax !== undefined ? opts.xMax : Infinity;
  return S.terrain.anchors.slice()
    .filter((a) => !bz || (a.x >= bz.x0 - 0.01 && a.x <= bz.x1 + 0.01))
    .filter((a) => a.x >= lo && a.x <= hi)
    .sort((a, b) => a.x - b.x);
}

// ---- naive presets (what an untutored player builds) ---------------------

// A single stack of posts at ONE anchor: seals a boundary (coupling seals the
// boundaries a member crosses) but carries no bracing at all. The degenerate
// "solution" the campaign must not reward.
export function postStack(S, opts = {}) {
  const mat = opts.mat || 'timber';
  const rise = opts.rise !== undefined ? opts.rise : 2.4;
  const seg = opts.seg || 1.2;
  const A = siteAnchors(S);
  if (!A.length) return design(S);
  const a = A[Math.floor(A.length / 2)];
  const d = design(S);
  let prev = d.node(a.x, a.y);
  const rows = Math.max(1, Math.round(rise / seg));
  for (let r = 1; r <= rows; r++) {
    const n = d.node(a.x, a.y + r * seg);
    d.beam(prev, n, mat);
    prev = n;
  }
  return d;
}

// Verticals on every site anchor + horizontal rungs, optionally diagonals.
// Uses ONE material throughout and one column per anchor — i.e. it never
// creates an off-anchor foundation and never mixes materials by role.
export function wall(S, opts = {}) {
  const mat = opts.mat || 'timber';
  const rise = opts.rise !== undefined ? opts.rise : 2.4;
  const dy = opts.dy || 0.8;
  const brace = opts.brace !== false;
  const A = siteAnchors(S);
  const d = design(S);
  if (A.length < 2) return d;

  const base = Math.max(...A.map((a) => a.y));
  const rows = Math.max(1, Math.round(rise / dy));
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    grid.push([]);
    for (let c = 0; c < A.length; c++) {
      grid[r].push(d.node(A[c].x, r === 0 ? A[c].y : base + r * dy));
    }
  }
  for (let c = 0; c < A.length; c++) {
    for (let r = 0; r < rows; r++) d.beam(grid[r][c], grid[r + 1][c], mat);
  }
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c + 1 < A.length; c++) d.beam(grid[r][c], grid[r][c + 1], mat);
  }
  if (brace) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c + 1 < A.length; c++) d.beam(grid[r][c], grid[r + 1][c + 1], mat);
    }
  }
  return d;
}

// The tallest single-material wall this budget completes with no refusals —
// so "the naive wall failed" can never just mean "the preset list was capped
// too low". If even the budget-maximal naive wall fails, the level genuinely
// demands better engineering rather than more of the same.
export function wallToBudget(S, opts = {}) {
  let best = null;
  for (let rise = 1.6; rise <= 12; rise += 0.8) {
    const d = wall(S, { ...opts, rise });
    if (d.refused.length) break;
    best = rise;
  }
  return wall(S, { ...opts, rise: best === null ? 1.6 : best });
}

// The naive sweep: every single-material wall a beginner plausibly builds.
export function naivePresets(level) {
  const out = [];
  const mats = level.materials || ['timber'];
  for (const mat of ['concrete', 'steel', 'timber']) {
    if (!mats.includes(mat)) continue;
    for (const rise of [2.4, 3.2, 4.2, 5.2]) {
      out.push({ label: mat + ' braced wall @' + rise + 'm', build: (S) => wall(S, { mat, rise }) });
      out.push({ label: mat + ' UNbraced wall @' + rise + 'm', build: (S) => wall(S, { mat, rise, brace: false }) });
    }
    out.push({ label: mat + ' post stack @3.2m', build: (S) => postStack(S, { mat, rise: 3.2 }) });
    out.push({ label: mat + ' tallest affordable', build: (S) => wallToBudget(S, { mat }) });
  }
  return out;
}

// ---- engineered solutions (what the level is teaching) -------------------

// A properly trussed dam to a target crest elevation, with a material per
// STRUCTURAL ROLE rather than one material everywhere:
//   col   verticals (compression chain, segmented every dy)
//   span  horizontal rungs (bay width decides whether timber can reach)
//   brace diagonals
//   tie   optional long cable from an outer base to the opposite crest
// Extra columns are inserted on the ground wherever a bay is wider than the
// span material can reach — that is the "build a foundation where there is no
// anchor" move the naive presets never make.
export function engineered(S, opts = {}) {
  const col = opts.col || 'timber';
  const span = opts.span || col;
  const brace = opts.brace || span;
  const tie = opts.tie || null;
  const dy = opts.dy || 1.0;
  const crest = opts.crest;
  const A = siteAnchors(S, opts);
  const d = design(S);
  if (A.length < 2 || !(crest > 0)) return d;

  // Column x positions: the anchors, plus intermediate columns founded on the
  // ground between them. Spacing is what makes the face WATERTIGHT — a dam of
  // two far-apart columns joined by rungs is a sieve between the rows, because
  // each member only seals the boundaries it physically crosses. Real dams are
  // a dense row of verticals; `colSpacing` is that density.
  const reach = Math.min(MATERIALS[span].maxLength * 0.95, opts.colSpacing || Infinity);
  const cols = [];
  for (let i = 0; i < A.length; i++) {
    cols.push({ x: A[i].x, y: A[i].y });
    if (i + 1 < A.length) {
      const gap = A[i + 1].x - A[i].x;
      const extra = Math.max(0, Math.ceil(gap / reach) - 1);
      for (let k = 1; k <= extra; k++) {
        const x = A[i].x + (gap * k) / (extra + 1);
        cols.push({ x, y: S.terrain.heightAt(x) });
      }
    }
  }
  cols.sort((p, q) => p.x - q.x);

  const base = Math.max(...cols.map((c) => c.y));
  const rows = Math.max(1, Math.ceil((crest - base) / dy));
  const rowY = [];
  for (let r = 0; r <= rows; r++) rowY.push(base + r * dy);

  // build each column: ground -> base in dy steps, then the aligned rows
  const grid = [];
  for (const c of cols) {
    const nodes = [];
    let prev = d.node(c.x, c.y);
    const subs = Math.max(0, Math.ceil((base - c.y) / dy - 1e-6));
    for (let k = 1; k <= subs; k++) {
      const y = Math.min(base, c.y + k * dy);
      const n = d.node(c.x, y);
      d.beam(prev, n, col);
      prev = n;
    }
    nodes[0] = prev;                       // the node sitting at `base`
    for (let r = 1; r <= rows; r++) {
      const n = d.node(c.x, rowY[r]);
      d.beam(prev, n, col);
      prev = n;
      nodes[r] = n;
    }
    grid.push(nodes);
  }

  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c + 1 < grid.length; c++) d.beam(grid[c][r], grid[c + 1][r], span);
  }
  if (!opts.noBrace) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c + 1 < grid.length; c++) d.beam(grid[c][r], grid[c + 1][r + 1], brace);
    }
  }
  if (tie && grid.length >= 2) {
    const last = grid.length - 1;
    d.beam(grid[0][0], grid[last][rows], tie);
    d.beam(grid[last][0], grid[0][rows], tie);
  }
  return d;
}

// ---- basin geometry -----------------------------------------------------

// Water volume (m², 2-D world) the basin upstream of the dam line holds if the
// surface sits at `elev`. This is how flood volume gets sized to terrain
// instead of guessed.
export function capacityTo(S, elev) {
  const w = S.water;
  const damX = modes.damLineX(S.level, S.terrain);
  let v = 0;
  for (let i = 0; i < w.n; i++) {
    const x = w.x0 + (i + 0.5) * w.cellW;
    if (x > damX) break;
    v += Math.max(0, elev - w.bed[i]) * w.cellW;
  }
  return v;
}

export function inspect(index) {
  game.loadLevel(index);
  const S = game.getScene();
  return {
    S,
    damX: modes.damLineX(S.level, S.terrain),
    anchors: siteAnchors(S),
    capacityTo: (e) => capacityTo(S, e),
  };
}

// ---- simulation ---------------------------------------------------------

export function simulate(index, build, opts = {}) {
  outcome = null;
  game.loadLevel(index);
  const S = game.getScene();
  const d = build ? build(S) : null;
  const cost = d ? d.cost : 0;
  const refused = d ? d.refused : [];
  const crest = S.design.nodes.length ? Math.max(...S.design.nodes.map((n) => n.y)) : null;

  const speed = opts.speed || 4;
  game.setSpeed(speed);

  // Probe the RESERVOIR, i.e. just upstream of the dam structure itself. The
  // dam LINE (buildZone.x1) can sit several metres downstream of the last
  // anchor, and sampling there reads the tailwater instead of the reservoir.
  const site = siteAnchors(S);
  const damFace = site.length ? site[0].x : modes.damLineX(S.level, S.terrain);
  const probeX = damFace - 1.0;
  let peakSurface = -Infinity;

  // one frame + a peak sample; S.water is swapped on release, so re-read it
  const step = () => {
    clock += 16.7;
    game.frame(clock);
    const w = game.getScene().water;
    if (w) {
      const s = waterSim.surfaceAt(w, probeX);
      if (s > peakSurface) peakSurface = s;
    }
  };

  // Countdown levels must live through their build phase: the flood source is
  // already running and the water is travelling downstream while the player
  // builds, so releasing at t=0 would hand the dam a dry valley and start the
  // objective clock far too early. game.js auto-releases when the timer hits 0.
  if (S.level.mode === 'countdown' && !opts.releaseNow) {
    const cap = Math.ceil(((S.level.countdown || 0) + 2) / speed / 0.0167) + 200;
    for (let f = 0; f < cap && game.getScene().phase === 'build'; f++) step();
  }
  if (game.getScene().phase === 'build') game.release();

  const dur = (S.level.objective.duration || 30) + (opts.grace !== undefined ? opts.grace : 10);
  const maxFrames = Math.ceil((dur / speed) / 0.0167) + 150;
  for (let f = 0; f < maxFrames && !outcome; f++) step();

  const st = game.getScene().structure;
  const stats = outcome ? outcome.stats : null;
  return {
    index,
    id: S.level.id,
    budget: S.level.budget || 0,
    cost,
    refused,
    crest,
    peakSurface: peakSurface === -Infinity ? null : peakSurface,
    overtopped: crest !== null && peakSurface > crest,
    win: outcome ? outcome.win : null,
    cause: stats ? stats.cause : '',
    retained: stats ? stats.retained : null,
    maxLoad: st ? st.maxLoad || 0 : 0,
    broken: st ? st.brokenCount || 0 : 0,
    memberCount: st ? st.members.length : 0,
    objective: S.level.objective.type,
  };
}

export const fmt = {
  pct: (v) => (v === null || v === undefined ? '  ?' : (v * 100).toFixed(0).padStart(3) + '%'),
  m: (v) => (v === null || v === undefined ? '  ?' : v.toFixed(1) + 'm'),
  money: (v) => '$' + Math.round(v),
};
