// Persistent progress + preferences via localStorage. FABLE owns.

const KEY = 'dam-builder-save-v1';

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}

function load() {
  try {
    const raw = storage() && storage().getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted or unavailable: start fresh */ }
  return { unlocked: 1, best: {}, prefs: { showHints: true } };
}

export const save = load();

export function persist() {
  try { const s = storage(); if (s) s.setItem(KEY, JSON.stringify(save)); } catch { /* ignore */ }
}

// levelIndex is 1-based position in the campaign order.
export function recordResult(levelId, levelIndex, stats) {
  if (stats.win) {
    save.unlocked = Math.max(save.unlocked, levelIndex + 1);
    const prev = save.best[levelId];
    if (!prev || (stats.cost !== undefined && stats.cost < prev.cost)) {
      save.best[levelId] = { cost: stats.cost, retained: stats.retained, broken: stats.brokenCount };
    }
  }
  persist();
}

export function isUnlocked(levelIndex) { return levelIndex <= save.unlocked; }
export function bestFor(levelId) { return save.best[levelId] || null; }
