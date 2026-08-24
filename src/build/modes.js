// OPUS B owns. Objectives, win/fail, the stats object. Contract §6 + §10.
// DOM-free: reads the scene, the water API and the design; emits level:win /
// level:fail exactly once per sim run.
//
// THE DAM LINE. Retention is "how much of the water that entered this level is
// still upstream of the dam". The line is level.buildZone.x1 (everything the
// player was allowed to build is upstream of it), or the start of a protected
// zone, or — with neither — the middle of the terrain. Water that leaks past
// keeps running downhill, so it stops counting as retained.

import { CONFIG } from '../config.js';
import { emit, on } from '../core/events.js';
import { getScene } from '../core/game.js';
import * as waterSim from '../physics/water.js';
import { designCost } from './builder.js';
import { MATERIALS } from './materials.js';

const M = {
  level: null, terrain: null,
  done: false,
  stats: null,
  damX: 0,
  tick: 0,
  memberCount: 0,
  zoneDepth: 0,
  badSince: -1,          // sim time retention first went below target
  zoneBadSince: -1,      // sim time protected zone first went over depth
  collapseSince: -1,     // sim time the collapse threshold was first crossed
  overtopT: -1,
  breachT: -1,
  overSince: -1,         // sim time the peak load first crossed the creep threshold
  brk: null,             // first member:break payload (+ how long it had been hot)
};

// CONFIG.damage.creepStart is the physics threshold above which sustained load
// starts eating a member. Read defensively: this file must still build a cause
// line if the damage model is mid-integration and the key is absent.
function creepStart() {
  const d = CONFIG.damage || {};
  return d.creepStart !== undefined ? d.creepStart : 0.7;
}

const cfg = () => CONFIG.build.modes;

export function getStats() { return M.stats; }

export function initModes() {
  on('overtop', () => { if (M.stats && M.overtopT < 0) M.overtopT = getScene().simTime; });
  on('breach', () => { if (M.stats && M.breachT < 0) M.breachT = getScene().simTime; });
  // The break EVENT carries two things structure.firstFailure does not: the load
  // the member was actually carrying when it let go, and — via M.overSince — how
  // long it had been carrying it. A creep failure's whole story is those two
  // numbers, so they are captured here rather than reconstructed later.
  on('member:break', (e) => {
    if (!M.stats || M.brk || !e) return;
    const t = getScene().simTime;
    M.brk = {
      id: e.id,
      mode: e.mode || '',
      sustained: !!e.sustained,
      load: e.load > 0 ? e.load : -1,
      heldFor: M.overSince >= 0 ? t - M.overSince : -1,
    };
  });
  on('sim:reset', () => { M.stats = null; M.done = false; });
}

export function startLevel(level, terrain) {
  M.level = level; M.terrain = terrain;
  M.done = false; M.stats = null;
  M.damX = damLineX(level, terrain);
}

export function startSim(level, _prevStats) {
  const S = getScene();
  if (level) M.level = level;
  if (S.terrain) M.terrain = S.terrain;
  M.damX = damLineX(M.level, M.terrain);
  M.done = false;
  M.tick = 0;
  M.zoneDepth = 0;
  M.badSince = -1; M.zoneBadSince = -1; M.collapseSince = -1;
  M.overtopT = -1; M.breachT = -1;
  M.overSince = -1; M.brk = null;
  M.memberCount = S.design ? S.design.members.length : 0;
  M.stats = {
    retained: 1, peakDepth: 0, maxLoad: 0, brokenCount: 0,
    cost: designCost(S.design), survivalTime: 0, win: false, cause: '',
  };
}

// ---- geometry / water queries --------------------------------------------

export function damLineX(level, terrain) {
  if (level) {
    const o = level.objective;
    if (o && o.type === 'protect' && o.x0 !== undefined) return o.x0;
    if (level.buildZone) return level.buildZone.x1;
    if (o && o.x1 !== undefined) return o.x1;
  }
  if (terrain) return terrain.minX + (terrain.maxX - terrain.minX) * cfg().damLineFrac;
  return 0;
}

