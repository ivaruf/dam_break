// OPUS C owns. Level spec -> runtime objects. Contract §8. DOM-free.
//
// loadLevelSpec(spec) => {terrain, waterSetup, level}. Never mutates `spec` —
// a level can be reloaded many times (retry / edit / level-select all read
// back from the same object living in LEVELS), so every default is filled
// into a fresh copy.
//
// Defensive by design: Fable's physics test scenes (tests/scenes.js
// testLevel(i), loaded via game.js loadTestScene -> game.loadLevel path)
// hand this function level-shaped specs that may omit fields real campaign
// levels always set (terrain, water, objective, ...). Nothing here may throw.

import { createTerrain } from '../core/terrain.js';

const DEFAULT_MATERIALS = ['timber', 'steel', 'concrete', 'cable'];
const ALLOWED_PROP_TYPES = new Set(['pine', 'tree', 'rock', 'house', 'sign']);
const FALLBACK_TERRAIN = [[0, 0], [10, 0]];

function normaliseWater(w) {
  const water = w || {};
  return {
    initial: Array.isArray(water.initial) ? water.initial : [],
    flood: water.flood || null,
    // additional pulses (the sim's water.sources is a list already): each is
    // {x, rate, duration, delay} exactly like `flood`. Levels use this to send
    // a SECOND surge after the first has settled — see 'aftershock'.
    floods: Array.isArray(water.floods) ? water.floods : [],
  };
}

// Fills y from terrain.heightAt(x) when omitted, defaults scale, and drops
// anything with an unknown type or a non-finite x (never lets a bad prop
// reach the renderer).
function normaliseProps(props, terrain) {
  if (!Array.isArray(props)) return [];
  const out = [];
  for (const p of props) {
    if (!p || !ALLOWED_PROP_TYPES.has(p.type) || !Number.isFinite(p.x)) continue;
    const y = Number.isFinite(p.y) ? p.y : terrain.heightAt(p.x);
    const scale = Number.isFinite(p.scale) ? p.scale : 1;
    out.push({ type: p.type, x: p.x, y, scale });
  }
  return out;
}

// A design the level ships already built (level.prebuilt) — the "repair the
// old dam" mechanic. Spec format, index-based so levels stay plain data:
//
//   prebuilt: {
//     nodes:   [[x, y], ...],            // world coords; a node within 0.4 m of
//                                        // a terrain anchor binds to it
//     members: [[ai, bi, matId], ...],   // indices into nodes
//   }
//
// Node ids are 'p1'..'pN' and member ids 'pm1'.. so they can never collide with
// the builder's own 'n'/'m' numbering. The result is an ordinary design object:
// the player can brace it, delete it (deleting refunds, so demolish-and-rebuild
// is a legal strategy), and its cost counts against the budget like anything
// they build themselves — the level's budget must include it.
export function seedDesign(level, terrain) {
  const d = { nodes: [], members: [] };
  const pb = level && level.prebuilt;
  if (!pb || !Array.isArray(pb.nodes)) return d;
  pb.nodes.forEach((pt, i) => {
    let x = pt[0], y = pt[1], anchorId = null;
    for (const a of terrain.anchors) {
      if (Math.hypot(a.x - x, a.y - y) <= 0.4) { anchorId = a.id; x = a.x; y = a.y; break; }
    }
    d.nodes.push({ id: 'p' + (i + 1), x, y, anchorId });
  });
  for (const m of Array.isArray(pb.members) ? pb.members : []) {
    const a = d.nodes[m[0]], b = d.nodes[m[1]];
    if (a && b && a !== b) d.members.push({ id: 'pm' + (d.members.length + 1), a: a.id, b: b.id, mat: m[2] });
  }
  return d;
}

export function loadLevelSpec(spec) {
  const s = spec || {};
  const terrainPoints = Array.isArray(s.terrain) && s.terrain.length >= 2 ? s.terrain : FALLBACK_TERRAIN;
  const anchorSpecs = Array.isArray(s.anchors) ? s.anchors : [];
  const terrain = createTerrain(terrainPoints, anchorSpecs);

  const water = normaliseWater(s.water);

  const level = {
    ...s,
    mode: s.mode || 'freebuild',
    countdown: s.countdown || 0,
    buildZone: s.buildZone !== undefined ? s.buildZone : null,
    materials: Array.isArray(s.materials) && s.materials.length ? s.materials : DEFAULT_MATERIALS,
    objective: s.objective || { type: 'survive', duration: 30 },
    hints: Array.isArray(s.hints) ? s.hints : [],
    water,
    props: normaliseProps(s.props, terrain),
  };

  return { terrain, waterSetup: water, level };
}

// Pure, dependency-free summary for level-select cards. Never touches DOM.
export function levelSummary(spec) {
  const s = spec || {};
  const objective = s.objective || { type: 'survive', duration: 30 };
  return {
    id: s.id || '',
    name: s.name || '',
    subtitle: s.subtitle || '',
    mode: s.mode || 'freebuild',
    countdown: s.countdown || 0,
    budget: s.budget || 0,
    materials: Array.isArray(s.materials) && s.materials.length ? s.materials : DEFAULT_MATERIALS,
    objectiveText: describeObjective(objective),
  };
}

function describeObjective(o) {
  const d = o.duration || 30;
  if (o.type === 'retain') return `Hold ${Math.round((o.minRetention || 0) * 100)}% for ${d}s`;
  if (o.type === 'protect') return `Keep downstream under ${o.maxDepth != null ? o.maxDepth : 0.3} m for ${d}s`;
  return `Survive ${d}s`;
}
