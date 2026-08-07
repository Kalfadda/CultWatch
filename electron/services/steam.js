'use strict';

const { getJson, request } = require('./http');

/**
 * Steam data. All of these work with NO API key (public store + web
 * endpoints). A Steam Web API key is accepted where it improves reliability.
 */

const STORE = 'https://store.steampowered.com';
const API = 'https://api.steampowered.com';

function stripBB(html) {
  if (!html) return '';
  return String(html)
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function getAppDetails(appId) {
  const url = `${STORE}/api/appdetails?appids=${appId}`;
  const json = await getJson(url);
  const entry = json[String(appId)];
  if (!entry || !entry.success) throw new Error(`No store data for appId ${appId}`);
  const d = entry.data;
  return {
    name: d.name,
    appId: d.steam_appid,
    type: d.type,
    isFree: d.is_free,
    headerImage: d.header_image,
    capsuleImage: d.capsule_imagev5 || d.capsule_image,
    shortDescription: d.short_description,
    website: d.website,
    developers: d.developers || [],
    publishers: d.publishers || [],
    genres: (d.genres || []).map((g) => g.description),
    platforms: d.platforms || {},
    releaseDate: d.release_date ? d.release_date.date : null,
    comingSoon: d.release_date ? !!d.release_date.coming_soon : null,
    price: d.price_overview
      ? {
          formatted: d.price_overview.final_formatted,
          initialFormatted: d.price_overview.initial_formatted,
          discountPct: d.price_overview.discount_percent,
          currency: d.price_overview.currency
        }
      : null,
    recommendations: d.recommendations ? d.recommendations.total : null,
    metacritic: d.metacritic ? d.metacritic.score : null
  };
}

async function getCurrentPlayers(appId, apiKey) {
  const key = apiKey ? `&key=${encodeURIComponent(apiKey)}` : '';
  const url = `${API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}${key}`;
  // Steam returns HTTP 404 (with a valid JSON body, result:42) for apps that
  // have no live player data yet — normal pre-launch. Once released it returns
  // HTTP 200 with result:1 and player_count. So we parse the body regardless
  // of status and only treat a genuinely unreadable response as an error.
  const res = await request(url);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Player count: unreadable response (HTTP ${res.status})`);
  }
  const r = json.response || {};
  if (r.result === 1 && typeof r.player_count === 'number') {
    return { available: true, count: r.player_count };
  }
  return { available: false, count: null, result: r.result != null ? r.result : null };
}

function mapReviews(list) {
  return (list || []).map((r) => ({
    id: r.recommendationid,
    author: r.author ? String(r.author.steamid).slice(-6) : '—',
    votedUp: r.voted_up,
    text: (r.review || '').replace(/\s+/g, ' ').trim(),
    hoursPlayed: r.author && r.author.playtime_forever ? Math.round(r.author.playtime_forever / 60) : null,
    votesUp: r.votes_up || 0,
    timestamp: r.timestamp_created ? r.timestamp_created * 1000 : null,
    language: r.language
  }));
}

/**
 * One page of reviews plus the cursor for the next. Used by the one-time
 * historical backfill — the regular poll only ever needs the newest page.
 */
async function getReviewsPage(appId, cursor = '*', perPage = 100) {
  const url = `${STORE}/appreviews/${appId}?json=1&language=all&purchase_type=all&filter=recent` +
    `&num_per_page=${perPage}&cursor=${encodeURIComponent(cursor)}`;
  const json = await getJson(url);
  return { reviews: mapReviews(json.reviews), cursor: json.cursor || null };
}

/** Parses an appreviews `query_summary` block. Pure, so it is shared by the
 *  full review fetch and the cohort's summary-only fetch. */
function summarize(json) {
  const q = (json && json.query_summary) || {};
  const total = q.total_reviews || 0;
  const positive = q.total_positive || 0;
  return {
    score: q.review_score || 0,
    scoreDesc: q.review_score_desc || 'No user reviews',
    total,
    positive,
    negative: q.total_negative || 0,
    positivePct: total > 0 ? Math.round((positive / total) * 100) : null
  };
}

/** Summary only — one request, no recent-review page. The cohort needs seven of
 *  these per poll and would otherwise throw away seven review pages. */
async function getReviewSummary(appId) {
  const url = `${STORE}/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`;
  return summarize(await getJson(url));
}

async function getReviews(appId) {
  // Summary + a page of recent reviews in one shot.
  const summaryUrl = `${STORE}/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`;
  const recentUrl = `${STORE}/appreviews/${appId}?json=1&language=all&purchase_type=all&filter=recent&num_per_page=15`;

  const [summaryJson, recentJson] = await Promise.all([
    getJson(summaryUrl),
    getJson(recentUrl).catch(() => ({ reviews: [] }))
  ]);

  return { ...summarize(summaryJson), recent: mapReviews(recentJson.reviews) };
}

async function getNews(appId, count = 10) {
  const url = `${API}/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=${count}&maxlength=400&format=json`;
  const json = await getJson(url);
  const items = (json.appnews && json.appnews.newsitems) || [];
  return items.map((n) => ({
    id: n.gid,
    title: n.title,
    url: n.url,
    author: n.author || (n.feedlabel || 'Steam'),
    date: n.date ? n.date * 1000 : null,
    summary: stripBB(n.contents).slice(0, 280),
    source: n.feedlabel || 'Steam'
  }));
}

module.exports = { getAppDetails, getCurrentPlayers, getReviews, getReviewSummary, getReviewsPage, getNews, stripBB, summarize };
