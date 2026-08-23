// STUB — OPUS A owns. 1-D shallow-water column grid (pipe model).
// Contract: ARCHITECTURE.md §5 "Water". DOM-free, deterministic.

export function createWater(terrain, cfg) {
  const x0 = terrain.minX;
  const n = Math.max(2, Math.ceil((terrain.maxX - terrain.minX) / cfg.cellW));
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) bed[i] = terrain.heightAt(x0 + (i + 0.5) * cfg.cellW);
  return {
    x0, cellW: cfg.cellW, n, cfg,
    bed,
    depth: new Float32Array(n),
    vel: new Float32Array(n + 1),
    blocked: new Array(n + 1).fill(null),
    sources: [],
    time: 0,
    stats: { totalIn: 0 },
  };
}

export function addWater(water, { x0, x1, surface }) {
  for (let i = 0; i < water.n; i++) {
    const x = water.x0 + (i + 0.5) * water.cellW;
    if (x >= x0 && x <= x1) {
      const d = Math.max(0, surface - water.bed[i]);
      water.stats.totalIn += Math.max(0, d - water.depth[i]) * water.cellW;
      water.depth[i] = Math.max(water.depth[i], d);
    }
  }
}

export function addSource(water, { x, rate, duration = Infinity, delay = 0 }) {
  water.sources.push({ x, rate, duration, delay, t: 0 });
}

export function setBoundaryBlocks(water, blocked) { water.blocked = blocked; }

function idx(water, x) {
  return Math.max(0, Math.min(water.n - 1, Math.floor((x - water.x0) / water.cellW)));
}

export function surfaceAt(water, x) { const i = idx(water, x); return water.bed[i] + water.depth[i]; }
export function depthAt(water, x) { return water.depth[idx(water, x)]; }
export function velAt(water, x) { return water.vel[idx(water, x)]; }

export function volumeBetween(water, x0, x1) {
  let v = 0;
  for (let i = 0; i < water.n; i++) {
    const x = water.x0 + (i + 0.5) * water.cellW;
    if (x >= x0 && x <= x1) v += water.depth[i] * water.cellW;
  }
  return v;
}

export function stepWater(water, dt) {
  const { g, damping, maxVel, transferCap } = water.cfg;
  water.time += dt;

  for (const s of water.sources) {
    s.t += dt;
    if (s.t > s.delay && s.t <= s.delay + s.duration) {
      const i = idx(water, s.x);
      water.depth[i] += (s.rate * dt) / water.cellW;
      water.stats.totalIn += s.rate * dt;
    }
  }

  // naive pipe model between neighbors (stub: ignores blocked intervals)
  const surf = (i) => water.bed[i] + water.depth[i];
  for (let b = 1; b < water.n; b++) {
    const dh = surf(b - 1) - surf(b);
    water.vel[b] = Math.max(-maxVel, Math.min(maxVel, (water.vel[b] + g * dh * dt) * damping));
  }
  const dNew = Float32Array.from(water.depth);
  for (let b = 1; b < water.n; b++) {
    const from = water.vel[b] > 0 ? b - 1 : b;
    let q = (water.vel[b] * dt * water.depth[from]) / water.cellW;
    const cap = water.depth[from] * transferCap;
    q = Math.max(-cap, Math.min(cap, q));
    dNew[b - 1] -= q;
    dNew[b] += q;
  }
  for (let i = 0; i < water.n; i++) water.depth[i] = Math.max(0, dNew[i]);
}
