'use strict';

/**
 * Unit tests for the alert engine (no network, no Electron).
 *   node scripts/test-alerts.js
 */

const { evaluate, DEFAULT_ALERTS } = require('../electron/alerts');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}
function types(alerts) { return alerts.map((a) => a.type); }

const base = { config: { appId: '3453910', gameName: 'Happy\'s Humble Burger Cult' }, game: { name: 'Happy\'s Humble Burger Cult' } };
function snap(over) { return { ...base, ...over }; }
function players(current, history) {
  return { current, available: current != null, peakSession: history ? Math.max(...history.map((h) => h.v)) : current, history: history || (current != null ? [{ t: 1, v: current }] : []) };
}
const cfg = { ...DEFAULT_ALERTS };

// 1. Launch alert fires once, then never again
{
  let st = {};
  let r = evaluate(null, snap({ players: players(42) }), st, cfg, 1000);
  ok('launch fires when players first available', types(r.alerts).includes('launch'));
  r = evaluate(snap({ players: players(42) }), snap({ players: players(50) }), r.state, cfg, 2000);
  ok('launch does not fire twice', !types(r.alerts).includes('launch'));
}

// 2. Milestones: only the highest newly-crossed step fires
{
  let st = { launched: true, peakAlerted: 40 };
  const hist = [{ t: 1, v: 40 }, { t: 2, v: 1200 }];
  const r = evaluate(snap({ players: players(40) }), snap({ players: { current: 1200, available: true, peakSession: 1200, history: hist } }), st, cfg, 3000);
  ok('milestone fires highest crossed (1000, not 100/250/500)', r.alerts.some((a) => a.type === 'milestone' && a.title.includes('1,000')));
  ok('only one milestone alert emitted', types(r.alerts).filter((t) => t === 'milestone').length === 1);
  const r2 = evaluate(snap({ players: players(1200) }), snap({ players: players(1300, [{ t: 3, v: 1200 }, { t: 4, v: 1300 }]) }), r.state, cfg, 4000);
  ok('milestone not repeated below last', !types(r2.alerts).includes('milestone'));
}

// 3. Spike up and drop (use epoch-scale timestamps like production)
{
  const T = 1700000000000;
  let st = { launched: true, peakAlerted: 1000, lastMilestone: 1000000 };
  const up = evaluate(snap({}), snap({ players: { current: 300, available: true, peakSession: 1000, history: [{ t: 1, v: 100 }, { t: 2, v: 300 }] } }), st, cfg, T);
  ok('spike-up fires on +200%', types(up.alerts).includes('spike-up'));
  const down = evaluate(snap({}), snap({ players: { current: 100, available: true, peakSession: 1000, history: [{ t: 1, v: 300 }, { t: 2, v: 100 }] } }), { ...st, lastSpikeTs: 0 }, cfg, T + 1000);
  ok('spike-down fires on -66% and is critical', down.alerts.some((a) => a.type === 'spike-down' && a.urgency === 'critical'));
  const cool = evaluate(snap({}), snap({ players: { current: 300, available: true, peakSession: 1000, history: [{ t: 1, v: 100 }, { t: 2, v: 300 }] } }), { ...st, lastSpikeTs: T }, cfg, T + 500);
  ok('spike respects cooldown', !types(cool.alerts).some((t) => t.startsWith('spike')));
  const noisy = evaluate(snap({}), snap({ players: { current: 12, available: true, peakSession: 1000, history: [{ t: 1, v: 4 }, { t: 2, v: 12 }] } }), { ...st }, cfg, T + 999999);
  ok('spike ignored below spikeMinPlayers', !types(noisy.alerts).some((t) => t.startsWith('spike')));
}

// 4. Reviews: backlog suppressed on first sight, then new ones alert; only-negative respected
{
  const withReviews = (recent, total, scoreDesc) => snap({ reviews: { recent, total, positivePct: 80, scoreDesc: scoreDesc || 'Positive' } });
  let st = { launched: true };
  let r = evaluate(null, withReviews([{ id: 'a', votedUp: true, text: 'good' }, { id: 'b', votedUp: false, text: 'bad' }], 2), st, cfg, 1000);
  ok('existing reviews seeded, not alerted as backlog', !types(r.alerts).some((t) => t.startsWith('review')));
  r = evaluate(withReviews([], 2), withReviews([{ id: 'c', votedUp: false, text: 'buggy on launch' }, { id: 'a', votedUp: true, text: 'good' }], 3), r.state, cfg, 2000);
  ok('new review alerts', r.alerts.some((a) => a.type === 'review-neg' && a.body.includes('buggy')));

  // only-negative mode
  let st2 = { launched: true, reviewsInitialized: true, seenReviewIds: ['x'] };
  const r2 = evaluate(withReviews([], 5), withReviews([{ id: 'p', votedUp: true, text: 'love it' }, { id: 'n', votedUp: false, text: 'meh' }], 7), st2, { ...cfg, reviewsOnlyNegative: true }, 3000);
  ok('only-negative skips positive reviews', types(r2.alerts).includes('review-neg') && !types(r2.alerts).includes('review-pos'));
}

// 5. First review ever (0 -> 1)
{
  let st = { launched: true, reviewsInitialized: true, seenReviewIds: [], lastReviewTotal: 0 };
  const r = evaluate(snap({ reviews: { recent: [], total: 0, positivePct: null, scoreDesc: 'No user reviews' } }),
    snap({ reviews: { recent: [{ id: 'z', votedUp: true, text: 'first!' }], total: 1, positivePct: 100, scoreDesc: '1 user reviews' } }), st, cfg, 5000);
  ok('first-review alert fires on 0->1', types(r.alerts).includes('first-review'));
}

