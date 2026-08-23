// STUB — OPUS C owns. Water surface rendering. Contract §9.

export function render(ctx, cam, water, S) {
  if (!water) return;
  ctx.fillStyle = 'rgba(53, 167, 255, 0.55)';
  for (let i = 0; i < water.n; i++) {
    const d = water.depth[i];
    if (d <= water.cfg.minDepth) continue;
    const x = water.x0 + i * water.cellW;
    const [sx0, syTop] = cam.worldToScreen(x, water.bed[i] + d);
    const [sx1, syBot] = cam.worldToScreen(x + water.cellW, water.bed[i]);
    ctx.fillRect(sx0, syTop, sx1 - sx0 + 1, syBot - syTop);
  }
}
