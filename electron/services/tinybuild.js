'use strict';

/**
 * Publisher cohort — how our game compares to the other titles our publisher
 * shipped this year.
 *
 * Two rankings over one set of rows, because they disagree: the cohort's biggest
 * game by concurrents can be its worst reviewed. Collapsing them into a single
 * score would hide exactly the thing worth seeing, so both are kept whole.
 *
 * This half is pure. The network half lives below it and never rejects.
 */

const DAY_MS = 86400000;

/**
 * Orders rows by `valueOf`, descending via `cmp`. A row whose value is null is
 * *unranked*: it keeps its place in the output, always last, with `rank: null`.
 * Dropping it would let a failing title silently shrink the cohort and flatter
 * our position; keeping it visible is the point.
 */
function rankBy(rows, valueOf, cmp) {
  const ranked = [];
  const unranked = [];
  for (const r of rows) {
    const value = valueOf(r);
    if (value == null) unranked.push({ r, value: null });
    else ranked.push({ r, value });
  }
  ranked.sort(cmp);

  const out = ranked.map((e, i) => ({ ...e.r, rank: i + 1, value: e.value }));
  for (const e of unranked) out.push({ ...e.r, rank: null, value: null });

  const us = out.find((x) => x.us && x.rank != null) || null;
  return {
    rows: out,
    ourRank: us ? us.rank : null,
    ourOf: ranked.length,
    leader: out.length && out[0].rank != null ? out[0] : null
  };
}

function rankCohort(rows, ourAppId, now = Date.now(), windowDays = 365) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.appId);
  const windowMs = (Number(windowDays) || 365) * DAY_MS;

  const marked = list.map((r) => ({
    ...r,
    us: String(r.appId) === String(ourAppId),
    // A title with no known release date is never flagged — we would be
    // asserting staleness we cannot actually demonstrate.
    outsideWindow: r.releasedAt != null && now - r.releasedAt > windowMs
  }));

  const momentum = rankBy(
    marked,
    (r) => (r.ccuAvailable && typeof r.count === 'number' ? r.count : null),
    (a, b) => b.value - a.value
  );
  const reception = rankBy(
    marked,
    (r) => (r.reviews && r.reviews.positivePct != null ? r.reviews.positivePct : null),
    // More reviews at the same percentage is the more established result.
    (a, b) => b.value - a.value || (b.r.reviews.total || 0) - (a.r.reviews.total || 0)
  );

  const totalCcu = marked.reduce((n, r) => n + (r.ccuAvailable ? r.count || 0 : 0), 0);
  const ourRow = marked.find((r) => r.us && r.ccuAvailable);
  const shareOfCcu = totalCcu > 0 && ourRow ? Math.round((ourRow.count / totalCcu) * 100) : null;

  return {
    momentum,
    reception,
    shareOfCcu,
    cohortSize: marked.length,
    flagged: marked.filter((r) => r.outsideWindow).length,
    readLine: readLine(momentum, reception)
  };
}

/**
 * The one sentence worth screenshotting. Generated rather than hand-written so
 * it cannot drift from the numbers above it.
 */
function readLine(momentum, reception) {
  const m = momentum.ourRank;
  const r = reception.ourRank;
  if (m == null && r == null) return null;

  let lead;
  if (m === 1 && r === 1) lead = 'Top of the cohort on both players and sentiment.';
  else if (m === 1) lead = r == null ? '#1 by players.' : `#1 by players, #${r} of ${reception.ourOf} by sentiment.`;
  else if (r === 1) lead = m == null ? '#1 by sentiment.' : `#1 by sentiment, #${m} of ${momentum.ourOf} by players.`;
  else if (m != null && r != null) lead = `#${m} of ${momentum.ourOf} by players and #${r} of ${reception.ourOf} by sentiment.`;
  else if (m != null) lead = `#${m} of ${momentum.ourOf} by players; no sentiment data.`;
  else lead = `#${r} of ${reception.ourOf} by sentiment; no player data.`;

  const note = leaderNote(momentum.leader, reception);
  return note ? `${lead} ${note}` : lead;
}

/** Worth saying out loud when the cohort's biggest game is also badly received. */
function leaderNote(leader, reception) {
  if (!leader || leader.us || reception.ourOf < 3) return null;
  const row = reception.rows.find((x) => x.appId === leader.appId && x.rank != null);
  if (!row) return null;
  if (row.rank <= Math.ceil(reception.ourOf * (2 / 3))) return null;
  return `The cohort's biggest game is also among its worst reviewed (${leader.name}, ${row.value}%).`;
}

// ============================================================
// Network half — never rejects
// ============================================================

const steam = require('./steam');

/**
 * Names and release dates never change, so they are fetched once per title per
 * run and reused. Memory-only and deliberately not persisted: re-fetching seven
 * rows after a restart is cheaper than owning another file and its invalidation
 * rules. Only successful lookups are cached, so a transient failure retries.
 */
const META = new Map();

async function getMeta(appId, fallbackName) {
  if (META.has(appId)) return META.get(appId);
  try {
    const d = await steam.getAppDetails(appId);
    const ts = d.releaseDate ? Date.parse(d.releaseDate) : NaN;
    const meta = { name: d.name || fallbackName, releasedAt: Number.isNaN(ts) ? null : ts };
    META.set(appId, meta);
    return meta;
  } catch {
    return { name: fallbackName, releasedAt: null };
  }
}

async function getOne(entry) {
  const appId = String(entry.appId);
  const fallbackName = entry.name || `App ${appId}`;
  const errors = [];

  const [meta, ccu, reviews] = await Promise.all([
    getMeta(appId, fallbackName),
    steam.getCurrentPlayers(appId).catch((e) => {
      errors.push(e.message || String(e));
      return { available: false, count: null };
    }),
    steam.getReviewSummary(appId).catch((e) => {
      errors.push(e.message || String(e));
      return null;
    })
  ]);

  return {
    appId,
    // Prefer Steam's own name over the curated one — the curated list is
    // hand-maintained and a title can be renamed after we wrote it down.
    name: meta.name || fallbackName,
    count: ccu.available ? ccu.count : null,
    ccuAvailable: !!ccu.available,
    reviews: reviews && reviews.total ? reviews : null,
    releasedAt: meta.releasedAt,
    error: errors.length ? errors.join('; ') : null
  };
}

/** Never rejects — a title that fails comes back with its data nulled out. */
async function getCohort(cohort) {
  const list = (Array.isArray(cohort) ? cohort : []).filter((g) => g && g.appId);
  if (!list.length) return [];
  return Promise.all(list.map(getOne));
}

/** Test seam: drops the per-run metadata cache. */
function _resetMetaCache() {
  META.clear();
}

module.exports = { getCohort, rankCohort, readLine, _resetMetaCache };
