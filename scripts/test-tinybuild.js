'use strict';

/**
 * Unit tests for the tinyBuild publisher cohort — review-summary parsing and
 * the pure ranking layer (no network, no Electron).
 *   node scripts/test-tinybuild.js
 */

const { summarize } = require('../electron/services/steam');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

// ============================================================
// 1. Review summary parsing
// ============================================================
{
  const s = summarize({ query_summary: {
    review_score: 8, review_score_desc: 'Very Positive',
    total_reviews: 345, total_positive: 290, total_negative: 55
  } });
  ok('total is read', s.total === 345);
  ok('positive pct rounds', s.positivePct === 84);
  ok('score description is read', s.scoreDesc === 'Very Positive');

  const empty = summarize({ query_summary: { total_reviews: 0 } });
  ok('zero reviews yields a null pct, not a divide-by-zero', empty.positivePct === null);
  ok('zero reviews still describes itself', empty.scoreDesc === 'No user reviews');

  ok('a missing query_summary does not throw', summarize({}).total === 0);
  ok('null input does not throw', summarize(null).total === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
