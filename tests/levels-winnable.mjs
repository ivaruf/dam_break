// OPUS C. THE DIFFICULTY FLOOR FOR THE CAMPAIGN.
//
// "Naive" = what an untutored player builds: ONE column per anchor, ONE
// material for every structural role, a flat crest, sometimes without
// diagonals, sometimes just a stack of posts. The sweep includes the tallest
// such wall each budget can actually complete, so a level can never pass here
// merely because the preset list was capped too low.
//
// CONTRACT: the naive sweep may clear ONLY the teaching levels (1, 2, 7).
// Every other campaign level must defeat all of it, and must defeat it for
// that level's own teaching reason — so the failure CAUSE is asserted too, not
// just the win/lose bit.
//
//   node tests/levels-winnable.mjs
//
// If this goes red the campaign has drifted: either a level got too easy, or a
// level that is supposed to be gentle got too hard.

import { boot, simulate, engineered, naivePresets, fmt } from './levels-designs.mjs';

// Levels where a naive braced wall is SUPPOSED to be enough.
const NAIVE_MAY_WIN = new Set([1, 2, 7]);

// The teaching reason each level must fail for. Matched against modes.js cause
// lines (upper case); a naive attempt failing for none of these means the level
// is hard for the wrong reason.
const EXPECTED_CAUSE = {
  3:  ['OVERTOP', 'BREACH', 'RETAINED'],           // sill too long to span -> leaky/short face
  4:  ['BREACH', 'OVERTOP', 'RETAINED'],           // cannot reach across the pit
  5:  ['TENSION', 'COMPRESSION', 'COLLAPSE', 'BREACH', 'OVERTOP', 'RETAINED'], // the wave
  6:  ['OVERTOP', 'BREACH', 'RETAINED'],           // budget cannot buy the naive crossing
  8:  ['OVERTOP', 'BREACH', 'RETAINED'],           // heavy flood, no time to fix a leak
  9:  ['FLOODED DOWNSTREAM'],                      // open face dumps water on the village
  10: ['OVERTOP', 'BREACH', 'RETAINED', 'COLLAPSE'], // a stub cannot hold the finale
  // NOTE: the naive sweep CLEARS the design first, so on 11 it is really
  // playing "demolish the old dam, build a naive wall" — which cannot close
  // the 8 m sill any more than the wall on 4 could reach across the pit.
  11: ['BREACH', 'OVERTOP', 'RETAINED'],           // from scratch, nothing spans the sill
  12: ['BREACH', 'OVERTOP', 'RETAINED'],           // concrete cannot rung 5.5 m; cable seals nothing
  13: ['BREACH', 'OVERTOP', 'RETAINED', 'SUSTAINED', 'COLLAPSE'], // open face, then surge two
};

const { LEVELS } = await boot();
let fails = 0;
const problem = (m) => { console.log('     !! ' + m); fails++; };

console.log('naive sweep — may clear ONLY levels ' + [...NAIVE_MAY_WIN].join(', ') + '\n');

for (let i = 1; i <= LEVELS.length - 1; i++) {
  const lv = LEVELS[i - 1];
  const runs = naivePresets(lv).map((n) => ({ n, r: simulate(i, n.build) }));
  const wins = runs.filter((x) => x.r.win).sort((a, b) => a.r.cost - b.r.cost);
  const mayWin = NAIVE_MAY_WIN.has(i);

  // the closest attempt: highest retention, i.e. the most convincing near-miss
  const best = runs.slice().sort((a, b) => (b.r.retained || 0) - (a.r.retained || 0))[0];

  console.log(String(i).padStart(2) + ' ' + (lv.id || '').padEnd(10) +
    (mayWin ? '[teaching] ' : '[must fail] ') +
    'naive wins ' + wins.length + '/' + runs.length);

  if (mayWin) {
    if (!wins.length) {
      problem('a teaching level must stay clearable by a naive braced wall — ' +
        'closest: ' + best.n.label + ' ret' + fmt.pct(best.r.retained) +
        ' -> ' + String(best.r.cause).slice(0, 40));
    } else {
      const w = wins[0];
      console.log('     cheapest naive win: ' + w.n.label + ' $' + Math.round(w.r.cost) +
        '/' + w.r.budget + ' ret' + fmt.pct(w.r.retained));
    }
    continue;
  }

  if (wins.length) {
    problem(wins.length + ' naive build(s) cleared it, e.g. ' + wins[0].n.label +
      ' $' + Math.round(wins[0].r.cost) + '/' + wins[0].r.budget +
      ' ret' + fmt.pct(wins[0].r.retained) + ' crest' + fmt.m(wins[0].r.crest));
    continue;
  }

  // it failed — but did it fail for the right reason?
  const want = EXPECTED_CAUSE[i] || [];
  const cause = String(best.r.cause || '').toUpperCase();
  const matched = want.some((k) => cause.indexOf(k) >= 0);
  console.log('     closest: ' + best.n.label.padEnd(26) + ' ret' + fmt.pct(best.r.retained) +
    ' brk' + best.r.broken + ' crest' + fmt.m(best.r.crest) + ' peak' + fmt.m(best.r.peakSurface));
  console.log('     because: ' + String(best.r.cause).slice(0, 68));
  if (!matched) {
    problem('failed for the wrong reason — expected one of [' + want.join(', ') + ']');
  }
}

