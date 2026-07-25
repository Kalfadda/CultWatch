'use strict';

/**
 * Unit tests for the tinyBuild publisher cohort — review-summary parsing and
 * the pure ranking layer (no network, no Electron).
 *   node scripts/test-tinybuild.js
 */

const { summarize } = require('../electron/services/steam');
const { rankCohort } = require('../electron/services/tinybuild');

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

// ============================================================
// 2. Ranking
// ============================================================
const DAY = 86400000;
const NOW = Date.parse('2026-07-24T00:00:00Z');

function row(appId, count, pct, total, releasedAt) {
  return {
    appId, name: 'App ' + appId,
    count, ccuAvailable: count != null,
    reviews: pct == null ? null : { total: total || 100, positivePct: pct, scoreDesc: 'x' },
    releasedAt: releasedAt === undefined ? NOW - 30 * DAY : releasedAt,
    error: null
  };
}

{
  const r = rankCohort([
    row('1', 100, 50),
    row('us', 500, 80),
    row('3', 900, 60)
  ], 'us', NOW, 365);

  ok('momentum ranks by descending players', r.momentum.rows.map((x) => x.appId).join() === '3,us,1');
  ok('our momentum rank is right', r.momentum.ourRank === 2);
  ok('momentum counts every ranked row', r.momentum.ourOf === 3);
  ok('reception ranks by descending pct', r.reception.rows.map((x) => x.appId).join() === 'us,3,1');
  ok('our reception rank is right', r.reception.ourRank === 1);
  ok('the momentum leader is exposed', r.momentum.leader.appId === '3');
  ok('us is flagged on exactly one row', r.momentum.rows.filter((x) => x.us).length === 1);
  ok('share of cohort CCU is our slice of the total', r.shareOfCcu === Math.round((500 / 1500) * 100));
  ok('cohort size counts every row', r.cohortSize === 3);
}

// Unranked rows sort last, keep rank null, and are still returned.
{
  const r = rankCohort([
    row('dead', null, null),
    row('us', 10, 70),
    row('live', 20, 90)
  ], 'us', NOW, 365);

  ok('a row with no CCU sorts last on momentum', r.momentum.rows[2].appId === 'dead');
  ok('a row with no CCU is unranked', r.momentum.rows[2].rank === null);
  ok('an unranked row is still returned', r.momentum.rows.length === 3);
  ok('unranked rows are excluded from the denominator', r.momentum.ourOf === 2);
  ok('a row with no reviews sorts last on reception', r.reception.rows[2].appId === 'dead');
  ok('ranks are 1-based and contiguous', r.momentum.rows[0].rank === 1 && r.momentum.rows[1].rank === 2);
}

// Reception ties break toward the title with more reviews.
{
  const r = rankCohort([
    row('few', null, 90, 10),
    row('many', null, 90, 5000)
  ], 'us', NOW, 365);
  ok('a tied pct breaks by review volume', r.reception.rows[0].appId === 'many');
}

// Window flagging, at the boundary.
{
  const r = rankCohort([
    row('inside', 5, 50, 100, NOW - 364 * DAY),
    row('edge', 5, 50, 100, NOW - 365 * DAY),
    row('outside', 5, 50, 100, NOW - 366 * DAY),
    row('undated', 5, 50, 100, null)
  ], 'us', NOW, 365);
  const by = Object.fromEntries(r.momentum.rows.map((x) => [x.appId, x.outsideWindow]));
  ok('a title inside the window is not flagged', by.inside === false);
  ok('a title exactly at the window edge is not flagged', by.edge === false);
  ok('a title past the window is flagged', by.outside === true);
  ok('a title with no known date is not flagged', by.undated === false);
  ok('flagged count is reported', r.flagged === 1);
}

// Degenerate cohorts.
{
  const empty = rankCohort([], 'us', NOW, 365);
  ok('an empty cohort does not throw', empty.cohortSize === 0);
  ok('an empty cohort has no rank', empty.momentum.ourRank === null);
  ok('an empty cohort has a null share', empty.shareOfCcu === null);
  ok('an empty cohort has no read line', empty.readLine === null);

  const junk = rankCohort([null, { name: 'no id' }, row('ok', 1, 50)], 'us', NOW, 365);
  ok('malformed entries are dropped', junk.cohortSize === 1);

  const zero = rankCohort([row('a', 0, 50), row('us', 0, 50)], 'us', NOW, 365);
  ok('an all-zero cohort yields a null share, not NaN', zero.shareOfCcu === null);

  const absent = rankCohort([row('a', 5, 50)], 'us', NOW, 365);
  ok('our rank is null when we are not in the cohort', absent.momentum.ourRank === null);
  ok('share is null when we are not in the cohort', absent.shareOfCcu === null);

  const allDead = rankCohort([row('a', null, null), row('b', null, null)], 'us', NOW, 365);
  ok('an all-unavailable cohort ranks nobody', allDead.momentum.ourOf === 0);
  ok('an all-unavailable cohort has no leader', allDead.momentum.leader === null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
