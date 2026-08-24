// OPUS A owns. strain → load → damage → break + failure record.
// Contract: ARCHITECTURE.md §5 "Damage model — v2.1". DOM-free, deterministic.
//
//   axialLoad = |strain| / limit          (slenderness-reduced in compression)
//   bendLoad  = |m.waterFperp| · len / (8 · bendScale · mat.bending)
//   load      = max(axialLoad, bendLoad)
//
//   load < creepStart (0.7)  safe
//   creepStart – 1.0         CREEP: damage += mat.creepRate · f · dt,
//                            f = (load − creepStart)/(1 − creepStart)
//   1.0 – 1.2                damage += (load − 1) · damageRate · dt  (+ creep)
//   > 1.2                    fastRate band                           (+ creep)
//   load ≥ hardBreak (1.6)   instant break
//   damage ≥ 1               break
//
// Creep never switches off above the threshold: it STACKS with the overload
// bands, so a member the water is only slightly overloading dies noticeably
// faster than the 1.0–1.2 band alone would kill it.
//
// TWO WAYS THE WATER NOW DESTROYS A DAM, both of which reward craftsmanship:
//
//   BENDING  coupling.js publishes the transverse water push per member
//     (m.waterFperp). The peak moment in a simply-supported span carrying a
//     distributed load is F·L/8, so a span twice as long carries roughly four
//     times the moment for the same pressure — putting a pier in the middle of
//     a bay is the single most effective thing a player can do. bendLoad is
//     kept on the member separately from `load` so the renderer can bow it.
//
//   CREEP  a face that sits at 0.9 has not survived, it is dying slowly.
//     Timber goes in about half a minute, steel takes twenty times longer,
//     concrete longer still. This is what stops "one triangle, held at 0.98"
//     from being a winning answer to deep water.
//
// Slenderness reduces the effective compression limit so long unbraced beams
// buckle:  limit / (1 + k·(len/refLen)²).  That is what makes bracing matter.

import { CONFIG } from '../config.js';
import { emit } from '../core/events.js';
import { spawnDebris } from './structures.js';

// Effective compression limit after buckling reduction (exported for debug/UI).
export function compressionLimitFor(mat, len) {
  const D = CONFIG.damage;
  const r = len / D.slenderRefLen;
  return mat.compressionLimit / (1 + D.slenderness * r * r);
}

// Moment capacity of a member in game newton-metres (exported for tuning/UI).
export function bendCapacityFor(mat) {
  return CONFIG.damage.bendScale * (mat.bending || 0);
}

// Head (m of still water) a simply-supported face panel of length `len` can
// take before bending reaches load 1.0, assuming the panel is the BOTTOM bay of
// the face and the water reaches at least its top. Analytic companion to the
// ratings gate; nothing in the sim reads it.
export function headRatingFor(mat, len) {
  const cap = bendCapacityFor(mat);
  if (!(cap > 0) || !(len > 0)) return 0;
  const C = CONFIG.coupling;
  // F = ½·scale·ρ·g·(H² − (H−L)²) = ½·scale·ρ·g·L·(2H−L);  M = F·L/8 = cap
  const k = 0.5 * C.pressureScale * C.density * CONFIG.water.g;
  return ((8 * cap) / (k * len * len) + len) * 0.5;
}

export function updateStress(structure, dt, time) {
  if (!structure) return [];
  const D = CONFIG.damage;
  const creepSpan = 1 - D.creepStart;
  // Dynamic load factor: a span only develops its full moment from a load that
  // lasts as long as the span takes to respond. One exp() per tick, no state
  // beyond m.bendLoad itself.
  const aB = D.bendTau > 0 ? 1 - Math.exp(-dt / D.bendTau) : 1;
  const broken = [];

  for (let i = 0; i < structure.members.length; i++) {
    const m = structure.members[i];
    if (m.broken || !m.mat) continue;

    const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    m.strain = (len - m.restLength) / m.restLength;
    m.loadSign = m.strain >= 0 ? 1 : -1;   // stays AXIAL: the renderer colours by it

    // ---- bending: the water's transverse push over an unsupported span ----
    // A rope carries no moment (mat.bending 0 for cables) — it just moves.
    let bend = 0;
    const bendCap = D.bendScale * (m.mat.bending || 0);
    if (bendCap > 0) {
      const fPerp = m.waterFperp;
      const raw = fPerp ? (fPerp < 0 ? -fPerp : fPerp) * len / (8 * bendCap) : 0;
      bend = m.bendLoad + (raw - m.bendLoad) * aB;
    }
    m.bendLoad = bend;

    let axial = 0;
    if (m.strain >= 0) {
      const limit = m.mat.tensionLimit;
      axial = limit > 0 ? m.strain / limit : 0;
    } else if (m.tensionOnly) {
      m.load = 0;                       // slack cable carries nothing
      continue;
    } else {
      const limit = compressionLimitFor(m.mat, len);
      axial = limit > 0 ? -m.strain / limit : 0;
    }

    const bendGoverns = bend > axial;
    m.load = bendGoverns ? bend : axial;
    if (m.load > structure.maxLoad) structure.maxLoad = m.load;

    if (m.load >= D.hardBreak) {
      m.damage = 1;
      breakMember(structure, m, time, broken, bendGoverns);
      continue;
    }

    // creep first: it applies across the whole 0.7..hardBreak range
    let inc = 0;
    if (m.load > D.creepStart) {
      inc = (m.mat.creepRate || 0) * ((m.load - D.creepStart) / creepSpan) * dt;
    }
    if (m.load > 1) {
      const rate = m.load > D.fastAbove ? D.fastRate : D.damageRate;
      inc += (m.load - 1) * rate * dt;
    }
    if (inc > 0) {
      m.damage += inc;
      if (m.damage >= 1) {
        m.damage = 1;
        breakMember(structure, m, time, broken, bendGoverns);
      }
    }
  }

  return broken;
}

function breakMember(structure, m, time, out, bendGoverns) {
  m.broken = true;
  const load = m.load;                    // severity, before we zero it below
  // A break at less than the limit was not an event, it was attrition: the
  // member was worn out by sustained load (creep) rather than overwhelmed.
  const sustained = load < 1;
  m.load = 0;
  m.bendLoad = 0;
  m.waterFx = 0; m.waterFy = 0; m.waterFperp = 0;
  structure.brokenCount++;
  structure.obstructionsDirty = true;     // the water profile changes next tick

  const mode = bendGoverns ? 'bending' : (m.loadSign > 0 ? 'tension' : 'compression');
  const x = (m.a.x + m.b.x) * 0.5;
  const y = (m.a.y + m.b.y) * 0.5;
  if (!structure.firstFailure) {
    structure.firstFailure = { memberId: m.id, mode, time, x, y, sustained };
  }

  spawnDebris(structure, m);
  out.push(m);
  emit('member:break', { id: m.id, x, y, mode, matId: m.mat.id, load, sustained });
}
