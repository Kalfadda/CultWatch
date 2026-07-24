'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Tiered player-count history.
 *
 *   fine    raw samples (~1/min), 48h        cultwatch-history.json        [{t,v}]
 *   medium  5-minute buckets, 30 days        cultwatch-series-medium.json  {v,rows}
 *   daily   one row per local day, forever   cultwatch-series-daily.json   {v,rows}
 *
 * The flat 48h ring buffer this replaces silently discarded launch day — by the
 * time anyone wanted to compare week two to launch, the launch curve was gone.
 * Every push folds into all three tiers at once, so rollups are never stale and
 * there is no batch job to miss.
 */

const MEDIUM_MS = 5 * 60 * 1000;
const MEDIUM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 3650;
const TIER_VERSION = 2;

function bucketStart(t) {
  return Math.floor(t / MEDIUM_MS) * MEDIUM_MS;
}

// Local calendar day — "day 3" should mean the team's day 3, not UTC's.
function dayKey(t) {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayStartMs(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Split a point array wherever consecutive samples are further apart than
 * maxGapMs. The chart draws one path per segment, so a stretch where the app
 * was closed renders as a hole instead of a confident straight line across it.
 */
function segments(points, maxGapMs) {
  const out = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].t - points[i - 1].t > maxGapMs) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(points[i]);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Fraction of a day we actually observed. A day the app was closed for is not
 * a day of low players, and the UI has to be able to tell the difference.
 */
function coverageFor(row, seriesStart, pollMs, now = Date.now()) {
  const start = dayStartMs(row.d);
  const end = start + DAY_MS;
  const observed = Math.min(end, now) - Math.max(start, seriesStart);
  if (observed <= 0 || !pollMs) return 0;
  return Math.max(0, Math.min(1, row.n / (observed / pollMs)));
}

function foldMedium(rows, t, v) {
  const key = bucketStart(t);
  const last = rows[rows.length - 1];
  if (last && last.t === key) {
    last.max = Math.max(last.max, v);
    last.min = Math.min(last.min, v);
    last.sum += v;
    last.n += 1;
    return;
  }
  if (last && key < last.t) {
    // Clock skew or out-of-order replay: find the bucket instead of appending.
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t === key) {
        rows[mid].max = Math.max(rows[mid].max, v);
        rows[mid].min = Math.min(rows[mid].min, v);
        rows[mid].sum += v;
        rows[mid].n += 1;
        return;
      }
      if (rows[mid].t < key) lo = mid + 1; else hi = mid - 1;
    }
    rows.splice(lo, 0, { t: key, max: v, min: v, sum: v, n: 1 });
    return;
  }
  rows.push({ t: key, max: v, min: v, sum: v, n: 1 });
}

function foldDaily(rows, t, v, peers) {
  const key = dayKey(t);
  let row = rows.length && rows[rows.length - 1].d === key
    ? rows[rows.length - 1]
    : rows.find((r) => r.d === key);
  if (!row) {
    row = { d: key, peak: v, min: v, sum: 0, n: 0, first: t, last: t, peers: {} };
    rows.push(row);
    rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }
  row.peak = Math.max(row.peak, v);
  row.min = Math.min(row.min, v);
  row.sum += v;
  row.n += 1;
  row.first = Math.min(row.first, t);
  row.last = Math.max(row.last, t);
  if (peers) {
    if (!row.peers) row.peers = {};
    for (const [appId, count] of Object.entries(peers)) {
      if (typeof count !== 'number') continue;
      row.peers[appId] = Math.max(row.peers[appId] || 0, count);
    }
  }
}

class Series {
  constructor(dir, { maxFine = 2880 } = {}) {
    this.dir = dir;
    this.maxFine = maxFine;
    this.fineFile = path.join(dir, 'cultwatch-history.json');
    this.mediumFile = path.join(dir, 'cultwatch-series-medium.json');
    this.dailyFile = path.join(dir, 'cultwatch-series-daily.json');

    const rawFine = readJson(this.fineFile, []);
    this.fine = Array.isArray(rawFine) ? rawFine : [];

    const med = readJson(this.mediumFile, null);
    const day = readJson(this.dailyFile, null);
    const valid = (o) => o && o.v === TIER_VERSION && Array.isArray(o.rows);

    if (valid(med) && valid(day)) {
      this.medium = med.rows;
      this.daily = day.rows;
    } else {
      // Rebuild BOTH derived tiers from fine so they can never disagree, then
      // persist immediately — this is the one-time upgrade that rescues
      // whatever the old 48h buffer still holds.
      this.medium = [];
      this.daily = [];
      for (const p of this.fine) {
        if (!p || typeof p.t !== 'number' || typeof p.v !== 'number') continue;
        foldMedium(this.medium, p.t, p.v);
        foldDaily(this.daily, p.t, p.v, null);
      }
      this._persistDerived();
    }
  }

  push(point, peers) {
    const t = point && point.t;
    const v = point && point.v;
    if (typeof t !== 'number' || typeof v !== 'number') return;

    this.fine.push({ t, v });
    if (this.fine.length > this.maxFine) {
      this.fine = this.fine.slice(this.fine.length - this.maxFine);
    }
    foldMedium(this.medium, t, v);
    foldDaily(this.daily, t, v, peers);

    const cutoff = t - MEDIUM_RETENTION_MS;
    if (this.medium.length && this.medium[0].t < cutoff) {
      this.medium = this.medium.filter((r) => r.t >= cutoff);
    }
    if (this.daily.length > DAILY_CAP) {
      this.daily = this.daily.slice(this.daily.length - DAILY_CAP);
    }

    writeJson(this.fineFile, this.fine);
    this._persistDerived();
  }

  _persistDerived() {
    writeJson(this.mediumFile, { v: TIER_VERSION, rows: this.medium });
    writeJson(this.dailyFile, { v: TIER_VERSION, rows: this.daily });
  }

  getFine() { return this.fine.slice(); }
  getMedium() { return this.medium.slice(); }
  getDaily() { return this.daily.slice(); }

  /** Timestamp of the first sample ever recorded — the denominator anchor for
   *  day-coverage math. */
  seriesStart() {
    if (this.daily.length) return this.daily[0].first;
    return this.fine.length ? this.fine[0].t : Date.now();
  }

  clear() {
    this.fine = [];
    this.medium = [];
    this.daily = [];
    writeJson(this.fineFile, this.fine);
    this._persistDerived(); // writes v:2 envelopes, so clearing != re-migrating
  }
}

module.exports = {
  Series, segments, coverageFor, foldMedium, foldDaily,
  bucketStart, dayKey, dayStartMs,
  MEDIUM_MS, MEDIUM_RETENTION_MS, DAY_MS, DAILY_CAP, TIER_VERSION
};
