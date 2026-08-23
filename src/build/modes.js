// STUB — OPUS B owns. Phase flow, objectives, win/fail, stats. Contract §10.

import { emit } from '../core/events.js';
import { getScene } from '../core/game.js';
import * as waterSim from '../physics/water.js';
import { designCost } from './builder.js';

const M = { level: null, terrain: null, done: false, stats: null };

export function initModes() {}

export function startLevel(level, terrain) {
  M.level = level; M.terrain = terrain; M.done = false; M.stats = null;
}

export function startSim() {
  M.done = false;
  M.stats = {
    retained: 1, peakDepth: 0, maxLoad: 0, brokenCount: 0,
    cost: 0, survivalTime: 0, win: false, cause: '',
  };
}

export function update(dt) {
  if (M.done || !M.stats) return;
  const S = getScene();
  const st = M.stats;
  st.survivalTime = S.simTime;
  if (S.structure) {
    st.maxLoad = S.structure.maxLoad;
    st.brokenCount = S.structure.brokenCount;
  }
  st.cost = designCost(S.design);

  const obj = M.level.objective || { type: 'survive', duration: 30 };
  if (S.simTime >= (obj.duration || 30)) {
    st.win = true;
    M.done = true;
    emit('level:win', { stats: st });
  }
}
