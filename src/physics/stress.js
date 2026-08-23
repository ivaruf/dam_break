// STUB — OPUS A owns. Strain → load → damage → break. Contract §5. DOM-free.

import { emit } from '../core/events.js';

export function updateStress(structure, dt, time) {
  const broken = [];
  for (const m of structure.members) {
    if (m.broken || !m.mat) continue;
    const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    m.strain = (len - m.restLength) / m.restLength;
    const limit = m.strain >= 0 ? m.mat.tensionLimit : m.mat.compressionLimit;
    m.loadSign = m.strain >= 0 ? 1 : -1;
    m.load = Math.abs(m.strain) / limit;
    structure.maxLoad = Math.max(structure.maxLoad, m.load);
    if (m.load > 1.2) {
      m.broken = true;
      structure.brokenCount++;
      const mode = m.loadSign > 0 ? 'tension' : 'compression';
      const x = (m.a.x + m.b.x) / 2, y = (m.a.y + m.b.y) / 2;
      if (!structure.firstFailure) structure.firstFailure = { memberId: m.id, mode, time, x, y };
      emit('member:break', { id: m.id, x, y, mode, matId: m.mat.id });
      broken.push(m);
    }
  }
  return broken;
}
