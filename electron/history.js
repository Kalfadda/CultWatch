'use strict';

const path = require('path');
const { readJsonState, writeJson, quarantine } = require('./atomic');

/**
 * Tiered player-count history.
 *
 *   fine    raw samples (~1/min), 48h        cultwatch-history.json        [{t,v}]
 *   medium  5-minute buckets, 30 days        cultwatch-series-medium.json  {v,rows}
 *   daily   one row per local day, forever   cultwatch-series-daily.json   {v,rows}
 *                                            cultwatch-series-daily.bak.json
 *
 * The flat 48h ring buffer this replaces silently discarded launch day — by the
 * time anyone wanted to compare week two to launch, the launch curve was gone.
 * Every push folds into all three tiers at once, so rollups are never stale and
 * there is no batch job to miss.
 *
 * Loading is where the record was actually being lost. A read that failed used
 * to be indistinguishable from a first run, so one file corrupted by an unclean
 * shutdown produced an empty rebuild that was then written straight over the
 * permanent daily tier. The rule now is narrow and absolute: a tier is rebuilt
 * only when its file is *missing* or of an older version — never when it failed
 * to read. See docs/superpowers/specs/2026-08-06-durable-player-history-design.md.
 */

const MEDIUM_MS = 5 * 60 * 1000;
const MEDIUM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 3650;
const TIER_VERSION = 2;
const DAILY_BACKUP_MS = 4 * 60 * 60 * 1000;

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

/** Rows from a `{v, rows}` envelope, or null if it is absent, unreadable or of
 *  an older version — the three cases that legitimately call for a rebuild. */
function envelopeRows(state) {
  const o = state && state.status === 'ok' ? state.data : null;
  return o && o.v === TIER_VERSION && Array.isArray(o.rows) ? o.rows : null;
}

class Series {
  constructor(dir, { maxFine = 2880 } = {}) {
    this.dir = dir;
    this.maxFine = maxFine;
    this.fineFile = path.join(dir, 'cultwatch-history.json');
    this.mediumFile = path.join(dir, 'cultwatch-series-medium.json');
    this.dailyFile = path.join(dir, 'cultwatch-series-daily.json');
    this.dailyBakFile = path.join(dir, 'cultwatch-series-daily.bak.json');

    // Surfaced through health() and rendered under the chart: a quarantined file
    // should be visible, not inferred from a suspiciously short record.
    this.damage = [];
    this.recovered = false;

    this._load();
  }

  _load() {
    const fine = readJsonState(this.fineFile);
    if (fine.status === 'unreadable') this._quarantine(this.fineFile, fine.error);
    this.fine = fine.status === 'ok' && Array.isArray(fine.data) ? fine.data : [];

    const med = readJsonState(this.mediumFile);
    const day = readJsonState(this.dailyFile);
    if (med.status === 'unreadable') this._quarantine(this.mediumFile, med.error);
    if (day.status === 'unreadable') this._quarantine(this.dailyFile, day.error);

    const mediumRows = envelopeRows(med);
    let dailyRows = envelopeRows(day);

    // fine holds 48h at most, so rebuilding it can never reconstruct a record
    // that is meant to last forever. The backup is consulted whenever the
    // primary yields nothing — unreadable and absent are equally fatal here.
    const bak = readJsonState(this.dailyBakFile);
    const bakRows = envelopeRows(bak);
    this.backupRows = bakRows ? bakRows.length : 0;
    this.backupAt = bakRows && typeof bak.data.savedAt === 'number' ? bak.data.savedAt : 0;
    this.backupDay = bakRows && bakRows.length ? bakRows[bakRows.length - 1].d : null;
    if (!dailyRows && bakRows) {
      dailyRows = bakRows;
      this.recovered = true;
    }

    // Each tier rebuilds independently. Taking both down together is what let a
    // single unreadable medium file destroy the daily record; they cover
    // different spans by design and have never needed to agree.
    this.medium = mediumRows || [];
    this.daily = dailyRows || [];
    if (!mediumRows || !dailyRows) {
      for (const p of this.fine) {
        if (!p || typeof p.t !== 'number' || typeof p.v !== 'number') continue;
        if (!mediumRows) foldMedium(this.medium, p.t, p.v);
        if (!dailyRows) foldDaily(this.daily, p.t, p.v, null);
      }
      this._persistDerived();
    } else if (this.recovered) {
      this._persistDerived();
    }
  }

  _quarantine(file, error) {
    const moved = quarantine(file);
    this.damage.push({
      file: path.basename(file),
      movedTo: moved ? path.basename(moved) : null,
      error: error || null
    });
  }

  /** What survived the last load, for the UI to state plainly. */
  health() {
    return {
      damaged: this.damage.slice(),
      recovered: this.recovered,
      backupAt: this.backupAt || null,
      backupRows: this.backupRows
    };
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
    this._maybeBackup(t);
  }

  /**
   * A second copy of the permanent record, written rarely on purpose. The
   * primary is rewritten every poll, which is precisely why it is the file a
   * crash catches mid-flight; a copy written once every few hours has long since
   * reached the disk. Once per session, on each day rollover, then every four
   * hours — comfortably above the four-a-day this was asked for.
   */
  _maybeBackup(t) {
    const day = this.daily.length ? this.daily[this.daily.length - 1].d : null;
    const due = !this.backupAt || day !== this.backupDay || t - this.backupAt >= DAILY_BACKUP_MS;
    if (!due) return;
    // Never trade a fuller safety copy for a thinner one: a session that starts
    // from an empty record must not be able to erase what the backup still holds.
    if (this.daily.length < this.backupRows) return;
    if (!writeJson(this.dailyBakFile, { v: TIER_VERSION, savedAt: t, rows: this.daily })) return;
    this.backupAt = t;
    this.backupDay = day;
    this.backupRows = this.daily.length;
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
    this.damage = [];
    this.recovered = false;
    writeJson(this.fineFile, this.fine);
    this._persistDerived(); // writes v:2 envelopes, so clearing != re-migrating
    // The backup is part of the record, and "clear" is meant to clear. Leaving
    // it would restore everything the user just deleted on the next launch.
    this.backupAt = Date.now();
    this.backupDay = null;
    this.backupRows = 0;
    writeJson(this.dailyBakFile, { v: TIER_VERSION, savedAt: this.backupAt, rows: [] });
  }
}

module.exports = {
  Series, segments, coverageFor, foldMedium, foldDaily,
  bucketStart, dayKey, dayStartMs,
  MEDIUM_MS, MEDIUM_RETENTION_MS, DAY_MS, DAILY_CAP, TIER_VERSION, DAILY_BACKUP_MS
};
