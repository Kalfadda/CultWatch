'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Persisted timeline of notable moments — launch, milestones, peaks, spikes,
 * complaint surges, Steam posts. Rendered as markers on the Trends chart so the
 * player curve annotates itself instead of being a shape you have to remember
 * the reasons for.
 *
 * alerts.js stays pure; main.js writes what the engine returns into here.
 */

const CAP = 500;
const VERSION = 1;

class EventLog {
  constructor(dir) {
    this.file = path.join(dir, 'cultwatch-events.json');
    const raw = readJson(this.file, null);
    this.data = raw && raw.v === VERSION && Array.isArray(raw.rows)
      ? raw
      : { v: VERSION, rows: [] };
    this.seen = new Set(this.data.rows.map((r) => r.k));
  }

  /** events: [{ t, type, title, value?, url?, key? }] — deduped by key. */
  add(events) {
    let added = 0;
    for (const e of events || []) {
      if (!e || typeof e.t !== 'number') continue;
      const k = e.key || `${e.type}:${e.t}:${e.title || ''}`;
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      this.data.rows.push({
        k,
        t: e.t,
        type: e.type,
        title: e.title || '',
        value: e.value != null ? e.value : null,
        url: e.url || ''
      });
      added++;
    }
    if (!added) return 0;
    this.data.rows.sort((a, b) => a.t - b.t);
    if (this.data.rows.length > CAP) {
      this.data.rows = this.data.rows.slice(this.data.rows.length - CAP);
      this.seen = new Set(this.data.rows.map((r) => r.k));
    }
    writeJson(this.file, this.data);
    return added;
  }

  rows() { return this.data.rows.slice(); }
  recent(n = 60) { return this.data.rows.slice(-n); }

  clear() {
    this.data = { v: VERSION, rows: [] };
    this.seen = new Set();
    writeJson(this.file, this.data);
  }
}

module.exports = { EventLog, CAP };
