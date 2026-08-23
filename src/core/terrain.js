// Terrain heightfield. DOM-free. FABLE owns.
// points: [[x,y],...] left→right ground surface, y-up meters.
// anchorSpecs: [[x,y],...] valid foundation points.

export function createTerrain(points, anchorSpecs = []) {
  const pts = points.map((p) => [p[0], p[1]]);
  pts.sort((a, b) => a[0] - b[0]);
  const minX = pts[0][0];
  const maxX = pts[pts.length - 1][0];

  function heightAt(x) {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    // linear scan is fine (few dozen points); binary search if it ever matters
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return y0 + (y1 - y0) * t;
      }
    }
    return pts[pts.length - 1][1];
  }

  const anchors = anchorSpecs.map((a, i) => ({
    id: 'a' + i,
    x: a[0],
    y: a[1],
    r: a[2] !== undefined ? a[2] : 0.9,
  }));

  return { points: pts, anchors, minX, maxX, heightAt };
}
