'use strict';

const steam = require('./services/steam');
const reddit = require('./services/reddit');
const bluesky = require('./services/bluesky');
const twitch = require('./services/twitch');
const youtube = require('./services/youtube');
const x = require('./services/x');
const web = require('./services/web');
const peersSvc = require('./services/peers');
const tinybuildSvc = require('./services/tinybuild');
const { coverageFor, dayKey, dayStartMs, DAY_MS } = require('./history');
const { analyze, parseTaxonomy, DEFAULT_TAXONOMY } = require('./reviews');

/**
 * Fetches every enabled source, tolerating individual failures. Returns a
 * single snapshot object plus a per-source status map so the UI can show
 * exactly what's live and what errored. `now` is injected for testability.
 *
 * Derived blocks (trends / reviewIntel / peers) are built here too, so the
 * renderer receives finished numbers and never has to compute analysis itself.
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
    settle('web', src.web, () => web.search(cfg.keywords, 20)),
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
    settle('x', src.x, () => x.search({ bearerToken: cfg.xBearerToken, keywords: cfg.keywords })),
    settle('peers', src.peers, () => peersSvc.getPeerPlayers(cfg.peers)),
    settle('tinybuild', src.tinybuild, () => tinybuildSvc.getCohort(cfg.tinybuild && cfg.tinybuild.cohort))
  ];

  const results = await Promise.all(tasks);
  const by = Object.fromEntries(results.map((r) => [r.name, r]));

  // --- Peers (fetched first so their peaks fold into today's rollup) ---
  const peerList = by.peers.data || [];
  const peerMap = {};
  for (const p of peerList) if (p.available) peerMap[p.appId] = p.count;

  // --- Players + tiered history ---
  const playersRes = by.players.data || { available: false, count: null };
  let peakSession = null;
  const priorHistory = store.getHistory();
  if (priorHistory.length) {
    peakSession = priorHistory.reduce((m, p) => (p.v != null && p.v > m ? p.v : m), 0);
  }
  if (playersRes.available && typeof playersRes.count === 'number') {
    store.pushHistory({ t: now, v: playersRes.count }, cfg.historyMaxPoints, peerMap);
    if (peakSession == null || playersRes.count > peakSession) peakSession = playersRes.count;
  }
  const history = store.getHistory();

  // --- Reviews: ingest this page, then analyse the whole stored corpus ---
  const reviewsData = by.reviews.data || null;
  if (reviewsData && Array.isArray(reviewsData.recent)) {
    store.reviewStore.ingest(reviewsData.recent);
  }
  const taxonomy = cfg.reviewTaxonomy ? parseTaxonomy(cfg.reviewTaxonomy) : DEFAULT_TAXONOMY;
  const reviewIntel = analyze(store.reviewStore.rows(), taxonomy, now, reviewsData);

  // --- Trends: daily rollups with honest coverage, plus retention ---
  const pollMs = Math.max(15, Number(cfg.refreshIntervalSec) || 60) * 1000;
  const seriesStart = store.series.seriesStart();
  const launchTs = cfg.launchDate ? new Date(cfg.launchDate).getTime() : null;
  const launchDayStart = launchTs && !Number.isNaN(launchTs) ? dayStartMs(dayKey(launchTs)) : null;

  const days = store.series.getDaily().map((row) => {
    const coverage = coverageFor(row, seriesStart, pollMs, now);
    return {
      d: row.d,
      peak: row.peak,
      min: row.min,
      avg: row.n ? Math.round(row.sum / row.n) : null,
      n: row.n,
      peers: row.peers || {},
      coverage,
      partial: coverage < 0.9,
      // Math.round, not floor: DST makes some local days 23 or 25 hours long.
      dayNumber: launchDayStart != null
        ? Math.round((dayStartMs(row.d) - launchDayStart) / DAY_MS) + 1
        : null
    };
  });

  const snapshot = {
    ts: now,
    config: {
      appId,
      gameName: cfg.gameName,
      launchDate: cfg.launchDate,
      refreshIntervalSec: cfg.refreshIntervalSec,
      sources: src,
      tinybuildLabel: (cfg.tinybuild && cfg.tinybuild.label) || 'Publisher',
      tinybuildWindowDays: (cfg.tinybuild && cfg.tinybuild.windowDays) || 365
    },
    game: by.appDetails.data || null,
    web: by.web.data || [],
    players: {
      current: playersRes.available ? playersRes.count : null,
      available: playersRes.available,
      peakSession,
      history
    },
    reviews: reviewsData,
    news: by.news.data || [],
    reddit: by.reddit.data || [],
    bluesky: by.bluesky.data || [],
    twitch: by.twitch.data || { enabled: false, live: [], totalViewers: 0 },
    youtube: by.youtube.data || { enabled: false, videos: [] },
    x: by.x.data || { enabled: false, posts: [] },
    peers: peersSvc.rankPeers(peerList, playersRes.available ? playersRes.count : null, cfg.gameName),
    tinybuild: by.tinybuild.data
      ? tinybuildSvc.rankCohort(by.tinybuild.data, appId, now, cfg.tinybuild && cfg.tinybuild.windowDays)
      : null,
    trends: { days, retention: buildRetention(days, launchTs) },
    reviewIntel,
    events: store.eventLog.recent(60),
    status: Object.fromEntries(
      results.map((r) => [r.name, { status: r.status, error: r.error || null, ms: r.ms || null }])
    )
  };

  return snapshot;
}

/**
 * Retention against the launch-day peak — except launch day is frequently
 * missing, because the old flat 48h buffer evicted it long before anyone
 * wanted to compare against it. When it is missing we fall back to the best
 * surviving day and label it as such, rather than quietly presenting a partial
 * record as the real thing.
 */
function buildRetention(days, launchTs) {
  if (!days.length) return null;
  const launchKey = launchTs && !Number.isNaN(launchTs) ? dayKey(launchTs) : null;
  const launchRow = launchKey ? days.find((d) => d.d === launchKey) : null;
  const ref = launchRow || days.reduce((best, d) => (d.peak > best.peak ? d : best), days[0]);
  const today = days[days.length - 1];
  return {
    todayPeak: today.peak,
    todayDay: today.d,
    referencePeak: ref.peak,
    referenceDay: ref.d,
    referenceIsLaunch: !!launchRow,
    referenceLabel: launchRow
      ? 'launch peak'
      : `best known peak (day ${ref.dayNumber != null ? ref.dayNumber : '?'})`,
    pct: ref.peak ? Math.round((today.peak / ref.peak) * 100) : null,
    daysTracked: days.length
  };
}

module.exports = { collect, buildRetention };
