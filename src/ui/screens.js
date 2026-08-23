// STUB — OPUS C owns. DOM screens: title, level select, result. Contract §9.

import { emit, on } from '../core/events.js';
import { LEVELS } from '../levels/levels.js';
import { isUnlocked } from '../core/state.js';

const el = (id) => document.getElementById(id);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  if (id) el(id).classList.remove('hidden');
}

export function init() {
  el('btn-play').addEventListener('click', () => { buildLevelGrid(); show('screen-levels'); });
  el('btn-sandbox').addEventListener('click', () => emit('ui:level', { index: LEVELS.length }));
  el('btn-levels-back').addEventListener('click', () => show('screen-title'));
  el('btn-result-retry').addEventListener('click', () => emit('ui:retry', {}));
  el('btn-result-edit').addEventListener('click', () => emit('ui:edit', {}));
  el('btn-result-menu').addEventListener('click', () => { buildLevelGrid(); show('screen-levels'); });
  el('btn-result-next').addEventListener('click', () => emit('ui:next-level', {}));

  on('phase:change', ({ phase }) => {
    if (phase === 'title') show('screen-title');
    else if (phase === 'levelselect') { buildLevelGrid(); show('screen-levels'); }
    else if (phase === 'result') showResult();
    else show(null);
  });
}

function buildLevelGrid() {
  const grid = el('level-grid');
  grid.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const btn = document.createElement('button');
    btn.className = 'small-btn level-btn';
    btn.type = 'button';
    const locked = !isUnlocked(i + 1);
    btn.textContent = locked ? '🔒 ' + (i + 1) : `${i + 1}. ${lv.name}`;
    btn.disabled = locked;
    btn.addEventListener('click', () => emit('ui:level', { index: i + 1 }));
    grid.appendChild(btn);
  });
}

function showResult() {
  import('../core/game.js').then(({ getScene }) => {
    const S = getScene();
    const st = S.stats || {};
    el('result-heading').textContent = st.win ? 'DAM HELD' : 'DAM FAILED';
    el('result-heading').style.color = st.win ? '#7fff9a' : '#ff5a3c';
    el('result-cause').classList.toggle('hidden', st.win || !st.cause);
    el('result-cause').textContent = st.cause || '';
    el('result-stats').innerHTML = '';
    const rows = [
      ['Water retained', Math.round((st.retained ?? 1) * 100) + '%'],
      ['Peak reservoir depth', (st.peakDepth ?? 0).toFixed(1) + ' m'],
      ['Maximum stress', Math.round((st.maxLoad ?? 0) * 100) + '%'],
      ['Members broken', st.brokenCount ?? 0],
      ['Construction cost', '$' + Math.round(st.cost ?? 0)],
      ['Survival time', (st.survivalTime ?? 0).toFixed(1) + ' s'],
    ];
    for (const [k, v] of rows) {
      const kd = document.createElement('div'); kd.textContent = k;
      const vd = document.createElement('div'); vd.textContent = v;
      el('result-stats').append(kd, vd);
    }
    show('screen-result');
  });
}
