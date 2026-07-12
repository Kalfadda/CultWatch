'use strict';

const steam = require('./services/steam');
const reddit = require('./services/reddit');
const bluesky = require('./services/bluesky');
const twitch = require('./services/twitch');
const youtube = require('./services/youtube');
const x = require('./services/x');

/**
 * Fetches every enabled source, tolerating individual failures. Returns a
 * single snapshot object plus a per-source status map so the UI can show
 * exactly what's live and what errored. `now` is injected for testability.
 */

async function settle(name, enabled, fn) {
  if (!enabled) return { name, status: 'off', data: null };
  const started = Date.now();
  try {
    const data = await fn();
    return { name, status: 'ok', data, ms: Date.now() - started };
  } catch (err) {
    return { name, status: 'error', error: err.message || String(err), data: null, ms: Date.now() - started };
  }
}

async function collect(store, now = Date.now()) {
  const cfg = store.get();
  const appId = cfg.appId;
  const src = cfg.sources || {};

  const tasks = [
    settle('appDetails', src.steam, () => steam.getAppDetails(appId)),
    settle('players', src.steam, () => steam.getCurrentPlayers(appId, cfg.steamApiKey)),
    settle('reviews', src.steam, () => steam.getReviews(appId)),
    settle('news', src.news, () => steam.getNews(appId, 12)),
    settle('reddit', src.reddit, () =>
      reddit.search(
        { keywords: cfg.keywords, clientId: cfg.redditClientId, clientSecret: cfg.redditClientSecret },
        25,
        now
      )
    ),
    settle('bluesky', src.bluesky, () => bluesky.search(cfg.keywords, 25)),
    settle('twitch', src.twitch, () =>
      twitch.getLiveStreams(
        { clientId: cfg.twitchClientId, clientSecret: cfg.twitchClientSecret, gameName: cfg.twitchGameName },
        now
      )
    ),
    settle('youtube', src.youtube, () => youtube.search({ apiKey: cfg.youtubeApiKey, keywords: cfg.keywords })),
    settle('x', src.x, () => x.search({ bearerToken: cfg.xBearerToken, keywords: cfg.keywords }))
  ];

  const results = await Promise.all(tasks);
  const by = Object.fromEntries(results.map((r) => [r.name, r]));

  // --- Players + rolling history ---
  const playersRes = by.players.data || { available: false, count: null };
  let peakSession = null;
  const priorHistory = store.getHistory();
  if (priorHistory.length) {
    peakSession = priorHistory.reduce((m, p) => (p.v != null && p.v > m ? p.v : m), 0);
  }
  if (playersRes.available && typeof playersRes.count === 'number') {
    store.pushHistory({ t: now, v: playersRes.count }, cfg.historyMaxPoints);
    if (peakSession == null || playersRes.count > peakSession) peakSession = playersRes.count;
  }
  const history = store.getHistory();

  const snapshot = {
    ts: now,
    config: {
      appId,
      gameName: cfg.gameName,
      launchDate: cfg.launchDate,
      refreshIntervalSec: cfg.refreshIntervalSec,
      sources: src
    },
    game: by.appDetails.data || null,
    players: {
      current: playersRes.available ? playersRes.count : null,
      available: playersRes.available,
      peakSession,
      history
    },
    reviews: by.reviews.data || null,
    news: by.news.data || [],
    reddit: by.reddit.data || [],
    bluesky: by.bluesky.data || [],
    twitch: by.twitch.data || { enabled: false, live: [], totalViewers: 0 },
    youtube: by.youtube.data || { enabled: false, videos: [] },
    x: by.x.data || { enabled: false, posts: [] },
    status: Object.fromEntries(
      results.map((r) => [r.name, { status: r.status, error: r.error || null, ms: r.ms || null }])
    )
  };

  return snapshot;
}

module.exports = { collect };
