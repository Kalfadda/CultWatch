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
    { appId: '3241660', name: 'R.E.P.O.' },
    { appId: '3949040', name: 'RV There Yet?' },
    { appId: '2916430', name: 'Fast Food Simulator' },
    { appId: '4121170', name: 'Fears to Fathom: Scratch Creek' },
    { appId: '2881650', name: 'Content Warning' }
  ],

  // --- Publisher cohort (tinyBuild) ---
  // Curated rather than scraped: Steam's publisher search works keylessly but is
  // undocumented and needs ~100 appdetails calls to strip demos, DLC and OSTs out
  // of the raw roster. The cost of curating is a list that goes stale, so every
  // row carries its release date and anything past `windowDays` is flagged in the
  // UI rather than silently skewing the comparison.
  tinybuild: {
    label: 'tinyBuild',
    windowDays: 365,
    cohort: [
      { appId: '3453910', name: "Happy's Humble Burger Cult" },
      { appId: '1431300', name: 'SAND: Raiders of Sophie' },
      { appId: '2706020', name: 'ALL WILL FALL' },
      { appId: '3326230', name: 'Hozy' },
      { appId: '1645630', name: 'FEROCIOUS' },
      { appId: '2357000', name: 'KILL IT WITH FIRE! 2' },
      { appId: '2893820', name: 'Of Ash and Steel' }
    ]
  },

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
    peers: true,
    tinybuild: true
  }
};

/**
 * Peer line-ups that shipped as the default in earlier versions.
 *
 * `peers` is editable in Settings, so once a user saves anything their stored
 * list wins over DEFAULTS forever. A stored list that still matches one of these
 * verbatim was never touched, so it is safe to advance to the current default —
 * anything else is the user's own line-up and is left alone.
 *
 * Append a new row here (never edit an old one) whenever DEFAULTS.peers changes.
 */
const LEGACY_PEER_SETS = [
  ['1433340', '1295920', '2916430', '4121170', '2881650'] // <= 1.1.1
];

function isUntouchedLegacyPeers(list) {
  if (!Array.isArray(list)) return false;
  const key = list.map((p) => String((p && p.appId) || '')).join(',');
  return LEGACY_PEER_SETS.some((set) => set.join(',') === key);
}

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'cultwatch-config.json');
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
    if (!raw) return structuredClone(DEFAULTS);
    const data = deepMerge(structuredClone(DEFAULTS), raw);
    // Idempotent and in-memory — it re-applies each launch until the next save,
    // so startup stays read-only.
    if (isUntouchedLegacyPeers(raw.peers)) data.peers = structuredClone(DEFAULTS.peers);
    return data;
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