// ---- level 5 is a contrast, not just a difficulty -----------------------
// The whole lesson is that the SAME geometry survives in steel and breaks in
// timber. Assert both halves, or the level teaches nothing.
console.log('\nlevel 5 — the wave must break timber and spare steel:');
{
  // same geometry both times (the intended crest) — only the material changes.
  // KEEP IN SYNC with INTENDED[5] in tests/levels-intended.mjs: the contrast is
  // only honest if both sides are built to the shape the level actually teaches.
  const shape = { crest: 10.0, dy: 0.9 };
  const timber = simulate(5, (S) => engineered(S, { ...shape, col: 'timber', span: 'timber', brace: 'timber' }));
  const steel = simulate(5, (S) => engineered(S, { ...shape, col: 'steel', span: 'steel', brace: 'steel' }));
  console.log('   timber columns: ' + (timber.win ? 'WIN ' : 'FAIL') + ' brk' + timber.broken +
    ' load' + fmt.pct(timber.maxLoad) + ' ret' + fmt.pct(timber.retained) +
    ' | ' + String(timber.cause).slice(0, 44));
  console.log('   steel  columns: ' + (steel.win ? 'WIN ' : 'FAIL') + ' brk' + steel.broken +
    ' load' + fmt.pct(steel.maxLoad) + ' ret' + fmt.pct(steel.retained) +
    ' | ' + String(steel.cause).slice(0, 44));
  if (!steel.win) problem('the steel-column dam must survive the wave');
  if (timber.win) problem('the timber-column dam must NOT survive the wave');
  else if (timber.broken < 1) problem('timber must physically BREAK (broken >= 1), not merely leak');
}

// ---- level 12 is about the ties, not just the pier ------------------------
// The same all-concrete face stands with cable corner ties and overturns as
// one piece without them — tension in the upstream column, cracked members.
// KEEP IN SYNC with INTENDED[12] in tests/levels-intended.mjs.
console.log('\nlevel 12 — the stone face must need its rope:');
{
  const shape = { crest: 8.2, col: 'concrete', span: 'concrete', brace: 'cable', dy: 0.85 };
  const tied = simulate(12, (S) => engineered(S, { ...shape, tie: 'cable' }));
  const untied = simulate(12, (S) => engineered(S, shape));
  console.log('   with ties:    ' + (tied.win ? 'WIN ' : 'FAIL') + ' load' + fmt.pct(tied.maxLoad) +
    ' brk' + tied.broken + ' ret' + fmt.pct(tied.retained));
  console.log('   without ties: ' + (untied.win ? 'WIN ' : 'FAIL') + ' load' + fmt.pct(untied.maxLoad) +
    ' brk' + untied.broken + ' ret' + fmt.pct(untied.retained) +
    ' | ' + String(untied.cause).slice(0, 44));
  if (!tied.win) problem('the tied concrete face must stand');
  if (untied.win) problem('the untied concrete face must NOT stand (the tie is the lesson)');
}

// ---- level 13 punishes building for surge one ------------------------------
// The intended crest holds both surges; ONE ROW SHORT is enough for surge one
// and is overtopped by surge two's runup; the same shape in ALL TIMBER breaks
// at the waterline under the moving front and bleeds out before the clock.
// KEEP IN SYNC with INTENDED[13] in tests/levels-intended.mjs.
console.log('\nlevel 13 — surge two must collect what surge one excused:');
{
  const shape = { col: 'timber', span: 'steel', brace: 'steel', dy: 0.9 };
  const tall = simulate(13, (S) => engineered(S, { ...shape, crest: 9.3 }));
  const short = simulate(13, (S) => engineered(S, { ...shape, crest: 8.4 }));
  const timber = simulate(13, (S) => engineered(S, { crest: 9.3, col: 'timber', span: 'timber', brace: 'timber', dy: 0.9 }));
  console.log('   full height:   ' + (tall.win ? 'WIN ' : 'FAIL') + ' ret' + fmt.pct(tall.retained) +
    ' load' + fmt.pct(tall.maxLoad) + ' brk' + tall.broken);
  console.log('   one row short: ' + (short.win ? 'WIN ' : 'FAIL') + ' ret' + fmt.pct(short.retained) +
    ' | ' + String(short.cause).slice(0, 44));
  console.log('   all timber:    ' + (timber.win ? 'WIN ' : 'FAIL') + ' ret' + fmt.pct(timber.retained) +
    ' brk' + timber.broken + ' | ' + String(timber.cause).slice(0, 44));
  if (!tall.win) problem('the full-height steel-braced dam must hold both surges');
  if (short.win) problem('one row short must NOT survive surge two (margin is the lesson)');
  if (timber.win) problem('the all-timber copy must NOT survive the moving front');
  else if (timber.broken < 1) problem('all-timber must physically BREAK under surge two');
}

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'difficulty floor holds'));
process.exit(fails ? 1 : 0);
