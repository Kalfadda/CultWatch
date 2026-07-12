'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny zero-dependency JSON config + persistence store.
 * Lives in Electron's per-user data directory so it survives updates and
 * never gets committed to the repo. Also persists the rolling player-count
 * history so the launch-day chart survives app restarts.
 */

const DEFAULTS = {
  // --- Core target ---
  appId: '3453910', // Happy's Humble Burger Cult
  gameName: "Happy's Humble Burger Cult",
  launchDate: '2026-07-16T17:00:00Z', // Steam release date (UTC-ish; edit in Settings)

  // Search terms used for Reddit / Bluesky / X / YouTube discovery.
  keywords: ["Happy's Humble Burger Cult", 'Humble Burger Cult'],
  // Exact Twitch category/game name (must match Steam->Twitch listing).
  twitchGameName: "Happy's Humble Burger Cult",

  // --- Credentials (optional; unlock extra sources) ---
  steamApiKey: '',
  twitchClientId: '',
  twitchClientSecret: '',
  youtubeApiKey: '',
  xBearerToken: '',

  // --- Behaviour ---
  refreshIntervalSec: 60,
  historyMaxPoints: 2880, // ~48h at 1/min
  sources: {
    steam: true,
    reddit: true,
    bluesky: true,
    news: true,
    twitch: true,
    youtube: true,
    x: true
  }
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'cultwatch-config.json');
    this.historyFile = path.join(userDataDir, 'cultwatch-history.json');
    this.data = this._load();
    this.history = this._loadHistory();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return deepMerge(structuredClone(DEFAULTS), raw);
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  _loadHistory() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  get() {
    return structuredClone(this.data);
  }

  update(patch) {
    this.data = deepMerge(this.data, patch || {});
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[config] failed to persist', err);
    }
    return this.get();
  }

  getHistory() {
    return this.history.slice();
  }

  pushHistory(point, maxPoints) {
    this.history.push(point);
    const cap = maxPoints || this.data.historyMaxPoints || 2880;
    if (this.history.length > cap) {
      this.history = this.history.slice(this.history.length - cap);
    }
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history));
    } catch (err) {
      console.error('[config] failed to persist history', err);
    }
  }

  clearHistory() {
    this.history = [];
    try {
      fs.writeFileSync(this.historyFile, '[]');
    } catch {}
  }
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { Store, DEFAULTS };
