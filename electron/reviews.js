'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Review corpus + complaint clustering.
 *
 * Steam hands back only the most recent page per poll, so without a persisted
 * corpus there is nothing to cluster and no way to measure velocity. This module
 * owns cultwatch-reviews.json, ingests each poll's page, back-fills the whole
 * history once, and derives velocity / rolling sentiment / complaint themes.
 *
 * Clustering is deliberately keyword-based: deterministic, offline, unit-testable,
 * and it degrades to "untagged" rather than guessing. It only runs on English
 * reviews — roughly a third of this game's corpus is not English, and those are
 * counted and surfaced rather than silently dropped, so a complaint count is
 * never mistaken for the whole picture.
 */

const MAX_ROWS = 2500;
const MAX_TEXT = 400;
const STORE_VERSION = 1;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const DEFAULT_TAXONOMY = [
  { key: 'crash', label: 'Crashes', patterns: [/\bcrash/i, /\bfreez/i, /\bhard ?lock/i, /\bblack ?screen/i, /\bwon'?t (?:launch|start|open)/i] },
  { key: 'performance', label: 'Performance', patterns: [/\bfps\b/i, /\blag(?:g|s|gy|ging)?\b/i, /\bstutter/i, /\bframe ?rate/i, /\boptimi[sz]/i, /\bslow ?down/i] },
  { key: 'bugs', label: 'Bugs / glitches', patterns: [/\bbug(?:s|gy|ged)?\b/i, /\bglitch/i, /\bbroken\b/i, /\bsoft ?lock/i, /\bstuck (?:in|on|behind)/i] },
  { key: 'saves', label: 'Saves / progress', patterns: [/\bsave (?:file|data|game|s)\b/i, /\blost (?:my )?progress/i, /\bcheckpoint/i, /\bautosave/i] },
  { key: 'controller', label: 'Controller / input', patterns: [/\bcontroller/i, /\bgamepad/i, /\bkeybind/i, /\bremap/i, /\bmouse (?:sens|accel)/i, /\bdead ?zone/i] },
  { key: 'price', label: 'Price / value', patterns: [/\bprice\b/i, /\bexpensive/i, /\boverpriced/i, /\bnot worth\b/i, /\brefund/i, /\bwait for (?:a )?sale/i] },
  { key: 'length', label: 'Too short', patterns: [/\btoo short\b/i, /\bshort(?:er)? than/i, /\b(?:only|just) \d+ hours?\b/i, /\blacks content/i, /\bno content\b/i] },
  { key: 'difficulty', label: 'Difficulty', patterns: [/\btoo (?:hard|easy|difficult)\b/i, /\bunfair/i, /\bfrustrating/i, /\bdifficulty (?:spike|curve)/i] },
  { key: 'motion', label: 'Motion sickness', patterns: [/\bmotion sick/i, /\bnausea/i, /\bnauseous/i, /\bfov\b/i, /\bhead ?bob/i, /\bmotion blur/i] },
  { key: 'audio', label: 'Audio', patterns: [/\baudio\b/i, /\bsound (?:bug|issue|glitch|cut)/i, /\bvolume\b/i, /\bmusic (?:loop|cut|bug)/i, /\bno sound\b/i] }
];

/** English-only by design — see the module note. */
function classify(text, lang, taxonomy) {
  const english = !lang || lang === 'english';
  if (!english || !text) return { english, themes: [] };
  const themes = [];
  for (const t of taxonomy || []) {
    if ((t.patterns || []).some((p) => p.test(text))) themes.push(t.key);
  }
  return { english, themes };
}

function parseTaxonomy(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const label = line.slice(0, idx).trim();
    const words = line.slice(idx + 1).split(',').map((w) => w.trim()).filter(Boolean);
    if (!label || !words.length) continue;
    out.push({
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      label,
      patterns: words.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    });
  }
  return out;
}

function formatTaxonomy(taxonomy) {
  return (taxonomy || []).map((t) => {
    const words = (t.patterns || []).map((p) => p.source.replace(/\\([.*+?^${}()|[\]\\])/g, '$1'));
    return `${t.label}: ${words.join(', ')}`;
  }).join('\n');
}

/**
 * Derive everything the Trends panels and the complaint-surge alert need.
 *
 * Themes carry two windows on purpose: the UI's trend arrow uses the steadier
 * 48h pair, the alert uses the tighter 24h pair, and computing both here keeps
 * them from ever disagreeing about what "surging" means.
 */
function analyze(rows, taxonomy, now = Date.now(), summary = null) {
  const all = Array.isArray(rows) ? rows : [];
  const coverage = { total: all.length, english: 0, nonEnglish: 0, themed: 0, untagged: 0 };
  const stats = new Map();
  for (const t of taxonomy || []) {
    stats.set(t.key, { key: t.key, label: t.label, count: 0, last24: 0, prior24: 0, recent48: 0, prior48: 0 });
  }

  for (const r of all) {
    const { english, themes } = classify(r.txt, r.lang, taxonomy);
    if (english) coverage.english++; else coverage.nonEnglish++;
    if (!r.up && english) {
      if (themes.length) coverage.themed++; else coverage.untagged++;
    }
    if (r.up || !themes.length) continue;

    const age = now - r.t;
    for (const key of themes) {
      const s = stats.get(key);
      if (!s) continue;
      s.count++;
      if (age < DAY) s.last24++;
      else if (age < 2 * DAY) s.prior24++;
      if (age < 2 * DAY) s.recent48++;
      else if (age < 4 * DAY) s.prior48++;
    }
  }

  const themes = [...stats.values()]
    .filter((s) => s.count > 0)
    .map((s) => ({
      ...s,
      trend: s.prior48 > 0 ? +(s.recent48 / s.prior48).toFixed(2) : (s.recent48 >= 3 ? null : 1)
    }))
    .sort((a, b) => b.count - a.count);

  const in24 = all.filter((r) => now - r.t < DAY);
  const prior24 = all.filter((r) => now - r.t >= DAY && now - r.t < 2 * DAY);
  const in7d = all.filter((r) => now - r.t < 7 * DAY);
  const pos7 = in7d.filter((r) => r.up).length;
  const pct7d = in7d.length ? Math.round((pos7 / in7d.length) * 100) : null;
  const pctAll = summary && summary.positivePct != null ? summary.positivePct : null;

  return {
    themes,
    coverage,
    velocity: {
      perHour24: +(in24.length / 24).toFixed(2),
      last1h: all.filter((r) => now - r.t < HOUR).length,
      count24: in24.length,
      countPrior24: prior24.length,
      trendPct: prior24.length ? Math.round(((in24.length - prior24.length) / prior24.length) * 100) : null
    },
    rolling: {
      pct7d,
      count7d: in7d.length,
      pctAll,
      delta: pct7d != null && pctAll != null ? pct7d - pctAll : null
    }
  };
}

class ReviewStore {
  constructor(dir) {
    this.file = path.join(dir, 'cultwatch-reviews.json');
    const raw = readJson(this.file, null);
    this.data = raw && raw.v === STORE_VERSION && Array.isArray(raw.rows)
      ? raw
      : { v: STORE_VERSION, backfilledAt: null, rows: [] };
    this.seen = new Set(this.data.rows.map((r) => r.id));
  }

  /** Accepts the shape steam.getReviews() already produces. */
  ingest(recent) {
    let added = 0;
    for (const r of recent || []) {
      if (!r || !r.id || this.seen.has(r.id)) continue;
      this.seen.add(r.id);
      this.data.rows.push({
        id: r.id,
        t: r.timestamp || Date.now(),
        up: !!r.votedUp,
        txt: String(r.text || '').slice(0, MAX_TEXT),
        hrs: r.hoursPlayed != null ? r.hoursPlayed : null,
        lang: r.language || null,
        votes: r.votesUp || 0
      });
      added++;
    }
    if (!added) return 0;
    this.data.rows.sort((a, b) => a.t - b.t);
    if (this.data.rows.length > MAX_ROWS) {
      this.data.rows = this.data.rows.slice(this.data.rows.length - MAX_ROWS);
      this.seen = new Set(this.data.rows.map((r) => r.id));
    }
    this._persist();
    return added;
  }

  rows() { return this.data.rows.slice(); }
  backfilledAt() { return this.data.backfilledAt; }

  setBackfilled(ts) {
    this.data.backfilledAt = ts;
    this._persist();
  }

  clear() {
    this.data = { v: STORE_VERSION, backfilledAt: null, rows: [] };
    this.seen = new Set();
    this._persist();
  }

  _persist() { writeJson(this.file, this.data); }
}

/**
 * One-time historical backfill. Steam's review endpoint paginates by opaque
 * cursor; measured against this app it walks the entire corpus in 4 requests.
 * Runs once ever (guarded by backfilledAt) and is non-fatal to the caller — a
 * failure just leaves the store ingesting incrementally as before.
 */
async function backfillReviews(store, appId, fetchPage, { maxPages = 25 } = {}) {
  if (store.backfilledAt()) return { added: 0, pages: 0, skipped: true };
  let cursor = '*';
  let added = 0;
  let pages = 0;
  while (pages < maxPages) {
    const page = await fetchPage(appId, cursor);
    pages++;
    const list = (page && page.reviews) || [];
    added += store.ingest(list);
    const next = page && page.cursor;
    if (!list.length || !next || next === cursor) break;
    cursor = next;
  }
  store.setBackfilled(Date.now());
  return { added, pages, skipped: false };
}

module.exports = {
  ReviewStore, classify, analyze, parseTaxonomy, formatTaxonomy, backfillReviews,
  DEFAULT_TAXONOMY, MAX_ROWS, MAX_TEXT
};
