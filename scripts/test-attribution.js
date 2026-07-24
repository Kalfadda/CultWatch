'use strict';

/**
 * Unit tests for spike attribution (pure — no network, no Electron).
 *   node scripts/test-attribution.js
 */

const { attribute, describeCauses } = require('../electron/attribution');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

const T = new Date('2026-07-24T20:00:00Z').getTime();
const MIN = 60000;

// ============================================================
// 1. Ranking and windowing
// ============================================================
{
  const snap = {
    twitch: { enabled: true, live: [
      { id: 's1', user: 'BigStreamer', viewers: 12400, title: 'playing the cult game', url: 'https://twitch.tv/big', startedAt: T - 8 * MIN },
      { id: 's2', user: 'Nobody', viewers: 3, title: 'chill stream', url: 'https://twitch.tv/no', startedAt: T - 5 * MIN },
      { id: 's3', user: 'Yesterday', viewers: 50000, title: 'old stream', url: 'https://twitch.tv/old', startedAt: T - 300 * MIN }
    ] },
    reddit: [{ title: 'This game is amazing', score: 900, comments: 120, created: T - 12 * MIN, url: 'https://reddit.com/x', subreddit: 'gaming' }],
    bluesky: [],
    x: { posts: [] },
    youtube: { videos: [] },
    news: [{ id: 'n1', title: 'Patch 1.2 is live', date: T - 3 * MIN, url: 'https://store.steampowered.com/news/1', source: 'Steam' }],
    web: []
  };

  const causes = attribute({ t: T, direction: 'up' }, snap);
  ok('returns candidates', causes.length > 0);
  ok('excludes items outside the window', !causes.some((c) => c.label.includes('Yesterday')));
  ok('the biggest stream ranks first', causes[0].label.includes('BigStreamer'));
  ok('caps at three causes', causes.length <= 3);
  ok('every cause carries a timestamp', causes.every((c) => typeof c.ts === 'number'));
  ok('every cause carries a url', causes.every((c) => typeof c.url === 'string'));
  ok('every cause carries a kind', causes.every((c) => typeof c.kind === 'string'));
  ok('causes are sorted by score desc', causes.every((c, i, a) => i === 0 || a[i - 1].score >= c.score));
  ok('describeCauses names the top cause', /BigStreamer/.test(describeCauses(causes)));
  ok('describeCauses counts the remainder', /\+\d+ more/.test(describeCauses(causes)));

  const wide = attribute({ t: T, direction: 'up' }, snap, { limit: 10 });
  ok('a higher limit returns more causes', wide.length > causes.length);
  ok('news is picked up', wide.some((c) => c.kind === 'news'));
  ok('reddit is picked up', wide.some((c) => c.kind === 'reddit'));
  ok('the tiny stream ranks below the big one',
    wide.findIndex((c) => c.label.includes('Nobody')) > wide.findIndex((c) => c.label.includes('BigStreamer')));
}

// ============================================================
// 2. Window boundaries
// ============================================================
{
  const mk = (offsetMin) => ({
    twitch: { enabled: true, live: [{ id: 'a', user: 'S', viewers: 100, title: 't', url: 'u', startedAt: T + offsetMin * MIN }] },
    reddit: [], bluesky: [], x: { posts: [] }, youtube: { videos: [] }, news: [], web: []
  });
  ok('an event exactly at the window edge is included', attribute({ t: T, direction: 'up' }, mk(-20)).length === 1);
  ok('an event just outside the window is excluded', attribute({ t: T, direction: 'up' }, mk(-21)).length === 0);
  ok('an event slightly after the spike still counts', attribute({ t: T, direction: 'up' }, mk(5)).length === 1);
  ok('a custom window is respected',
    attribute({ t: T, direction: 'up' }, mk(-30), { windowMs: 40 * MIN }).length === 1);
}

// ============================================================
// 3. Drops
// ============================================================
{
  const snap = {
    twitch: { enabled: true, live: [{ id: 's1', user: 'Big', viewers: 9000, title: 't', url: 'u', startedAt: T - 2 * MIN }] },
    reddit: [], bluesky: [], x: { posts: [] }, youtube: { videos: [] }, news: [], web: []
  };
  ok('drops ignore stream starts', attribute({ t: T, direction: 'down' }, snap).length === 0);

  const withNews = { ...snap, news: [{ id: 'n', title: 'Servers down', date: T - MIN, url: 'u', source: 'Steam' }] };
  ok('drops still consider news', attribute({ t: T, direction: 'down' }, withNews).length === 1);
}

// ============================================================
// 4. Degenerate input
// ============================================================
{
  const empty = { twitch: { enabled: false, live: [] }, reddit: [], bluesky: [], x: { posts: [] }, youtube: { videos: [] }, news: [], web: [] };
  ok('no candidates yields an empty array', attribute({ t: T, direction: 'up' }, empty).length === 0);
  ok('empty causes describe as no clear cause', /no clear cause/i.test(describeCauses([])));
  ok('null causes describe as no clear cause', /no clear cause/i.test(describeCauses(null)));
  ok('missing snapshot does not throw', attribute({ t: T, direction: 'up' }, null).length === 0);
  ok('missing collections do not throw', attribute({ t: T, direction: 'down' }, {}).length === 0);
  ok('missing event does not throw', attribute(null, empty).length === 0);
  ok('items without timestamps are skipped', attribute({ t: T, direction: 'up' }, {
    twitch: { enabled: true, live: [{ id: 'x', user: 'S', viewers: 100, title: 't', url: 'u', startedAt: null }] }
  }).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