// 6. Score band change
{
  let st = { launched: true, reviewsInitialized: true, seenReviewIds: ['q'], lastScoreDesc: 'Very Positive', lastReviewTotal: 100 };
  const r = evaluate(snap({ reviews: { recent: [{ id: 'q', votedUp: true }], total: 120, positivePct: 78, scoreDesc: 'Mostly Positive' } }),
    snap({ reviews: { recent: [{ id: 'q', votedUp: true }], total: 120, positivePct: 78, scoreDesc: 'Mostly Positive' } }), st, cfg, 6000);
  ok('score band change alerts', r.alerts.some((a) => a.type === 'score-band' && a.title.includes('Mostly Positive')));
}

// 7. Big stream, de-duplicated
{
  let st = { launched: true };
  const twitch = (id, viewers) => snap({ twitch: { enabled: true, live: [{ id, user: 'BigStreamer', viewers, title: 'Playing the cult game', url: 'https://twitch.tv/x' }] } });
  let r = evaluate(null, twitch('s1', 1500), st, cfg, 1000);
  ok('big stream alerts above threshold', types(r.alerts).includes('big-stream'));
  r = evaluate(twitch('s1', 1500), twitch('s1', 1600), r.state, cfg, 2000);
  ok('same stream not re-alerted', !types(r.alerts).includes('big-stream'));
  const small = evaluate(null, twitch('s2', 50), { launched: true }, cfg, 3000);
  ok('small stream below threshold ignored', !types(small.alerts).includes('big-stream'));
}

// 8. Master switch off
{
  const r = evaluate(null, snap({ players: players(9999) }), {}, { ...cfg, enabled: false }, 1000);
  ok('disabled engine emits nothing', r.alerts.length === 0);
}

// 9. Spike alerts carry attribution
{
  const T = 1700000000000;
  const st = { launched: true, peakAlerted: 1000, lastMilestone: 1000000 };
  const next = snap({
    players: { current: 300, available: true, peakSession: 1000, history: [{ t: 1, v: 100 }, { t: 2, v: 300 }] },
    twitch: { enabled: true, live: [{ id: 's9', user: 'Northernlion', viewers: 12400, title: 'burgers', url: 'https://twitch.tv/nl', startedAt: T - 8 * 60000 }] }
  });
  const r = evaluate(snap({}), next, st, cfg, T);
  const spike = r.alerts.find((a) => a.type === 'spike-up');
  ok('spike alert carries causes', spike && Array.isArray(spike.causes) && spike.causes.length > 0);
  ok('spike body names the likely cause', spike && /Northernlion/.test(spike.body));

  // A drop with nothing to blame must say so rather than invent a cause.
  const drop = evaluate(snap({}), snap({
    players: { current: 100, available: true, peakSession: 1000, history: [{ t: 1, v: 300 }, { t: 2, v: 100 }] }
  }), { ...st, lastSpikeTs: 0 }, cfg, T + 1000);
  const down = drop.alerts.find((a) => a.type === 'spike-down');
  ok('unattributed drop says no clear cause', down && /no clear cause/i.test(down.body));
}

// 10. Complaint surge
{
  const T = 1700000000000;
  const themes = [{ key: 'crash', label: 'Crashes', count: 12, last24: 10, prior24: 2, recent48: 12, prior48: 2, trend: 6 }];
  const st = { launched: true, reviewsInitialized: true, seenReviewIds: [] };
  const r = evaluate(null, snap({ reviewIntel: { themes } }), st, cfg, T);
  ok('complaint surge fires', types(r.alerts).includes('complaint-surge'));
  ok('complaint surge is critical', r.alerts.some((a) => a.type === 'complaint-surge' && a.urgency === 'critical'));
  ok('complaint surge names the theme', r.alerts.some((a) => a.type === 'complaint-surge' && a.title.includes('Crashes')));

  const r2 = evaluate(null, snap({ reviewIntel: { themes } }), r.state, cfg, T + 60000);
  ok('complaint surge respects cooldown', !types(r2.alerts).includes('complaint-surge'));
  const r3 = evaluate(null, snap({ reviewIntel: { themes } }), r.state, cfg, T + 7 * 3600000);
  ok('complaint surge fires again after cooldown', types(r3.alerts).includes('complaint-surge'));

  const quiet = [{ key: 'crash', label: 'Crashes', count: 4, last24: 3, prior24: 2, recent48: 4, prior48: 2, trend: 2 }];
  ok('small complaint counts do not surge',
    !types(evaluate(null, snap({ reviewIntel: { themes: quiet } }), { launched: true }, cfg, T).alerts).includes('complaint-surge'));

  const flat = [{ key: 'crash', label: 'Crashes', count: 40, last24: 10, prior24: 9, recent48: 20, prior48: 20, trend: 1 }];
  ok('a steady complaint level does not surge',
    !types(evaluate(null, snap({ reviewIntel: { themes: flat } }), { launched: true }, cfg, T).alerts).includes('complaint-surge'));

  ok('complaint surge can be disabled',
    !types(evaluate(null, snap({ reviewIntel: { themes } }), { launched: true }, { ...cfg, complaintSurge: false }, T).alerts).includes('complaint-surge'));
  ok('missing reviewIntel does not throw',
    evaluate(null, snap({ players: players(10) }), { launched: true }, cfg, T).alerts != null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
