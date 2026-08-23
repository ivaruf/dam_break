// STUB — OPUS C owns. Terrain, anchors, structure/design, stress colors.
// Contract: ARCHITECTURE.md §9.

import { getBuilder } from '../build/builder.js';
import { MATERIALS } from '../build/materials.js';

export function init(canvas) {}

export function render(ctx, cam, S) {
  drawTerrain(ctx, cam, S.terrain);
  drawAnchors(ctx, cam, S.terrain);
  if (S.structure) drawStructure(ctx, cam, S.structure);
  else drawDesign(ctx, cam, S.design);
  drawGhost(ctx, cam);
}

function drawTerrain(ctx, cam, t) {
  ctx.beginPath();
  const [sx0, sy0] = cam.worldToScreen(t.points[0][0], t.points[0][1]);
  ctx.moveTo(sx0, sy0);
  for (const [x, y] of t.points) {
    const [sx, sy] = cam.worldToScreen(x, y);
    ctx.lineTo(sx, sy);
  }
  const [ex] = cam.worldToScreen(t.maxX, 0);
  ctx.lineTo(ex, ctx.canvas.height + 50);
  ctx.lineTo(sx0, ctx.canvas.height + 50);
  ctx.closePath();
  ctx.fillStyle = '#3d4a3a';
  ctx.fill();
}

function drawAnchors(ctx, cam, t) {
  ctx.fillStyle = '#ffd35a';
  for (const a of t.anchors) {
    const [sx, sy] = cam.worldToScreen(a.x, a.y);
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function memberColor(m) {
  if (m.broken) return '#333';
  if (m.load > 0.8) return m.loadSign > 0 ? '#4db8ff' : '#ff5a3c';
  return m.mat ? m.mat.color : '#ccc';
}

function drawStructure(ctx, cam, structure) {
  for (const m of structure.members) {
    if (m.broken) continue;
    line(ctx, cam, m.a.x, m.a.y, m.b.x, m.b.y, memberColor(m), (m.mat.thickness || 0.3) * cam.zoom);
  }
}

function drawDesign(ctx, cam, design) {
  if (!design) return;
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  for (const m of design.members) {
    const a = byId.get(m.a), b = byId.get(m.b);
    const mat = MATERIALS[m.mat];
    line(ctx, cam, a.x, a.y, b.x, b.y, mat.color, mat.thickness * cam.zoom);
  }
  ctx.fillStyle = '#fff';
  for (const n of design.nodes) {
    const [sx, sy] = cam.worldToScreen(n.x, n.y);
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGhost(ctx, cam) {
  const g = getBuilder().ghost;
  if (!g) return;
  line(ctx, cam, g.x0, g.y0, g.x1, g.y1, g.ok ? '#7fff9a88' : '#ff5a5a88', 3);
}

function line(ctx, cam, x0, y0, x1, y1, color, w) {
  const [sx0, sy0] = cam.worldToScreen(x0, y0);
  const [sx1, sy1] = cam.worldToScreen(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, w);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx0, sy0);
  ctx.lineTo(sx1, sy1);
  ctx.stroke();
}