// Fraction of all water that ever entered the level still held upstream of xDam.
export function computeRetention(water, xDam) {
  if (!water) return 1;
  const totalIn = (water.stats && water.stats.totalIn) || 0;
  if (totalIn <= cfg().minInflow) return 1;
  const held = waterSim.volumeBetween(water, water.x0, xDam);
  const r = held / totalIn;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

export function maxDepthBetween(water, x0, x1) {
  if (!water) return 0;
  const step = water.cellW > 0 ? water.cellW : 1;
  let peak = 0;
  for (let x = Math.max(x0, water.x0) + step * 0.5; x <= x1; x += step) {
    const d = waterSim.depthAt(water, x);
    if (d > peak) peak = d;
  }
  return peak;
}

// ---- per-tick -------------------------------------------------------------

export function update(dt) {
  if (M.done || !M.stats) return;
  const S = getScene();
  const st = M.stats;
  const C = cfg();
  const t = S.simTime;

  st.survivalTime = t;
  if (S.structure) {
    st.maxLoad = Math.max(st.maxLoad, S.structure.maxLoad || 0);
    st.brokenCount = S.structure.brokenCount || 0;
    // Creep only means anything as a DURATION ("held at 87% for 28 s"), and the
    // cheapest honest source is the contract's own load number: when did this
    // dam first go over the creep threshold. One comparison a tick, no reaching
    // into the damage model.
    if ((S.structure.maxLoad || 0) >= creepStart()) {
      if (M.overSince < 0) M.overSince = t;
    } else M.overSince = -1;
  }

  const obj = (M.level && M.level.objective) || { type: 'survive' };
  const duration = obj.duration || C.defaultDuration;

  M.tick++;
  if (S.water && M.tick % C.depthSampleEvery === 0) {
    st.retained = computeRetention(S.water, M.damX);
    const peak = maxDepthBetween(S.water, S.water.x0, M.damX);
    if (peak > st.peakDepth) st.peakDepth = peak;
    if (obj.type === 'protect') M.zoneDepth = maxDepthBetween(S.water, obj.x0, obj.x1);
  }

  if (obj.type === 'retain') evalRetain(obj, st, t, duration);
  else if (obj.type === 'protect') evalProtect(obj, st, t, duration);
  else evalSurvive(obj, st, t, duration);
}

// retain {minRetention, duration}
function evalRetain(obj, st, t, duration) {
  const C = cfg();
  const min = obj.minRetention !== undefined ? obj.minRetention : C.defaultRetention;

  // Early fail — but only after a clear margin has been lost for failGrace
  // seconds, so a dramatic collapse gets to play out before the screen appears.
  if (t > C.startGrace && st.retained < min - C.retentionFailMargin) {
    if (M.badSince < 0) M.badSince = t;
    if (t - M.badSince >= C.failGrace) { fail(st, retainCause(st, min, true)); return; }
  } else M.badSince = -1;

  if (t >= duration) {
    if (st.retained >= min) win(st);
    else fail(st, retainCause(st, min, false));
  }
}

// survive {duration} — the dam must still be standing when the clock runs out.
function evalSurvive(obj, st, t, duration) {
  const C = cfg();
  const frac = M.memberCount > 0 ? st.brokenCount / M.memberCount : 0;
  // retention only counts when the level actually defines a reservoir to hold
  const useRetention = !!(M.level && M.level.buildZone) || obj.minRetention !== undefined;

  if (t > C.startGrace && frac > C.collapseFrac) {
    if (M.collapseSince < 0) M.collapseSince = t;
    if (t - M.collapseSince >= C.failGrace) { fail(st, collapseCause(st)); return; }
  } else M.collapseSince = -1;

  const brokeAndLeaking = useRetention && st.retained < C.collapseRetention &&
    (st.brokenCount > 0 || M.memberCount === 0);
  if (t > C.startGrace && brokeAndLeaking) {
    if (M.badSince < 0) M.badSince = t;
    if (t - M.badSince >= C.failGrace) { fail(st, failureCause(st)); return; }
  } else M.badSince = -1;

  if (t >= duration) {
    if (frac > C.collapseFrac) fail(st, collapseCause(st));
    else if (obj.minRetention !== undefined && st.retained < obj.minRetention) {
      fail(st, retainCause(st, obj.minRetention, false));
    } else win(st);
  }
}

// protect {x0, x1, maxDepth, duration}
function evalProtect(obj, st, t, duration) {
  const C = cfg();
  const maxDepth = obj.maxDepth !== undefined ? obj.maxDepth : C.defaultMaxDepth;
  if (M.zoneDepth > maxDepth) {
    if (M.zoneBadSince < 0) M.zoneBadSince = t;
    if (t - M.zoneBadSince >= C.protectGrace) { fail(st, protectCause()); return; }
  } else M.zoneBadSince = -1;

  if (t >= duration) win(st);
}

// ---- outcome --------------------------------------------------------------

function win(st) {
  if (M.done) return;
  M.done = true;
  st.win = true;
  st.cause = '';
  emit('level:win', { stats: st });
}

function fail(st, cause) {
  if (M.done) return;
  M.done = true;
  st.win = false;
  st.cause = cause;
  emit('level:fail', { stats: st, cause });
}

// ---- cause lines ----------------------------------------------------------

const pct = (v) => Math.round(v * 100);

// Whichever thing actually happened first tells the story.
function failureCause(st) {
  const S = getScene();
  const ff = S.structure && S.structure.firstFailure;
  const tBreak = ff ? ff.time : Infinity;
  const tOver = M.overtopT >= 0 ? M.overtopT : Infinity;
  const tBreach = M.breachT >= 0 ? M.breachT : Infinity;

  if (tOver < tBreak && tOver < tBreach) return 'OVERTOPPED — THE RESERVOIR ROSE OVER THE CREST';
  if (tBreach < tBreak) return 'BREACHED — WATER FOUND A WAY THROUGH';
  if (ff) {
    // Two of the four failure modes are not events but processes, and they get
    // their own stories: attrition (it held, and holding is what killed it) and
    // bending (it was never crushed — it was pushed out of line and snapped in
    // the middle). Attrition wins the tie, because "you were living on the edge
    // for half a minute" is the more actionable of the two.
    const brk = M.brk && M.brk.id === ff.memberId ? M.brk : null;
    if (ff.sustained || (brk && brk.sustained)) return sustainedCause(st, ff, brk);
    if (ff.mode === 'bending') return bendingCause(S, st, ff);
    const mode = ff.mode === 'tension' ? 'TENSION' : 'COMPRESSION';
    return `${memberLabel(S, ff)} — ${mode} LIMIT EXCEEDED at ${ff.time.toFixed(1)}s`;
  }
  if (tOver < Infinity) return 'OVERTOPPED — THE RESERVOIR ROSE OVER THE CREST';
  if (tBreach < Infinity) return 'BREACHED — WATER FOUND A WAY THROUGH';
  if (!M.memberCount) return 'NOTHING WAS BUILT — THE WATER JUST WALKED THROUGH';
  return "BUDGET WASN'T THE PROBLEM — THE DAM SLID";
}

// `early` = the reservoir drained mid-run (something gave way); otherwise the
// dam simply never held enough water for long enough.
function retainCause(st, min, early) {
  const S = getScene();
  const hasEvent = (S.structure && S.structure.firstFailure) || M.overtopT >= 0 ||
    M.breachT >= 0 || !M.memberCount;
  if (hasEvent) return failureCause(st);
  if (early) return "BUDGET WASN'T THE PROBLEM — THE DAM SLID";
  return `ONLY ${pct(st.retained)}% RETAINED — ${pct(min)}% WAS NEEDED`;
}

// CREEP. The peak is not the point — the point is that the dam sat just under
// the line for half a minute and lost anyway, which is a margin problem, not a
// strength problem. So the line reports the load it was holding and for how long.
function sustainedCause(st, ff, brk) {
  const load = brk && brk.load > 0 ? brk.load : (st.maxLoad || 0);
  const held = brk && brk.heldFor > 0 ? brk.heldFor
    : (M.overSince >= 0 ? Math.max(0, ff.time - M.overSince) : ff.time);
  return `GAVE WAY UNDER SUSTAINED LOAD — HELD AT ${pct(load)}% FOR ${Math.round(held)} s`;
}

// BENDING. Where it went (midspan) and what was leaning on it (deep water over a
// long span). The span length is the number the player can actually act on: put
// a pier under it, or spend on something stiffer.
function bendingCause(S, st, ff) {
  const span = memberSpan(S, ff.memberId);
  const mat = span.matId && MATERIALS[span.matId] ? MATERIALS[span.matId].name.toUpperCase() : '';
  const what = span.len > 0
    ? `${span.len.toFixed(1)} m SPAN${mat ? ' OF ' + mat : ''}`
    : (mat ? `A ${mat} SPAN` : 'AN UNSUPPORTED SPAN');
  const depth = st.peakDepth > 0.1 ? `${st.peakDepth.toFixed(1)} m OF WATER` : 'DEEP WATER';
  return `SNAPPED AT MIDSPAN — ${what} UNDER ${depth} at ${ff.time.toFixed(1)}s`;
}

// Span + material of the member that failed. restLength is the true span, so the
// runtime member is preferred; the design geometry is the fallback (and the only
// source left if the structure has been torn down since).
function memberSpan(S, memberId) {
  const st = S.structure;
  if (st) {
    for (const m of st.members) {
      if (m.id !== memberId) continue;
      const len = m.restLength > 0 ? m.restLength : Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
      return { len, matId: m.mat ? m.mat.id : '' };
    }
  }
  const design = S.design;
  const dm = design ? design.members.find((x) => x.id === memberId) : null;
  if (!dm) return { len: 0, matId: '' };
  const byId = Object.create(null);
  for (const n of design.nodes) byId[n.id] = n;
  const a = byId[dm.a], b = byId[dm.b];
  return { len: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0, matId: dm.mat };
}

function collapseCause(st) {
  return `PROGRESSIVE COLLAPSE — ${st.brokenCount} OF ${M.memberCount} MEMBERS FAILED`;
}

function protectCause() {
  return `FLOODED DOWNSTREAM — ${M.zoneDepth.toFixed(2)} m IN THE PROTECTED ZONE`;
}

// 'LOWER LEFT TIMBER' etc, from where the break happened inside the design.
function memberLabel(S, ff) {
  const design = S.design;
  const m = design ? design.members.find((x) => x.id === ff.memberId) : null;
  const matName = m && MATERIALS[m.mat] ? MATERIALS[m.mat].name.toUpperCase() : 'MEMBER';
  const box = designBBox(design);
  if (!box) return matName;
  const fx = box.w > 1e-6 ? (ff.x - box.x0) / box.w : 0.5;
  const fy = box.h > 1e-6 ? (ff.y - box.y0) / box.h : 0.5;
  const vert = fy < 1 / 3 ? 'LOWER' : fy > 2 / 3 ? 'UPPER' : 'MID';
  const horiz = fx < 1 / 3 ? 'LEFT' : fx > 2 / 3 ? 'RIGHT' : 'CENTRE';
  return `${vert} ${horiz} ${matName}`;
}

function designBBox(design) {
  if (!design || !design.nodes.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of design.nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.y > y1) y1 = n.y;
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

// ---- HUD helpers (Opus C may use these) ----------------------------------

export function objectiveText(level) {
  const o = (level || M.level || {}).objective;
  if (!o) return '';
  const d = o.duration || cfg().defaultDuration;
  if (o.type === 'retain') return `HOLD ${pct(o.minRetention || 0)}% FOR ${d}s`;
  if (o.type === 'protect') return `KEEP DOWNSTREAM UNDER ${o.maxDepth} m FOR ${d}s`;
  return `SURVIVE ${d}s`;
}

// Live objective progress for the HUD: 0..1 plus the raw numbers.
export function getProgress() {
  const o = (M.level && M.level.objective) || null;
  const st = M.stats;
  if (!o || !st) return null;
  const duration = o.duration || cfg().defaultDuration;
  const p = {
    type: o.type, elapsed: st.survivalTime, duration,
    timeFrac: Math.min(1, duration > 0 ? st.survivalTime / duration : 0),
    retained: st.retained, need: o.minRetention,
    zoneDepth: M.zoneDepth, maxDepth: o.maxDepth,
    damX: M.damX, ok: true,
  };
  if (o.type === 'retain') p.ok = st.retained >= (o.minRetention || 0);
  else if (o.type === 'protect') p.ok = M.zoneDepth <= (o.maxDepth || 0);
  else p.ok = M.memberCount === 0 || st.brokenCount / M.memberCount <= cfg().collapseFrac;
  return p;
}
