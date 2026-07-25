'use strict';

/**
 * Headless smoke test for the data layer. Runs the real service modules
 * against live endpoints (no Electron / no display required):
 *
 *   node scripts/selftest.js
 *
 * Steam sources should always pass. Reddit / Bluesky may fail from
 * restrictive networks (datacenter IPs, corporate proxies) — that's a
 * network limitation, not a code fault, and they work from a normal desktop.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { Store } = require('../electron/config');
const { collect } = require('../electron/poller');

function line(label, ok, detail) {
  const tag = ok === true ? '  \x1b[32mPASS\x1b[0m' : ok === 'warn' ? '  \x1b[33mWARN\x1b[0m' : '  \x1b[31mFAIL\x1b[0m';
  console.log(`${tag}  ${label.padEnd(16)} ${detail || ''}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cultwatch-'));
  const store = new Store(tmp);

  console.log('\n  CultWatch data-layer self-test');
  console.log('  target appId:', store.get().appId, '\n');

  const snap = await collect(store);

  // Steam core (must work)
  const g = snap.game;
  line('appDetails', !!(g && g.name), g ? `${g.name} · ${(g.developers || []).join(', ')} · release ${g.releaseDate}` : snap.status.appDetails.error);
  line('players', snap.status.players.status === 'ok', snap.players.available ? `${snap.players.current} online` : 'no live data yet (pre-launch expected)');
  line('reviews', snap.status.reviews.status === 'ok', snap.reviews ? `${snap.reviews.scoreDesc} — ${snap.reviews.total} reviews` : snap.status.reviews.error);
  line('news', snap.status.news.status === 'ok', `${(snap.news || []).length} items` + ((snap.news[0]) ? ` · latest: "${snap.news[0].title.slice(0, 48)}"` : ''));
  line('web', snap.status.web.status === 'ok', `${(snap.web || []).length} articles` + ((snap.web[0]) ? ` · "${snap.web[0].title.slice(0, 44)}" (${snap.web[0].source})` : ''));

  // Discovery (may warn on locked-down networks)
  const soft = (name) => {
    const st = snap.status[name];
    if (st.status === 'ok') line(name, true, `${count(snap, name)} results`);
    else if (st.status === 'off') line(name, 'warn', 'disabled');
    else line(name, 'warn', `${st.error} (works on a normal desktop / with keys)`);
  };
  soft('reddit');
  soft('bluesky');
  soft('twitch');
  soft('youtube');
  soft('x');
  soft('peers');
  soft('tinybuild');

  // Derived analysis
  const pr = snap.peers || { rows: [] };
  const named = pr.rows.filter((r) => r.available && !r.us).length;
  line('peer ranking', pr.ourRank != null || !pr.rows.length,
    pr.ourRank ? `we are #${pr.ourRank} of ${pr.rows.length} (${named} peers reporting)` : 'no player data to rank yet');

  const tb = snap.tinybuild;
  line('cohort ranking', !tb || tb.momentum.ourRank != null || !tb.cohortSize,
    tb && tb.cohortSize
      ? `${tb.cohortSize} titles · momentum #${tb.momentum.ourRank} of ${tb.momentum.ourOf}` +
        ` · reception #${tb.reception.ourRank} of ${tb.reception.ourOf}` +
        (tb.flagged ? ` · ${tb.flagged} outside window` : '')
      : 'cohort empty or disabled');

  const ri = snap.reviewIntel || { coverage: {}, themes: [] };
  const cov = ri.coverage || {};
  line('reviewIntel', !!ri.coverage,
    `${cov.total || 0} stored · ${cov.english || 0} english · ${(ri.themes || []).length} themes` +
    ((ri.themes || [])[0] ? ` · top: ${ri.themes[0].label} (${ri.themes[0].count})` : ''));

  const tr = snap.trends || { days: [] };
  line('trends', Array.isArray(tr.days),
    `${tr.days.length} day rollup(s)` +
    (tr.retention ? ` · ${tr.retention.pct}% of ${tr.retention.referenceLabel}` : ' · no reference yet'));

  // History persistence check
  const before = store.getHistory().length;
  store.pushHistory({ t: Date.now(), v: 123 }, 10);
  const persisted = new Store(tmp).getHistory();
  line('persistence', persisted.length === before + 1 && persisted[persisted.length - 1].v === 123, `history round-trips to disk (${persisted.length} pts)`);

  const steamOk = ['appDetails', 'players', 'reviews', 'news'].every((k) => snap.status[k].status === 'ok');
  console.log('\n  Steam core:', steamOk ? '\x1b[32mALL GREEN\x1b[0m' : '\x1b[31mDEGRADED\x1b[0m');
  console.log('  (Reddit/Bluesky/Twitch/YouTube/X warnings above are network/credential-dependent.)\n');

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(steamOk ? 0 : 1);
})().catch((err) => {
  console.error('\n  self-test crashed:', err);
  process.exit(2);
});

function count(snap, name) {
  if (name === 'reddit') return (snap.reddit || []).length;
  if (name === 'bluesky') return (snap.bluesky || []).length;
  if (name === 'twitch') return (snap.twitch && snap.twitch.live || []).length;
  if (name === 'youtube') return (snap.youtube && snap.youtube.videos || []).length;
  if (name === 'x') return (snap.x && snap.x.posts || []).length;
  if (name === 'peers') return (snap.peers && snap.peers.rows || []).length;
  if (name === 'tinybuild') return (snap.tinybuild && snap.tinybuild.cohortSize) || 0;
  return 0;
}
