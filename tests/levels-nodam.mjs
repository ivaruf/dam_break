// A level that can be WON by building nothing is broken. Runs every level to
// completion with an empty design and reports the outcome modes.js reaches.
import { readFileSync } from 'fs';
const head = readFileSync(new URL('ui-smoke.mjs', import.meta.url), 'utf8').split('// ---- run --')[0];
await import('data:text/javascript,' + encodeURIComponent(head));

// Repo root as a file: URL, derived from this file's own location, so the
// harness runs from any cwd.
const ROOT = new URL('../', import.meta.url).href.replace(/\/$/, '');
const game = await import(ROOT + '/src/core/game.js');
const { on } = await import(ROOT + '/src/core/events.js');
const { LEVELS } = await import(ROOT + '/src/levels/levels.js');
const canvas = document.getElementById('game');
game.boot(canvas);

let outcome = null;
on('level:win', ({ stats }) => { outcome = { win: true, stats }; });
on('level:fail', ({ stats }) => { outcome = { win: false, stats }; });

let broken = 0;
let now = 0;   // MUST be monotonic across levels: game.js keeps lastNow module-level,
               // so restarting the clock makes dtReal negative and nothing ticks
for (let i = 1; i <= LEVELS.length; i++) {
  outcome = null;
  game.loadLevel(i);
  const S = game.getScene();
  const dur = (S.level.objective && S.level.objective.duration) || 30;
  game.release();
  game.setSpeed(4);
  const maxFrames = Math.ceil(((dur + 8) / 4) / 0.0167) + 60;
  for (let f = 0; f < maxFrames && !outcome; f++) { now += 16.7; game.frame(now); }

  const st = outcome ? outcome.stats : (S.stats || {});
  // A sandbox has no buildZone and a bare 'survive' objective, so modes.js never
  // scores retention: surviving it with nothing built is CORRECT, not a bug.
  const isSandbox = !S.level.buildZone && S.level.objective.type === 'survive' &&
    S.level.objective.minRetention === undefined;
  const verdict = !outcome ? 'NO VERDICT (timed out)'
    : outcome.win ? (isSandbox ? 'survived (expected: sandbox)' : 'WON WITH NO DAM  <-- BROKEN')
      : 'failed (correct)';
  if (!outcome || (outcome.win && !isSandbox)) broken++;
  console.log(
    String(i).padStart(2), (S.level.id || '').padEnd(10),
    (S.level.objective.type || '').padEnd(7),
    'retained ' + (st.retained !== undefined ? (st.retained * 100).toFixed(0) + '%' : '?').padEnd(5),
    'peak ' + (st.peakDepth || 0).toFixed(1) + 'm',
    ' ', verdict,
    outcome && !outcome.win ? '| ' + String(st.cause).slice(0, 52) : '');
}
console.log('\ncampaign levels winnable by doing nothing:', broken, broken ? '<-- FIX THESE' : '(correct)');
