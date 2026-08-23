// STUB — OPUS C owns. F2 debug overlay: FPS, counts, stress numbers,
// blocked intervals, velocity vectors. Contract §9. Read-only over scene.

import { CONFIG } from '../config.js';

let enabled = CONFIG.debug.enabled;
let frames = 0, fps = 0, last = 0;

export function init() {}
export function toggle() { enabled = !enabled; }

export function render(ctx, cam, S) {
  frames++;
  const now = performance.now();
  if (now - last > 500) { fps = Math.round(frames * 1000 / (now - last)); frames = 0; last = now; }
  if (!enabled) return;

  ctx.fillStyle = '#0f0';
  ctx.font = '12px monospace';
  const lines = [
    `fps ${fps}  phase ${S.phase}  t ${S.simTime.toFixed(1)}`,
    S.structure ? `nodes ${S.structure.nodes.length} members ${S.structure.members.length} broken ${S.structure.brokenCount} maxLoad ${S.structure.maxLoad.toFixed(2)}` : 'no structure',
    S.water ? `water cells ${S.water.n} vol ${S.water.depth.reduce((a, b) => a + b, 0).toFixed(1)}` : '',
  ];
  lines.forEach((l, i) => ctx.fillText(l, 8, 60 + i * 14));
}
