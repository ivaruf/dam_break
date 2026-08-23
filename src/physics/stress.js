// OPUS A owns. strain → load → damage → break + failure record.
// Contract: ARCHITECTURE.md §5 "Damage model". DOM-free, deterministic.
//
//   load < 0.8              safe
//   0.8 – 1.0              visible stress (render concern only)
//   1.0 – 1.2              damage += (load − 1) · damageRate · dt
//   > 1.2                  damage += (load − 1) · fastRate  · dt
//   load ≥ hardBreak       instant break
//   damage ≥ 1             break
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

export function updateStress(structure, dt, time) {
  if (!structure) return [];
  const D = CONFIG.damage;
  const broken = [];

  for (let i = 0; i < structure.members.length; i++) {
    const m = structure.members[i];
    if (m.broken || !m.mat) continue;

    const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    m.strain = (len - m.restLength) / m.restLength;
    m.loadSign = m.strain >= 0 ? 1 : -1;

    let limit;
    if (m.strain >= 0) {
      limit = m.mat.tensionLimit;
    } else if (m.tensionOnly) {
      m.load = 0;                       // slack cable carries nothing
      continue;
    } else {
      limit = compressionLimitFor(m.mat, len);
    }

    m.load = limit > 0 ? Math.abs(m.strain) / limit : 0;
    if (m.load > structure.maxLoad) structure.maxLoad = m.load;

    if (m.load >= D.hardBreak) {
      m.damage = 1;
      breakMember(structure, m, time, broken);
      continue;
    }
    if (m.load > 1) {
      const over = m.load - 1;
      const rate = m.load > D.fastAbove ? D.fastRate : D.damageRate;
      m.damage += over * rate * dt;
      if (m.damage >= 1) {
        m.damage = 1;
        breakMember(structure, m, time, broken);
      }
    }
  }

  return broken;
}

function breakMember(structure, m, time, out) {
  m.broken = true;
  const load = m.load;                    // severity, before we zero it below
  m.load = 0;
  structure.brokenCount++;
  structure.obstructionsDirty = true;     // the water profile changes next tick

  const mode = m.loadSign > 0 ? 'tension' : 'compression';
  const x = (m.a.x + m.b.x) * 0.5;
  const y = (m.a.y + m.b.y) * 0.5;
  if (!structure.firstFailure) {
    structure.firstFailure = { memberId: m.id, mode, time, x, y };
  }

  spawnDebris(structure, m);
  out.push(m);
  emit('member:break', { id: m.id, x, y, mode, matId: m.mat.id, load });
}
