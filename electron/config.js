'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_ALERTS } = require('./alerts');
const { readJson, writeJson } = require('./atomic');
const { Series } = require('./history');
const { ReviewStore } = require('./reviews');
const { EventLog } = require('./events');

/**
 * Tiny zero-dependency JSON config + persistence store.
 * Lives in Electron's per-user data directory so it survives updates and
 * never gets committed to the repo.
 *
 * The store owns config and alert bookkeeping directly, and composes the three
 * larger data sets — the tiered player series, the review corpus and the event
 * log — each of which owns its own file and interface.
 */

const DEFAULTS = {
  // --- Core target ---
  appId: '3453910', // Happy's Humble Burger Cult
  gameName: "Happy's Humble Burger Cult",
  launchDate: '2026-07-16T17:00:00Z', // Steam release date (UTC-ish; edit in Settings)

  // Search terms used for Reddit / Bluesky / X / YouTube / Web discovery.
  // Includes the game's original name ("Happy's Humble Burgatory") so we catch
  // chatter that still uses it.
  keywords: [
    "Happy's Humble Burger Cult",
    'Humble Burger Cult',
    "Happy's Humble Burgatory",
    'Humble Burgatory'
  ],
  // Exact Twitch category/game name (must match Steam->Twitch listing).
  twitchGameName: "Happy's Humble Burger Cult",

  // --- Peer benchmark ---
  // Keyless: the same public GetNumberOfCurrentPlayers endpoint we use for our
  // own CCU. Night of the Consumers is deliberately absent — it reports no live
  // player data (result 42), so it would only ever render as an empty row.
  peers: [
    { appId: '1433340', name: "Happy's Humble Burger Farm" },
    { appId: '1295920', name: 'The Mortuary Assistant' },
    { appId: '2916430', name: 'Fast Food Simulator' },
    { appId: '4121170', name: 'Fears to Fathom: Scratch Creek' },
    { appId: '2881650', name: 'Content Warning' }
  ],

  // Complaint taxonomy for clustering negative reviews, as "Label: kw, kw"
  // lines. null means "use the built-in DEFAULT_TAXONOMY".
  reviewTaxonomy: null,

  // --- Credentials (optional; unlock extra sources) ---
  steamApiKey: '',
  redditClientId: '',
  redditClientSecret: '',
  twitchClientId: '',
  twitchClientSecret: '',
  youtubeApiKey: '',
  xBearerToken: '',

  // --- Behaviour ---
  refreshIntervalSec: 60,
  historyMaxPoints: 2880, // ~48h at 1/min
  alerts: DEFAULT_ALERTS,
  sources: {
    steam: true,
    reddit: true,
    bluesky: true,
    news: true,
    web: true,
    twitch: true,
    youtube: true,
    x: true,
    peers: true
  }
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'cultwatch-config.json');
    this.historyFile = path.join(userDataDir, 'cultwatch-history.json');
    this.alertStateFile = path.join(userDataDir, 'cultwatch-alertstate.json');
    this.data = this._load();
    this.alertState = readJson(this.alertStateFile, {});

    // Composed data sets — each owns its own file and interface.
    this.series = new Series(userDataDir, { maxFine: this.data.historyMaxPoints });
    this.reviewStore = new ReviewStore(userDataDir);
    this.eventLog = new EventLog(userDataDir);
  }

  getAlertState() {
    return structuredClone(this.alertState);
  }

  setAlertState(state) {
    this.alertState = state || {};
    writeJson(this.alertStateFile, this.alertState);
  }

  _load() {
    const raw = readJson(this.file, null);
    return raw ? deepMerge(structuredClone(DEFAULTS), raw) : structuredClone(DEFAULTS);
  }

  get() {
    return structuredClone(this.data);
  }

  update(patch) {
    this.data = deepMerge(this.data, patch || {});
    fs.mkdirSync(this.dir, { recursive: true });
    writeJson(this.file, this.data);
    return this.get();
  }

  // --- Player history (delegates to the tiered series) ---

  getHistory() {
    return this.series.getFine();
  }

  pushHistory(point, maxPoints, peers) {
    if (maxPoints) this.series.maxFine = maxPoints;
    this.series.push(point, peers);
  }

  /** Clears player history and the event timeline. The review corpus survives —
   *  it is not player history, and re-backfilling it would be wasteful. */
  clearHistory() {
    this.series.clear();
    this.eventLog.clear();
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
