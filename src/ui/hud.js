// STUB — OPUS C owns. HUD DOM updates + ui:* event emission. Contract §9.

import { emit } from '../core/events.js';
import { budgetLeft, getBuilder } from '../build/builder.js';
import { MATERIALS } from '../build/materials.js';

const el = (id) => document.getElementById(id);

export function init() {
  el('btn-release').addEventListener('click', () => emit('ui:release', {}));
  el('btn-sim-retry').addEventListener('click', () => emit('ui:retry', {}));
  el('btn-sim-edit').addEventListener('click', () => emit('ui:edit', {}));
  el('btn-hud-menu').addEventListener('click', () => emit('ui:menu', {}));
  for (const b of document.querySelectorAll('.speed-btn')) {
    b.addEventListener('click', () => {
      emit('ui:speed', { v: parseFloat(b.dataset.speed) });
      document.querySelectorAll('.speed-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
  }
}

export function update(S) {
  const inGame = S.phase === 'build' || S.phase === 'sim';
  el('hud').classList.toggle('hidden', !inGame);
  if (!inGame) return;

  el('btn-release').classList.toggle('hidden', !(S.phase === 'build' && S.level.mode === 'freebuild'));
  el('sim-controls').classList.toggle('hidden', S.phase !== 'sim');
  el('toolbar').classList.toggle('hidden', S.phase !== 'build');

  el('hud-level-name').textContent = S.level ? S.level.name : '';
  el('budget-left').textContent = '$' + Math.round(budgetLeft());

  const timer = el('hud-timer');
  const showTimer = S.level && S.level.mode === 'countdown' && S.phase === 'build';
  timer.classList.toggle('hidden', !showTimer);
  if (showTimer) {
    const t = Math.max(0, S.buildTimer);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    el('timer-text').textContent = `${mm}:${ss}`;
  }
  refreshMaterialBar(S);
}

function refreshMaterialBar(S) {
  const bar = el('material-bar');
  const mats = S.level.materials || Object.keys(MATERIALS);
  if (bar.childElementCount !== mats.length) {
    bar.innerHTML = '';
    mats.forEach((id, i) => {
      const btn = document.createElement('button');
      btn.className = 'tool-btn mat-btn';
      btn.type = 'button';
      btn.textContent = MATERIALS[id].name;
      btn.style.borderColor = MATERIALS[id].color;
      btn.title = `${MATERIALS[id].name} (${i + 1})`;
      btn.addEventListener('click', () => emit('ui:material', { id }));
      bar.appendChild(btn);
    });
  }
  const current = getBuilder().material;
  [...bar.children].forEach((btn, i) => btn.classList.toggle('active', mats[i] === current));
}
