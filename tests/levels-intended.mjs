// OPUS C. THE REGRESSION CONTRACT FOR THE CAMPAIGN.
//
// Every level's `// intended solution:` comment in src/levels/levels.js is
// encoded below as a scripted design. Each one must WIN its level, and must
// cost between COST_MIN and COST_MAX of that level's budget — tight enough
// that the budget still means something, loose enough that a player who builds
// the right shape a bit wastefully still clears it.
//
// If a level ever fails here, RETUNE THE LEVEL (flood volume, terrain, budget),
// never the assertion. The whole point is that the campaign cannot drift into
// being unwinnable-by-design without this going red.
//
//   node tests/levels-intended.mjs
//
// Params map onto engineered() in levels-designs.mjs:
//   col/span/brace/tie = material per structural role
//   crest              = target crest elevation (world y, metres)
//   dy                 = row spacing; xMin/xMax = restrict to some anchors
//
// `crest` is a TARGET: engineered() rounds it up to a whole number of dy rows
// above the highest column foot, so the dam actually built can stand up to one
// row higher than the number here. The crests quoted in the levels.js comments
// are the BUILT ones.

import { boot, simulate, engineered, fmt } from './levels-designs.mjs';

export const INTENDED = {
  1:  { crest: 6.2,  col: 'timber',   span: 'timber', brace: 'timber', dy: 0.8,
        note: 'braced timber wall on the short 2.5 m sill' },
  2:  { crest: 7.4,  col: 'timber',   span: 'timber', brace: 'timber', dy: 0.8,
        note: 'braced timber wall, 4 rows, 3.5 m sill' },
  3:  { crest: 9.8,  col: 'concrete', span: 'steel',  brace: 'steel',  dy: 1.0,
        note: 'pier on the channel bed + concrete columns, steel bracing' },
  4:  { crest: 7.4,  col: 'concrete', span: 'steel',  brace: 'steel', tie: 'cable', dy: 0.9,
        note: 'concrete columns founded in the pit, steel rungs, cable tie' },
  // 5's crest is TALL (built 10.1 m on a 3.8 m sill) because the basin barely
  // exceeds the wave: under the particle fluid the reservoir settles near 9 m,
  // so anything shorter is topped no matter how strong it is.
  5:  { crest: 10.0, col: 'steel',    span: 'steel',  brace: 'steel',  dy: 0.9,
        note: 'steel throughout — timber bracing splits under the impact' },
  6:  { crest: 7.4,  col: 'timber',   span: 'steel',  brace: 'cable',  dy: 0.9,
        note: 'two piers, steel rungs, CABLE diagonals (the money lesson)' },
  7:  { crest: 8.6,  col: 'timber',   span: 'timber', brace: 'timber', dy: 0.8, xMin: 37,
        note: 'the cheap upper-bench wall only' },
  8:  { crest: 8.2,  col: 'timber',   span: 'steel',  brace: 'steel',  dy: 0.9,
        note: 'the level-3 shape, built fast' },
  9:  { crest: 7.2,  col: 'timber',   span: 'steel',  brace: 'timber', dy: 0.8,
        note: 'deliberately MODEST crest — the notch takes the overflow' },
  10: { crest: 13.2, col: 'concrete', span: 'steel',  brace: 'steel', tie: 'cable', dy: 1.0,
        note: 'two piers, concrete columns, steel bracing, cable corner ties' },
};

const COST_MIN = 0.55;
const COST_MAX = 0.85;

const { LEVELS } = await boot();

let fails = 0;
console.log('intended solutions — must WIN, cost within ' +
  (COST_MIN * 100) + '-' + (COST_MAX * 100) + '% of budget\n');

for (const key of Object.keys(INTENDED)) {
  const i = Number(key);
  const spec = LEVELS[i - 1];
  const p = INTENDED[i];
  const r = simulate(i, (S) => engineered(S, p));
  const ratio = r.budget > 0 ? r.cost / r.budget : 0;

  // Only BUDGET refusals matter: they mean the intended design does not fit
  // the money. A length refusal is just the generic builder declining a member
  // this particular site does not need (a zero-height column sub-segment, or a
  // corner tie longer than cable allows) — the design is still complete.
  const overBudget = r.refused.filter((x) => x.indexOf('over budget') >= 0);
  const lengthRefusals = r.refused.filter((x) => x.indexOf('over budget') < 0);

  const problems = [];
  if (!r.win) problems.push('DID NOT WIN (' + String(r.cause).slice(0, 44) + ')');
  if (ratio < COST_MIN) problems.push('too cheap: ' + (ratio * 100).toFixed(0) + '% of budget');
  if (ratio > COST_MAX) problems.push('too expensive: ' + (ratio * 100).toFixed(0) + '% of budget');
  if (overBudget.length) problems.push(overBudget.length + " member(s) didn't fit the budget");
  if (problems.length) fails++;

  console.log(
    String(i).padStart(2) + ' ' + (spec.id || '').padEnd(10) +
    (r.win ? 'WIN ' : 'FAIL') +
    ' $' + String(Math.round(r.cost)).padStart(6) + '/' + String(r.budget).padEnd(6) +
    '=' + String(Math.round(ratio * 100)).padStart(3) + '%' +
    ' mem' + String(r.memberCount).padStart(3) +
    ' load' + fmt.pct(r.maxLoad) + ' brk' + String(r.broken).padStart(2) +
    ' ret' + fmt.pct(r.retained) +
    ' peak' + fmt.m(r.peakSurface) +
    (problems.length ? '\n     !! ' + problems.join('; ') : ''));
  if (!problems.length) console.log('     ' + p.note);
  if (lengthRefusals.length) {
    console.log('     (declined, harmless: ' + lengthRefusals.slice(0, 3).join(', ') +
      (lengthRefusals.length > 3 ? ', +' + (lengthRefusals.length - 3) : '') + ')');
  }
}

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'all intended solutions win within budget'));
process.exit(fails ? 1 : 0);
