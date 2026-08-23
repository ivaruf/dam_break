// Camera: world (meters, y-up) ↔ screen (px, y-down). FABLE owns.

export function createCamera(canvas) {
  const cam = {
    x: 30, y: 8, zoom: 14, // zoom = px per meter
    min: 3, max: 90,
    shakeX: 0, shakeY: 0, // effects.js may write these (px, decays there)

    worldToScreen(wx, wy) {
      return [
        (wx - cam.x) * cam.zoom + canvas.width / 2 + cam.shakeX,
        canvas.height / 2 - (wy - cam.y) * cam.zoom + cam.shakeY,
      ];
    },

    screenToWorld(px, py) {
      return [
        (px - canvas.width / 2 - cam.shakeX) / cam.zoom + cam.x,
        (canvas.height / 2 - (py - cam.shakeY)) / cam.zoom + cam.y,
      ];
    },

    pan(dxPx, dyPx) {
      cam.x -= dxPx / cam.zoom;
      cam.y += dyPx / cam.zoom;
    },

    zoomAt(px, py, factor) {
      const [wx, wy] = cam.screenToWorld(px, py);
      cam.zoom = Math.min(cam.max, Math.max(cam.min, cam.zoom * factor));
      // keep the world point under the cursor fixed
      cam.x = wx - (px - canvas.width / 2) / cam.zoom;
      cam.y = wy + (py - canvas.height / 2) / cam.zoom;
    },

    fit(terrain) {
      const w = terrain.maxX - terrain.minX;
      let lo = Infinity, hi = -Infinity;
      for (const [, y] of terrain.points) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
      hi += 8; // headroom for dam + water
      const h = Math.max(6, hi - lo);
      cam.zoom = Math.min(cam.max, Math.max(cam.min,
        Math.min(canvas.width / (w * 1.06), canvas.height / (h * 1.35))));
      cam.x = terrain.minX + w / 2;
      cam.y = lo + h / 2;
    },
  };
  return cam;
}
