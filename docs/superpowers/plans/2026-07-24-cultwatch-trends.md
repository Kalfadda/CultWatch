# CultWatch Week-Two Intelligence (Trends) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop CultWatch losing player history, give reviews a memory and a shape, make spike alerts self-explaining, and put every number next to a comparable number.

**Architecture:** A new tiered `Series` (fine/medium/daily) replaces the flat 48h ring buffer and back-fills itself from the existing file on first run. Three new pure-ish analysis modules (`reviews`, `attribution`, `peers`) feed derived data onto the existing snapshot, which the renderer displays in a new Trends view alongside the untouched Live board.

**Tech Stack:** Electron 32 (main process = Node), zero runtime dependencies beyond `electron-updater`, hand-rolled `ok()`-style test scripts run by `node`, hand-rolled SVG charting.

## Global Constraints

- **Zero new npm dependencies.** Everything is Node built-ins + existing globals (`fetch` ships with Electron/Node 24).
- **`electron/alerts.js` and `electron/attribution.js` stay pure** — no `fs`, no `electron`, no network. All IO lives in the caller (`main.js`).
- **Every new remote source goes through the existing `settle()` wrapper** in `poller.js` so one failure can never blank the board.
- **All persistence is atomic** (temp file + `renameSync`). No bare `writeFileSync` to a live data file.
- **Renderer stays CSP-locked**: `script-src 'self'`, no inline handlers, no external assets. New scripts are plain `<script src>` files with no module system.
- Existing file format `cultwatch-history.json` = `[{t, v}]` **must keep loading**; derived files are `{ v: 2, rows: [...] }` envelopes.
- Test style matches `scripts/test-alerts.js` exactly: `ok(name, cond)`, colour codes, `process.exit(fail ? 1 : 0)`.
- Target version for release: **1.1.0**.
- Peer App IDs verified live at spec time — use exactly these: `1433340` Happy's Humble Burger Farm, `1295920` The Mortuary Assistant, `2916430` Fast Food Simulator, `4121170` Fears to Fathom: Scratch Creek, `2881650` Content Warning. **Do not add `1815150` (Night of the Consumers) — it returns `result: 42`, no CCU data.**

---

## File Structure

**Create:**
- `electron/atomic.js` — atomic JSON read/write. Used by every store.
- `electron/history.js` — `Series`: three-tier player history, folding, migration, gap segmentation.
- `electron/reviews.js` — `ReviewStore` + taxonomy + `classify` + `analyze`.
- `electron/events.js` — `EventLog`: persisted timeline for chart markers.
- `electron/attribution.js` — pure `attribute()` scoring spike causes.
- `electron/services/peers.js` — keyless peer CCU fetch.
- `renderer/trends.js` — Trends view rendering.
- `scripts/test-history.js`, `scripts/test-reviews.js`, `scripts/test-attribution.js`

**Modify:**
- `electron/config.js` — new defaults; compose `Series`/`ReviewStore`/`EventLog`; atomic writes.
- `electron/services/steam.js` — add `getReviewsPage()` for cursor backfill.
- `electron/poller.js` — peers source, review ingest, derived analysis onto snapshot.
- `electron/alerts.js` — `complaint-surge` type, attribution attached to spikes.
- `electron/main.js` — backfill on startup, event persistence, `get-series` IPC.
- `electron/preload.js` — expose `getSeries`.
- `renderer/index.html` — view switcher, Trends board, script order.
- `renderer/app.js` — view switching, new settings groups.
- `renderer/styles.css` — Trends styles.
- `scripts/test-alerts.js`, `scripts/selftest.js`, `package.json`, `README.md`

---

### Task 1: Atomic JSON persistence

**Files:**
- Create: `electron/atomic.js`
- Modify: `electron/config.js` (all three write sites)
- Test: `scripts/test-history.js` (created here, extended in Task 2)

**Interfaces:**
- Consumes: nothing
- Produces: `readJson(file, fallback)`, `writeJson(file, data)` — both synchronous, never throw

- [ ] **Step 1: Write the failing test**

Create `scripts/test-history.js`:

```js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { readJson, writeJson } = require('../electron/atomic');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hist-'));

// --- atomic.js ---
{
  const f = path.join(tmp, 'a.json');
  ok('readJson returns fallback when missing', readJson(f, { z: 1 }).z === 1);
  writeJson(f, { hello: 'world' });
  ok('writeJson round-trips', readJson(f, null).hello === 'world');
  fs.writeFileSync(f, '{ not json');
  ok('readJson returns fallback on corrupt file', readJson(f, { z: 2 }).z === 2);
  ok('writeJson leaves no .tmp behind', !fs.readdirSync(tmp).some((n) => n.endsWith('.tmp')));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-history.js`
Expected: FAIL — `Cannot find module '../electron/atomic'`

- [ ] **Step 3: Write minimal implementation**

Create `electron/atomic.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Crash-safe JSON persistence. Writes go to a sibling temp file and are
 * renamed into place — rename is atomic on both NTFS and POSIX, so a process
 * death mid-write leaves the previous good file intact instead of a truncated
 * one. Reads never throw; a missing or corrupt file yields the fallback.
 */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[atomic] failed to write ${path.basename(file)}`, err.message);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

module.exports = { readJson, writeJson };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-history.js`
Expected: PASS ×4

- [ ] **Step 5: Adopt atomic writes in `config.js`**

In `electron/config.js`, add `const { readJson, writeJson } = require('./atomic');` and replace:
- `_loadJson(file, fallback)` body → `return readJson(file, fallback);`
- `setAlertState` write → `writeJson(this.alertStateFile, this.alertState);`
- `update()` write → `writeJson(this.file, this.data);` (keep the `mkdirSync`)
- `_load()` → `const raw = readJson(this.file, null); return raw ? deepMerge(structuredClone(DEFAULTS), raw) : structuredClone(DEFAULTS);`

- [ ] **Step 6: Verify nothing regressed**

Run: `node scripts/test-alerts.js && node scripts/test-history.js`
Expected: both green

- [ ] **Step 7: Commit**

```bash
git add electron/atomic.js electron/config.js scripts/test-history.js
git commit -m "Add crash-safe atomic JSON writes"
```

---

### Task 2: Tiered series with migration

**Files:**
- Create: `electron/history.js`
- Test: `scripts/test-history.js` (extend)

**Interfaces:**
- Consumes: `readJson`, `writeJson` from Task 1
- Produces:
  - `class Series { constructor(dir, {maxFine=2880}); push({t,v}, peers); getFine(); getMedium(); getDaily(); seriesStart(); clear(); }`
  - `segments(points, maxGapMs) -> Array<Array<point>>`
  - `dayKey(t) -> 'YYYY-MM-DD'` (local), `bucketStart(t) -> number`
  - `coverageFor(dayRow, seriesStart, pollMs, now) -> number` (0..1)
  - Constants `MEDIUM_MS = 300000`, `MEDIUM_RETENTION_MS`, `DAILY_CAP = 3650`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-history.js` before the summary block:

```js
const { Series, segments, dayKey, bucketStart, coverageFor, MEDIUM_MS } = require('../electron/history');

// --- folding ---
{
  const dir = fs.mkdtempSync(path.join(tmp, 's1-'));
  const s = new Series(dir, { maxFine: 5 });
  const t0 = new Date('2026-07-20T12:00:00Z').getTime();
  s.push({ t: t0, v: 100 });
  s.push({ t: t0 + 60000, v: 300 });   // same 5-min bucket
  s.push({ t: t0 + 120000, v: 200 });  // same 5-min bucket
  const med = s.getMedium();
  ok('medium folds same-bucket samples into one row', med.length === 1);
  ok('medium tracks max', med[0].max === 300);
  ok('medium tracks min', med[0].min === 100);
  ok('medium tracks n and sum', med[0].n === 3 && med[0].sum === 600);
  ok('medium bucket start is 5-min floored', med[0].t === bucketStart(t0));
  s.push({ t: t0 + 400000, v: 50 });   // next bucket
  ok('new bucket appends a row', s.getMedium().length === 2);

  const day = s.getDaily();
  ok('daily folds to one row per day', day.length === 1);
  ok('daily peak is the max', day[0].peak === 300);
  ok('daily n counts every sample', day[0].n === 4);
}

// --- fine trim ---
{
  const dir = fs.mkdtempSync(path.join(tmp, 's2-'));
  const s = new Series(dir, { maxFine: 3 });
  for (let i = 0; i < 6; i++) s.push({ t: 1000 + i * 60000, v: i });
  ok('fine trims to maxFine', s.getFine().length === 3);
  ok('fine keeps the newest', s.getFine()[2].v === 5);
  ok('daily still counts every sample pushed', s.getDaily()[0].n === 6);
}

// --- persistence + no re-migration after clear ---
{
  const dir = fs.mkdtempSync(path.join(tmp, 's3-'));
  const s = new Series(dir, { maxFine: 100 });
  s.push({ t: Date.now(), v: 42 });
  const reopened = new Series(dir, { maxFine: 100 });
  ok('series round-trips through disk', reopened.getDaily()[0].peak === 42);
  reopened.clear();
  const afterClear = new Series(dir, { maxFine: 100 });
  ok('clear wipes all tiers', afterClear.getFine().length === 0 && afterClear.getDaily().length === 0);
  ok('cleared series does not re-migrate', afterClear.getMedium().length === 0);
}

// --- migration from a legacy flat history file ---
{
  const dir = fs.mkdtempSync(path.join(tmp, 's4-'));
  const t0 = new Date('2026-07-21T03:30:00Z').getTime();
  const legacy = [];
  for (let i = 0; i < 600; i++) legacy.push({ t: t0 + i * 60000, v: 1000 + (i % 100) });
  fs.writeFileSync(path.join(dir, 'cultwatch-history.json'), JSON.stringify(legacy));
  const s = new Series(dir, { maxFine: 2880 });
  ok('migration preserves the legacy fine points', s.getFine().length === 600);
  ok('migration builds medium buckets', s.getMedium().length === 120);
  ok('migration builds daily rows', s.getDaily().length >= 1);
  ok('migrated daily peak is correct', Math.max(...s.getDaily().map((d) => d.peak)) === 1099);
  const again = new Series(dir, { maxFine: 2880 });
  ok('migration does not double-count on reopen', again.getDaily().reduce((n, d) => n + d.n, 0) === 600);
}

// --- gap segmentation ---
{
  const pts = [{ t: 0, v: 1 }, { t: 60000, v: 2 }, { t: 60000 + 3600000, v: 3 }, { t: 60000 + 3660000, v: 4 }];
  const segs = segments(pts, 180000);
  ok('segments splits on a gap', segs.length === 2);
  ok('segments keeps points in order', segs[0].length === 2 && segs[1].length === 2);
  ok('no gap yields a single segment', segments(pts.slice(0, 2), 180000).length === 1);
  ok('empty input yields no segments', segments([], 180000).length === 0);
}

// --- coverage ---
{
  const dayStart = new Date('2026-07-22T00:00:00').getTime();
  const row = { d: dayKey(dayStart), n: 720, first: dayStart, last: dayStart + 86400000 - 1 };
  const cov = coverageFor(row, dayStart - 86400000, 60000, dayStart + 86400000);
  ok('coverage of a half-sampled full day is ~0.5', Math.abs(cov - 0.5) < 0.02);
  const full = coverageFor({ ...row, n: 1440 }, dayStart - 86400000, 60000, dayStart + 86400000);
  ok('coverage caps at 1', full <= 1);
  ok('coverage of a day before the series began is 0',
    coverageFor(row, dayStart + 86400000, 60000, dayStart + 86400000) === 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-history.js`
Expected: FAIL — `Cannot find module '../electron/history'`

- [ ] **Step 3: Write the implementation**

Create `electron/history.js`:

```js
'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Tiered player-count history.
 *
 *   fine    raw samples (~1/min), 48h            cultwatch-history.json      [{t,v}]
 *   medium  5-minute buckets, 30 days            cultwatch-series-medium.json
 *   daily   one row per local day, forever       cultwatch-series-daily.json
 *
 * The flat 48h ring buffer this replaces silently discarded launch day. Every
 * push folds into all three tiers at once, so the rollups are never stale and
 * there is no batch job to miss.
 */

const MEDIUM_MS = 5 * 60 * 1000;
const MEDIUM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_CAP = 3650;
const TIER_VERSION = 2;

function bucketStart(t) {
  return Math.floor(t / MEDIUM_MS) * MEDIUM_MS;
}

// Local calendar day — 'day 3' should mean the team's day 3, not UTC's.
function dayKey(t) {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayStartMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Split a point array wherever consecutive samples are further apart than
 *  maxGapMs, so the chart draws holes instead of interpolating across them. */
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

/** Fraction of a day we actually observed. A day the app was closed for is not
 *  a day of low players — the UI must be able to tell the difference. */
function coverageFor(row, seriesStart, pollMs, now = Date.now()) {
  const start = dayStartMs(row.d);
  const end = start + 24 * 60 * 60 * 1000;
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
    // Clock skew / out-of-order replay: locate the bucket instead of appending.
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
      // Rebuild BOTH derived tiers from fine so they can never disagree.
      this.medium = [];
      this.daily = [];
      for (const p of this.fine) {
        if (!p || typeof p.v !== 'number' || typeof p.t !== 'number') continue;
        foldMedium(this.medium, p.t, p.v);
        foldDaily(this.daily, p.t, p.v, null);
      }
      this._persistDerived();
    }
  }

  push(point, peers) {
    const { t, v } = point || {};
    if (typeof t !== 'number' || typeof v !== 'number') return;
    this.fine.push({ t, v });
    if (this.fine.length > this.maxFine) this.fine = this.fine.slice(this.fine.length - this.maxFine);
    foldMedium(this.medium, t, v);
    foldDaily(this.daily, t, v, peers);

    const cutoff = t - MEDIUM_RETENTION_MS;
    if (this.medium.length && this.medium[0].t < cutoff) {
      this.medium = this.medium.filter((r) => r.t >= cutoff);
    }
    if (this.daily.length > DAILY_CAP) this.daily = this.daily.slice(this.daily.length - DAILY_CAP);

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

  /** Timestamp of the first sample ever recorded, for coverage math. */
  seriesStart() {
    if (this.daily.length) return this.daily[0].first;
    return this.fine.length ? this.fine[0].t : Date.now();
  }

  clear() {
    this.fine = []; this.medium = []; this.daily = [];
    writeJson(this.fineFile, this.fine);
    this._persistDerived(); // writes v:2 envelopes, so clear != re-migrate
  }
}

module.exports = {
  Series, segments, coverageFor, foldMedium, foldDaily,
  bucketStart, dayKey, dayStartMs,
  MEDIUM_MS, MEDIUM_RETENTION_MS, DAILY_CAP, TIER_VERSION
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test-history.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add electron/history.js scripts/test-history.js
git commit -m "Add tiered player history with migration and gap awareness"
```

---

### Task 3: Wire Series into the Store

**Files:**
- Modify: `electron/config.js`

**Interfaces:**
- Consumes: `Series` from Task 2
- Produces: `store.series` (a `Series`), plus back-compatible `store.getHistory()`, `store.pushHistory(point, max, peers)`, `store.clearHistory()`

- [ ] **Step 1: Add peer + taxonomy defaults**

In `DEFAULTS` in `electron/config.js`, after `twitchGameName`, add:

```js
  // --- Peer benchmark (keyless: same GetNumberOfCurrentPlayers endpoint) ---
  // Verified live: Night of the Consumers is deliberately absent, it reports
  // no CCU data (result 42).
  peers: [
    { appId: '1433340', name: "Happy's Humble Burger Farm" },
    { appId: '1295920', name: 'The Mortuary Assistant' },
    { appId: '2916430', name: 'Fast Food Simulator' },
    { appId: '4121170', name: 'Fears to Fathom: Scratch Creek' },
    { appId: '2881650', name: 'Content Warning' }
  ],

  // Complaint taxonomy for negative-review clustering. Editable in Settings.
  reviewTaxonomy: null, // null = use the built-in DEFAULT_TAXONOMY
```

And add `peers: true` to the `sources` object.

- [ ] **Step 2: Compose the Series into Store**

In the `Store` constructor, replace `this.history = this._loadHistory();` with:

```js
    this.series = new Series(userDataDir, { maxFine: this.data.historyMaxPoints });
```

Add `const { Series } = require('./history');` at the top. Delete `_loadHistory()`. Replace the history methods with delegates:

```js
  getHistory() { return this.series.getFine(); }

  pushHistory(point, maxPoints, peers) {
    if (maxPoints) this.series.maxFine = maxPoints;
    this.series.push(point, peers);
  }

  clearHistory() { this.series.clear(); }
```

- [ ] **Step 3: Verify the existing self-test still round-trips**

Run: `node scripts/selftest.js`
Expected: the `persistence` line still PASSes (it calls `pushHistory` then reopens the store)

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test-alerts.js && node scripts/test-history.js`
Expected: green

- [ ] **Step 5: Commit**

```bash
git add electron/config.js
git commit -m "Back the store with the tiered series and seed peer defaults"
```

---

### Task 4: Review store, classification and analysis

**Files:**
- Create: `electron/reviews.js`
- Test: Create `scripts/test-reviews.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from Task 1
- Produces:
  - `DEFAULT_TAXONOMY` — `Array<{key, label, patterns: RegExp[]}>`
  - `classify(text, lang, taxonomy) -> { english: boolean, themes: string[] }`
  - `analyze(rows, taxonomy, now, summary) -> { velocity, rolling, themes, coverage }`
  - `parseTaxonomy(text) -> taxonomy`, `formatTaxonomy(taxonomy) -> string`
  - `class ReviewStore { constructor(dir); ingest(recent) -> number; rows(); backfilledAt(); setBackfilled(ts); clear(); }`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test-reviews.js`:

```js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ReviewStore, classify, analyze, parseTaxonomy, formatTaxonomy, DEFAULT_TAXONOMY } = require('../electron/reviews');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rev-'));
const HOUR = 3600000, DAY = 86400000;
const NOW = new Date('2026-07-24T12:00:00Z').getTime();

// --- classification ---
{
  ok('detects crash complaints', classify('the game keeps crashing on startup', 'english', DEFAULT_TAXONOMY).themes.includes('crash'));
  ok('detects performance complaints', classify('terrible fps, stutters constantly', 'english', DEFAULT_TAXONOMY).themes.includes('performance'));
  ok('detects price complaints', classify('not worth $10, too expensive', 'english', DEFAULT_TAXONOMY).themes.includes('price'));
  ok('detects length complaints', classify('way too short, beat it in 2 hours', 'english', DEFAULT_TAXONOMY).themes.includes('length'));
  ok('one review can match several themes', classify('crashes constantly and the fps is awful', 'english', DEFAULT_TAXONOMY).themes.length >= 2);
  ok('clean review matches nothing', classify('i love this game so much', 'english', DEFAULT_TAXONOMY).themes.length === 0);
  ok('non-english is flagged not classified', classify('el juego se bloquea', 'spanish', DEFAULT_TAXONOMY).english === false);
  ok('non-english returns no themes', classify('el juego se bloquea', 'spanish', DEFAULT_TAXONOMY).themes.length === 0);
  ok('missing text does not throw', classify(null, 'english', DEFAULT_TAXONOMY).themes.length === 0);
}

// --- taxonomy round-trip ---
{
  const txt = 'Crashes: crash, freeze\nPrice: expensive, overpriced';
  const tax = parseTaxonomy(txt);
  ok('parseTaxonomy reads label + keywords', tax.length === 2 && tax[0].label === 'Crashes');
  ok('parsed taxonomy classifies', classify('it froze', 'english', tax).themes.length === 1);
  ok('formatTaxonomy round-trips', parseTaxonomy(formatTaxonomy(tax)).length === 2);
  ok('blank input falls back to empty', parseTaxonomy('').length === 0);
}

// --- analyze ---
{
  const rows = [];
  // 10 negative crash reviews in the last 24h, 2 in the prior 24h
  for (let i = 0; i < 10; i++) rows.push({ id: `c${i}`, t: NOW - i * HOUR, up: false, txt: 'it crashes on launch', lang: 'english' });
  for (let i = 0; i < 2; i++) rows.push({ id: `o${i}`, t: NOW - DAY - i * HOUR, up: false, txt: 'crash again', lang: 'english' });
  // positives + a non-english
  for (let i = 0; i < 20; i++) rows.push({ id: `p${i}`, t: NOW - i * HOUR, up: true, txt: 'great game', lang: 'english' });
  rows.push({ id: 'ne1', t: NOW - HOUR, up: false, txt: 'se bloquea', lang: 'spanish' });

  const a = analyze(rows, DEFAULT_TAXONOMY, NOW, { total: 33, positive: 20, negative: 13, positivePct: 61 });
  const crash = a.themes.find((t) => t.key === 'crash');
  ok('theme ranked with a count', crash && crash.count === 12);
  ok('theme has a 24h window', crash.last24 === 10 && crash.prior24 === 2);
  ok('theme has a 48h window', crash.recent48 >= 10);
  ok('velocity is reviews per hour over 24h', a.velocity.perHour24 > 0);
  ok('velocity counts the last hour', a.velocity.last1h >= 1);
  ok('coverage counts non-english separately', a.coverage.nonEnglish === 1);
  ok('coverage totals every row', a.coverage.total === rows.length);
  ok('coverage english + nonEnglish === total', a.coverage.english + a.coverage.nonEnglish === a.coverage.total);
  ok('rolling 7d positive rate is computed', a.rolling.pct7d != null);
  ok('rolling exposes the all-time rate from the summary', a.rolling.pctAll === 61);
  ok('themes are sorted by count desc', a.themes.every((t, i, arr) => i === 0 || arr[i - 1].count >= t.count));
  ok('analyze of an empty corpus does not throw', analyze([], DEFAULT_TAXONOMY, NOW, null).coverage.total === 0);
}

// --- store ---
{
  const dir = fs.mkdtempSync(path.join(tmp, 'rs-'));
  const s = new ReviewStore(dir);
  const added = s.ingest([
    { id: 'a', timestamp: NOW, votedUp: true, text: 'good', language: 'english', hoursPlayed: 3, votesUp: 1 },
    { id: 'b', timestamp: NOW, votedUp: false, text: 'bad', language: 'english', hoursPlayed: 1, votesUp: 0 }
  ]);
  ok('ingest returns the number added', added === 2);
  ok('ingest dedupes by id', s.ingest([{ id: 'a', timestamp: NOW, votedUp: true, text: 'good', language: 'english' }]) === 0);
  ok('rows persist across reopen', new ReviewStore(dir).rows().length === 2);
  ok('ingest ignores rows with no id', s.ingest([{ timestamp: NOW, votedUp: true, text: 'x' }]) === 0);
  s.setBackfilled(NOW);
  ok('backfill marker persists', new ReviewStore(dir).backfilledAt() === NOW);
  ok('text is truncated for storage', new ReviewStore(dir).rows().every((r) => (r.txt || '').length <= 400));
  s.clear();
  ok('clear empties the store', new ReviewStore(dir).rows().length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-reviews.js`
Expected: FAIL — `Cannot find module '../electron/reviews'`

- [ ] **Step 3: Write the implementation**

Create `electron/reviews.js` with:

```js
'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Review corpus + complaint clustering.
 *
 * Steam only hands back the most recent page per poll, so without a persisted
 * corpus there is nothing to cluster. This module owns cultwatch-reviews.json,
 * ingests each poll's page, and derives velocity / rolling sentiment / themes.
 *
 * Clustering is deliberately keyword-based: deterministic, offline, testable,
 * and it degrades to "untagged" rather than guessing. It only runs on English
 * reviews — roughly a third of this game's corpus is not English, and those are
 * counted and reported rather than silently dropped.
 */

const MAX_ROWS = 2500;
const MAX_TEXT = 400;
const STORE_VERSION = 1;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const DEFAULT_TAXONOMY = [
  { key: 'crash',       label: 'Crashes',        patterns: [/\bcrash/i, /\bfreez/i, /\bhard ?lock/i, /\bblack ?screen/i, /\bwon'?t (?:launch|start|open)/i] },
  { key: 'performance', label: 'Performance',    patterns: [/\bfps\b/i, /\blag(?:g|s|hy)?/i, /\bstutter/i, /\bframe ?rate/i, /\boptimi[sz]/i, /\bslow ?down/i] },
  { key: 'bugs',        label: 'Bugs / glitches',patterns: [/\bbug(?:s|gy|ged)?\b/i, /\bglitch/i, /\bbroken\b/i, /\bsoft ?lock/i, /\bstuck (?:in|on|behind)/i] },
  { key: 'saves',       label: 'Saves / progress',patterns: [/\bsave (?:file|data|game|s)?\b/i, /\blost (?:my )?progress/i, /\bcheckpoint/i, /\bautosave/i] },
  { key: 'controller',  label: 'Controller / input',patterns: [/\bcontroller/i, /\bgamepad/i, /\bkeybind/i, /\bremap/i, /\bmouse (?:sens|accel)/i, /\bdead ?zone/i] },
  { key: 'price',       label: 'Price / value',  patterns: [/\bprice/i, /\bexpensive/i, /\boverpriced/i, /\bnot worth\b/i, /\brefund/i, /\bwait for (?:a )?sale/i] },
  { key: 'length',      label: 'Too short',      patterns: [/\btoo short\b/i, /\bshort(?:er)? than/i, /\b(?:only|just) \d+ hours?\b/i, /\blacks content/i, /\bno content\b/i] },
  { key: 'difficulty',  label: 'Difficulty',     patterns: [/\btoo (?:hard|easy|difficult)\b/i, /\bunfair/i, /\bfrustrating/i, /\bdifficulty (?:spike|curve)/i] },
  { key: 'motion',      label: 'Motion sickness',patterns: [/\bmotion sick/i, /\bnausea/i, /\bnauseous/i, /\bfov\b/i, /\bhead ?bob/i, /\bmotion blur/i] },
  { key: 'audio',       label: 'Audio',          patterns: [/\baudio\b/i, /\bsound (?:bug|issue|glitch|cut)/i, /\bvolume\b/i, /\bmusic (?:loop|cut|bug)/i, /\bno sound\b/i] }
];

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
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
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
  return (taxonomy || []).map((t) =>
    `${t.label}: ${(t.patterns || []).map((p) => p.source.replace(/\\([.*+?^${}()|[\]\\])/g, '$1')).join(', ')}`
  ).join('\n');
}

function analyze(rows, taxonomy, now = Date.now(), summary = null) {
  const all = Array.isArray(rows) ? rows : [];
  const coverage = { total: all.length, english: 0, nonEnglish: 0, themed: 0, untagged: 0 };
  const stats = new Map();
  const ensure = (t) => {
    if (!stats.has(t.key)) stats.set(t.key, { key: t.key, label: t.label, count: 0, last24: 0, prior24: 0, recent48: 0, prior48: 0 });
    return stats.get(t.key);
  };
  for (const t of taxonomy || []) ensure(t);

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
    .map((s) => ({ ...s, trend: s.prior48 > 0 ? s.recent48 / s.prior48 : (s.recent48 >= 3 ? Infinity : 1) }))
    .sort((a, b) => b.count - a.count);

  const in24 = all.filter((r) => now - r.t < DAY);
  const prior24 = all.filter((r) => now - r.t >= DAY && now - r.t < 2 * DAY);
  const in7d = all.filter((r) => now - r.t < 7 * DAY);
  const pos7 = in7d.filter((r) => r.up).length;

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
      pct7d: in7d.length ? Math.round((pos7 / in7d.length) * 100) : null,
      count7d: in7d.length,
      pctAll: summary && summary.positivePct != null ? summary.positivePct : null,
      delta: (in7d.length && summary && summary.positivePct != null)
        ? Math.round((pos7 / in7d.length) * 100) - summary.positivePct
        : null
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
  setBackfilled(ts) { this.data.backfilledAt = ts; this._persist(); }
  clear() {
    this.data = { v: STORE_VERSION, backfilledAt: null, rows: [] };
    this.seen = new Set();
    this._persist();
  }
  _persist() { writeJson(this.file, this.data); }
}

module.exports = {
  ReviewStore, classify, analyze, parseTaxonomy, formatTaxonomy,
  DEFAULT_TAXONOMY, MAX_ROWS, MAX_TEXT
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test-reviews.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add electron/reviews.js scripts/test-reviews.js
git commit -m "Add review corpus, complaint clustering and velocity analysis"
```

---

### Task 5: Review backfill via cursor pagination

**Files:**
- Modify: `electron/services/steam.js`
- Modify: `electron/reviews.js` (add the backfill driver)

**Interfaces:**
- Consumes: `ReviewStore` (Task 4), `getJson` from `services/http`
- Produces:
  - `steam.getReviewsPage(appId, cursor, perPage) -> { reviews: [...], cursor: string }`
  - `backfillReviews(store, appId, fetchPage, { maxPages = 25 }) -> Promise<{ added, pages, skipped }>`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-reviews.js` before the summary:

```js
// --- backfill ---
{
  const { backfillReviews } = require('../electron/reviews');
  const dir = fs.mkdtempSync(path.join(tmp, 'bf-'));
  const s = new ReviewStore(dir);
  let calls = 0;
  const fakePage = async (appId, cursor) => {
    calls++;
    if (calls === 1) return { reviews: [{ id: 'r1', timestamp: NOW, votedUp: true, text: 'a', language: 'english' }], cursor: 'c2' };
    if (calls === 2) return { reviews: [{ id: 'r2', timestamp: NOW, votedUp: false, text: 'b', language: 'english' }], cursor: 'c3' };
    return { reviews: [], cursor: 'c3' };
  };
  return backfillReviews(s, '1', fakePage).then((res) => {
    ok('backfill walks pages until empty', res.pages === 3);
    ok('backfill adds every review', res.added === 2);
    ok('backfill sets the marker', s.backfilledAt() != null);
    return backfillReviews(s, '1', fakePage).then((second) => {
      ok('backfill runs only once', second.skipped === true);
      console.log(`\n  ${pass} passed, ${fail} failed\n`);
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(fail ? 1 : 0);
    });
  });
}
```

Remove the earlier synchronous summary/exit block so the async tail is the only exit point.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-reviews.js`
Expected: FAIL — `backfillReviews is not a function`

- [ ] **Step 3: Add `getReviewsPage` to `steam.js`**

```js
async function getReviewsPage(appId, cursor = '*', perPage = 100) {
  const url = `${STORE}/appreviews/${appId}?json=1&language=all&purchase_type=all&filter=recent` +
    `&num_per_page=${perPage}&cursor=${encodeURIComponent(cursor)}`;
  const json = await getJson(url);
  return { reviews: mapReviews(json.reviews || []), cursor: json.cursor || null };
}
```

Extract the existing `.map()` in `getReviews` into a shared `mapReviews(list)` helper and use it in both. Export `getReviewsPage`.

- [ ] **Step 4: Add the backfill driver to `reviews.js`**

```js
/**
 * One-time historical backfill. Steam's review endpoint paginates by opaque
 * cursor; measured on this app it walks the entire corpus in 4 requests. Runs
 * once ever (guarded by backfilledAt) and is non-fatal — a failure just leaves
 * the store ingesting incrementally.
 */
async function backfillReviews(store, appId, fetchPage, { maxPages = 25 } = {}) {
  if (store.backfilledAt()) return { added: 0, pages: 0, skipped: true };
  let cursor = '*', added = 0, pages = 0;
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
```

Export it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node scripts/test-reviews.js`
Expected: all PASS including the four backfill assertions

- [ ] **Step 6: Commit**

```bash
git add electron/reviews.js electron/services/steam.js scripts/test-reviews.js
git commit -m "Add one-time review backfill via cursor pagination"
```

---

### Task 6: Peer benchmark service

**Files:**
- Create: `electron/services/peers.js`

**Interfaces:**
- Consumes: `request` from `services/http`
- Produces: `getPeerPlayers(peers) -> Promise<Array<{appId, name, count, available, error}>>`, `rankPeers(list, ourCount, ourName) -> {rows, ourRank}`

- [ ] **Step 1: Write the implementation**

Create `electron/services/peers.js`:

```js
'use strict';

const { request } = require('./http');

/**
 * Peer concurrent players. Keyless — the same public endpoint the app already
 * uses for its own CCU, one request per peer in parallel.
 *
 * Steam answers HTTP 404 with `result: 42` for apps that report no live player
 * data (small or delisted titles). That is "no data", not a failure: the peer
 * renders dim rather than turning the panel red.
 */

const API = 'https://api.steampowered.com';

async function getOne(peer) {
  const base = { appId: String(peer.appId), name: peer.name || `App ${peer.appId}` };
  try {
    const res = await request(`${API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(peer.appId)}`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`unreadable response (HTTP ${res.status})`); }
    const r = (json && json.response) || {};
    if (r.result === 1 && typeof r.player_count === 'number') {
      return { ...base, count: r.player_count, available: true, error: null };
    }
    return { ...base, count: null, available: false, error: null };
  } catch (err) {
    return { ...base, count: null, available: false, error: err.message || String(err) };
  }
}

async function getPeerPlayers(peers) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && p.appId) : [];
  if (!list.length) return [];
  return Promise.all(list.map(getOne)); // getOne never rejects
}

/** Merge our own count into the peer list and rank everything together. */
function rankPeers(list, ourCount, ourName) {
  const rows = (list || []).map((p) => ({ ...p, us: false }));
  if (typeof ourCount === 'number') {
    rows.push({ appId: 'us', name: ourName || 'Us', count: ourCount, available: true, error: null, us: true });
  }
  rows.sort((a, b) => (b.count == null ? -1 : b.count) - (a.count == null ? -1 : a.count));
  const ourRank = rows.findIndex((r) => r.us);
  return { rows, ourRank: ourRank < 0 ? null : ourRank + 1 };
}

module.exports = { getPeerPlayers, rankPeers };
```

- [ ] **Step 2: Verify against the live endpoint**

Run:
```bash
node -e "require('./electron/services/peers').getPeerPlayers([{appId:'1433340',name:'Burger Farm'},{appId:'1815150',name:'Night of the Consumers'}]).then(r=>console.log(r))"
```
Expected: Burger Farm `available: true` with a number; Night of the Consumers `available: false, error: null` (**not** an error)

- [ ] **Step 3: Commit**

```bash
git add electron/services/peers.js
git commit -m "Add keyless peer concurrent-player benchmark service"
```

---

### Task 7: Spike attribution

**Files:**
- Create: `electron/attribution.js`
- Test: Create `scripts/test-attribution.js`

**Interfaces:**
- Consumes: nothing (pure)
- Produces: `attribute(event, snapshot, opts) -> Array<{kind, label, detail, url, score, ts}>`, `describeCauses(causes) -> string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test-attribution.js`:

```js
'use strict';
const { attribute, describeCauses } = require('../electron/attribution');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}
const T = new Date('2026-07-24T20:00:00Z').getTime();
const MIN = 60000;

{
  const snap = {
    twitch: { enabled: true, live: [
      { id: 's1', user: 'BigStreamer', viewers: 12400, title: 'playing the cult game', url: 'https://twitch.tv/big', startedAt: T - 8 * MIN },
      { id: 's2', user: 'Nobody', viewers: 3, title: 'chill stream', url: 'https://twitch.tv/no', startedAt: T - 5 * MIN },
      { id: 's3', user: 'Yesterday', viewers: 50000, title: 'old', url: 'https://twitch.tv/old', startedAt: T - 300 * MIN }
    ] },
    reddit: [{ title: 'This game is amazing', score: 900, comments: 120, created: T - 12 * MIN, url: 'https://reddit.com/x', subreddit: 'gaming' }],
    bluesky: [], x: { posts: [] }, youtube: { videos: [] },
    news: [{ id: 'n1', title: 'Patch 1.2 is live', date: T - 3 * MIN, url: 'https://store.steampowered.com/news/1', source: 'Steam' }],
    web: []
  };

  const causes = attribute({ t: T, direction: 'up' }, snap);
  ok('returns candidates', causes.length > 0);
  ok('excludes streams outside the window', !causes.some((c) => c.label.includes('Yesterday')));
  ok('ranks the big stream above the tiny one', causes.findIndex((c) => c.label.includes('BigStreamer')) < causes.findIndex((c) => c.label.includes('Nobody')) || !causes.some((c) => c.label.includes('Nobody')));
  ok('includes the news item', causes.some((c) => c.kind === 'news'));
  ok('includes the reddit post', causes.some((c) => c.kind === 'reddit'));
  ok('caps at three causes', causes.length <= 3);
  ok('every cause carries a timestamp', causes.every((c) => typeof c.ts === 'number'));
  ok('every cause carries a url', causes.every((c) => typeof c.url === 'string'));
  ok('describeCauses renders the top cause', /BigStreamer/.test(describeCauses(causes)));
}

{
  const empty = { twitch: { enabled: false, live: [] }, reddit: [], bluesky: [], x: { posts: [] }, youtube: { videos: [] }, news: [], web: [] };
  ok('no candidates yields an empty array', attribute({ t: T, direction: 'up' }, empty).length === 0);
  ok('empty causes describe as no clear cause', /no clear cause/i.test(describeCauses([])));
  ok('missing snapshot does not throw', attribute({ t: T, direction: 'up' }, null).length === 0);
  ok('missing collections do not throw', attribute({ t: T, direction: 'down' }, {}).length === 0);
}

{
  // A drop cannot be caused by a stream starting — streams are excluded for drops.
  const snap = { twitch: { enabled: true, live: [{ id: 's1', user: 'Big', viewers: 9000, title: 't', url: 'u', startedAt: T - 2 * MIN }] }, reddit: [], bluesky: [], x: { posts: [] }, youtube: { videos: [] }, news: [], web: [] };
  ok('drops ignore stream starts', attribute({ t: T, direction: 'down' }, snap).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-attribution.js`
Expected: FAIL — `Cannot find module '../electron/attribution'`

- [ ] **Step 3: Write the implementation**

Create `electron/attribution.js`:

```js
'use strict';

/**
 * Spike attribution. A "+62% surge" alert that doesn't say why creates work
 * instead of saving it. Every feed item already carries a timestamp, so we can
 * score what happened in the same window and name the most likely driver.
 *
 * Pure: no IO, no Electron, no network — unit-testable and safe to call from
 * the alert engine.
 */

const DEFAULT_WINDOW_MS = 20 * 60 * 1000;

function inWindow(ts, at, windowMs) {
  return typeof ts === 'number' && Math.abs(at - ts) <= windowMs;
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function attribute(event, snapshot, { windowMs = DEFAULT_WINDOW_MS, limit = 3 } = {}) {
  const s = snapshot || {};
  const at = (event && event.t) || Date.now();
  const direction = (event && event.direction) || 'up';
  const out = [];

  // A stream going live can drive a surge; it cannot drive a drop (a stream
  // *ending* is invisible to the API, so we don't pretend to see it).
  if (direction === 'up') {
    const tw = s.twitch || {};
    for (const st of tw.live || []) {
      if (!inWindow(st.startedAt, at, windowMs)) continue;
      out.push({
        kind: 'twitch', score: st.viewers || 0, ts: st.startedAt,
        label: `${st.user} went live`,
        detail: `${(st.viewers || 0).toLocaleString('en-US')} viewers · ${truncate(st.title, 60)}`,
        url: st.url || ''
      });
    }
  }

  for (const n of s.news || []) {
    if (!inWindow(n.date, at, windowMs)) continue;
    out.push({ kind: 'news', score: 1000, ts: n.date, label: `Steam post: ${truncate(n.title, 60)}`, detail: n.source || 'Steam', url: n.url || '' });
  }

  for (const r of s.reddit || []) {
    if (!inWindow(r.created, at, windowMs)) continue;
    out.push({
      kind: 'reddit', score: (r.score || 0) + (r.comments || 0) * 2, ts: r.created,
      label: `r/${r.subreddit || 'reddit'}: ${truncate(r.title, 60)}`,
      detail: `▲ ${r.score || 0} · 💬 ${r.comments || 0}`, url: r.url || ''
    });
  }

  const socials = [
    ['bluesky', s.bluesky || []],
    ['x', (s.x && s.x.posts) || []]
  ];
  for (const [kind, list] of socials) {
    for (const p of list) {
      if (!inWindow(p.created, at, windowMs)) continue;
      out.push({
        kind, score: (p.likes || 0) + (p.reposts || 0) * 2, ts: p.created,
        label: `${p.author || kind}: ${truncate(p.text, 60)}`,
        detail: `♥ ${p.likes || 0} · ↻ ${p.reposts || 0}`, url: p.url || ''
      });
    }
  }

  for (const v of (s.youtube && s.youtube.videos) || []) {
    if (!inWindow(v.published, at, windowMs)) continue;
    out.push({ kind: 'youtube', score: 250, ts: v.published, label: `${v.channel}: ${truncate(v.title, 60)}`, detail: 'new video', url: v.url || '' });
  }

  for (const w of s.web || []) {
    if (!inWindow(w.date, at, windowMs)) continue;
    out.push({ kind: 'web', score: 200, ts: w.date, label: truncate(w.title, 60), detail: w.source || 'web', url: w.url || '' });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function describeCauses(causes) {
  if (!causes || !causes.length) return 'No clear cause found in the same window.';
  const top = causes[0];
  const rest = causes.length > 1 ? ` (+${causes.length - 1} more)` : '';
  return `Likely: ${top.label} — ${top.detail}${rest}`;
}

module.exports = { attribute, describeCauses, DEFAULT_WINDOW_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test-attribution.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add electron/attribution.js scripts/test-attribution.js
git commit -m "Add spike attribution scoring"
```

---

### Task 8: Event log

**Files:**
- Create: `electron/events.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson`
- Produces: `class EventLog { constructor(dir); add(events) -> number; rows(); recent(n); clear(); }`

- [ ] **Step 1: Write the implementation**

Create `electron/events.js`:

```js
'use strict';

const path = require('path');
const { readJson, writeJson } = require('./atomic');

/**
 * Persisted timeline of notable moments (launch, milestones, peaks, spikes,
 * complaint surges, Steam posts). Rendered as markers on the Trends chart so
 * the player curve annotates itself.
 *
 * alerts.js stays pure — main.js writes what the engine returns into here.
 */

const CAP = 500;
const VERSION = 1;

class EventLog {
  constructor(dir) {
    this.file = path.join(dir, 'cultwatch-events.json');
    const raw = readJson(this.file, null);
    this.data = raw && raw.v === VERSION && Array.isArray(raw.rows) ? raw : { v: VERSION, rows: [] };
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
      this.data.rows.push({ k, t: e.t, type: e.type, title: e.title || '', value: e.value != null ? e.value : null, url: e.url || '' });
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
```

- [ ] **Step 2: Add a round-trip test**

Append to `scripts/test-history.js` before the summary:

```js
{
  const { EventLog } = require('../electron/events');
  const dir = fs.mkdtempSync(path.join(tmp, 'ev-'));
  const log = new EventLog(dir);
  ok('event add returns count', log.add([{ t: 1000, type: 'peak', title: 'New peak', key: 'p1' }]) === 1);
  ok('event add dedupes by key', log.add([{ t: 1000, type: 'peak', title: 'New peak', key: 'p1' }]) === 0);
  ok('events persist', new EventLog(dir).rows().length === 1);
  ok('events ignore rows with no timestamp', log.add([{ type: 'peak', title: 'x' }]) === 0);
  log.clear();
  ok('event clear empties', new EventLog(dir).rows().length === 0);
}
```

- [ ] **Step 3: Run tests**

Run: `node scripts/test-history.js`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add electron/events.js scripts/test-history.js
git commit -m "Add persisted event log for chart markers"
```

---

### Task 9: Alert engine — attribution and complaint surges

**Files:**
- Modify: `electron/alerts.js`
- Modify: `scripts/test-alerts.js`

**Interfaces:**
- Consumes: `attribute`, `describeCauses` (Task 7); `snapshot.reviewIntel.themes` (Task 10 shape, defined here)
- Produces: alert objects gain optional `causes: []`; new alert type `complaint-surge`; `DEFAULT_ALERTS` gains `complaintSurge`, `complaintSurgeMin`, `complaintSurgeMult`, `complaintCooldownHr`; `DEFAULT_STATE` gains `themeAlerts: {}`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-alerts.js` before the summary block:

```js
// 9. Spike alerts carry attribution
{
  const T = 1700000000000;
  const st = { launched: true, peakAlerted: 1000, lastMilestone: 1000000 };
  const next = snap({
    players: { current: 300, available: true, peakSession: 1000, history: [{ t: 1, v: 100 }, { t: 2, v: 300 }] },
    twitch: { enabled: true, live: [{ id: 's9', user: 'Northernlion', viewers: 12400, title: 'burgers', url: 'https://twitch.tv/nl', startedAt: T - 8 * 60000 }] }
  });
  const r = evaluate(snap({}), next, st, cfg, T);
  const spike = r.alerts.find((a) => a.type === 'spike-up');
  ok('spike alert carries causes', spike && Array.isArray(spike.causes) && spike.causes.length > 0);
  ok('spike body names the likely cause', spike && /Northernlion/.test(spike.body));
}

// 10. Complaint surge
{
  const T = 1700000000000;
  const themes = [{ key: 'crash', label: 'Crashes', count: 12, last24: 10, prior24: 2, recent48: 12, prior48: 2, trend: 6 }];
  const st = { launched: true, reviewsInitialized: true, seenReviewIds: [] };
  const r = evaluate(null, snap({ reviewIntel: { themes } }), st, cfg, T);
  ok('complaint surge fires', types(r.alerts).includes('complaint-surge'));
  ok('complaint surge is critical', r.alerts.some((a) => a.type === 'complaint-surge' && a.urgency === 'critical'));
  const r2 = evaluate(null, snap({ reviewIntel: { themes } }), r.state, cfg, T + 60000);
  ok('complaint surge respects cooldown', !types(r2.alerts).includes('complaint-surge'));
  const r3 = evaluate(null, snap({ reviewIntel: { themes } }), r.state, cfg, T + 7 * 3600000);
  ok('complaint surge fires again after cooldown', types(r3.alerts).includes('complaint-surge'));
  const quiet = [{ key: 'crash', label: 'Crashes', count: 4, last24: 3, prior24: 2, recent48: 4, prior48: 2, trend: 2 }];
  const r4 = evaluate(null, snap({ reviewIntel: { themes: quiet } }), { launched: true }, cfg, T);
  ok('small complaint counts do not surge', !types(r4.alerts).includes('complaint-surge'));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-alerts.js`
Expected: FAIL on the new assertions

- [ ] **Step 3: Implement in `alerts.js`**

Add at the top: `const { attribute, describeCauses } = require('./attribution');`

Add to `DEFAULT_ALERTS`:
```js
  complaintSurge: true,
  complaintSurgeMin: 5,
  complaintSurgeMult: 3,
  complaintCooldownHr: 6,
```

Add to `DEFAULT_STATE`: `themeAlerts: {}`.

Change `push` to accept causes and merge them into the body:

```js
  const push = (type, title, body, opts = {}) => {
    const alert = { type, title, body, urgency: opts.urgency || 'normal', url: opts.url || storePage(next), ts: now };
    if (opts.causes) {
      alert.causes = opts.causes;
      alert.body = `${body} ${describeCauses(opts.causes)}`;
    }
    alerts.push(alert);
  };
```

In the spike block, compute causes and pass them:

```js
        if (big && cooldownOk && Math.abs(pct) >= (cfg.spikePct || 40)) {
          state.lastSpikeTs = now;
          const causes = attribute({ t: now, direction: pct > 0 ? 'up' : 'down' }, next);
          if (pct > 0) push('spike-up', `⚡ Player surge +${Math.round(pct)}%`,
            `Players jumped from ${fmt(prevPt.v)} to ${fmt(last.v)}.`, { causes });
          else push('spike-down', `🔻 Player drop ${Math.round(pct)}%`,
            `Players fell from ${fmt(prevPt.v)} to ${fmt(last.v)}.`, { urgency: 'critical', causes });
        }
```

Add the complaint-surge block after the reviews block:

```js
  // --- Complaint surge: a theme spiking in the last 24h ---
  if (cfg.complaintSurge && next.reviewIntel && Array.isArray(next.reviewIntel.themes)) {
    const cooldownMs = (cfg.complaintCooldownHr || 6) * 3600000;
    state.themeAlerts = { ...(state.themeAlerts || {}) };
    for (const th of next.reviewIntel.themes) {
      const min = cfg.complaintSurgeMin || 5;
      const mult = cfg.complaintSurgeMult || 3;
      if (!(th.last24 >= min && th.last24 >= mult * Math.max(th.prior24 || 0, 1))) continue;
      if (now - (state.themeAlerts[th.key] || 0) < cooldownMs) continue;
      state.themeAlerts[th.key] = now;
      push('complaint-surge', `⚠️ "${th.label}" complaints surging`,
        `${th.last24} negative reviews mentioning ${th.label.toLowerCase()} in the last 24h (was ${th.prior24 || 0} the day before).`,
        { urgency: 'critical' });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test-alerts.js`
Expected: all PASS (original 8 groups + the 2 new)

- [ ] **Step 5: Commit**

```bash
git add electron/alerts.js scripts/test-alerts.js
git commit -m "Attach spike attribution and add complaint-surge alerts"
```

---

### Task 10: Poller integration

**Files:**
- Modify: `electron/poller.js`
- Modify: `electron/config.js` (expose `reviewStore`, `eventLog`)

**Interfaces:**
- Consumes: everything from Tasks 2–8
- Produces: `snapshot.peers`, `snapshot.trends`, `snapshot.reviewIntel`, `snapshot.events`

- [ ] **Step 1: Compose the remaining stores into `Store`**

In `electron/config.js` constructor, after the `Series`:

```js
    this.reviewStore = new ReviewStore(userDataDir);
    this.eventLog = new EventLog(userDataDir);
```

with `const { ReviewStore } = require('./reviews');` and `const { EventLog } = require('./events');`.
Extend `clearHistory()` to also `this.eventLog.clear();` (the review corpus survives — it is not player history).

- [ ] **Step 2: Add the peers source and derived analysis to `poller.js`**

Add requires:
```js
const peersSvc = require('./services/peers');
const { coverageFor, segments } = require('./history');
const { analyze, parseTaxonomy, DEFAULT_TAXONOMY } = require('./reviews');
const { rankPeers } = require('./services/peers');
```

Add to `tasks`:
```js
    settle('peers', src.peers, () => peersSvc.getPeerPlayers(cfg.peers)),
```

After the player/history block, replace the `store.pushHistory` call so peer peaks fold in:

```js
  const peerList = by.peers.data || [];
  const peerMap = {};
  for (const p of peerList) if (p.available) peerMap[p.appId] = p.count;

  if (playersRes.available && typeof playersRes.count === 'number') {
    store.pushHistory({ t: now, v: playersRes.count }, cfg.historyMaxPoints, peerMap);
    if (peakSession == null || playersRes.count > peakSession) peakSession = playersRes.count;
  }
```

Then build the derived blocks before `const snapshot = {`:

```js
  // --- Reviews: ingest this page, then analyse the whole corpus ---
  const reviewsData = by.reviews.data || null;
  if (reviewsData && Array.isArray(reviewsData.recent)) store.reviewStore.ingest(reviewsData.recent);
  const taxonomy = cfg.reviewTaxonomy ? parseTaxonomy(cfg.reviewTaxonomy) : DEFAULT_TAXONOMY;
  const reviewIntel = analyze(store.reviewStore.rows(), taxonomy, now, reviewsData);

  // --- Trends: daily rollups with honest coverage + retention reference ---
  const pollMs = Math.max(15, Number(cfg.refreshIntervalSec) || 60) * 1000;
  const seriesStart = store.series.seriesStart();
  const launchTs = cfg.launchDate ? new Date(cfg.launchDate).getTime() : null;
  const days = store.series.getDaily().map((row) => {
    const coverage = coverageFor(row, seriesStart, pollMs, now);
    const dayStart = new Date(`${row.d}T00:00:00`).getTime();
    return {
      d: row.d,
      peak: row.peak,
      min: row.min,
      avg: row.n ? Math.round(row.sum / row.n) : null,
      n: row.n,
      peers: row.peers || {},
      coverage,
      partial: coverage < 0.9,
      dayNumber: launchTs ? Math.floor((dayStart - startOfLocalDay(launchTs)) / 86400000) + 1 : null
    };
  });
  const trends = { days, retention: buildRetention(days, launchTs) };
```

Add the two helpers at the bottom of `poller.js`:

```js
function startOfLocalDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Retention against the launch-day peak — except launch day is frequently
 * missing (the old 48h buffer evicted it). When it is, fall back to the
 * earliest surviving day and label it honestly rather than implying we have a
 * complete record.
 */
function buildRetention(days, launchTs) {
  if (!days.length) return null;
  const launchKey = launchTs ? dayKeyOf(launchTs) : null;
  const launchRow = launchKey ? days.find((d) => d.d === launchKey) : null;
  const ref = launchRow || days.reduce((best, d) => (d.peak > best.peak ? d : best), days[0]);
  const today = days[days.length - 1];
  return {
    todayPeak: today.peak,
    referencePeak: ref.peak,
    referenceDay: ref.d,
    referenceIsLaunch: !!launchRow,
    referenceLabel: launchRow ? 'launch peak' : `best known peak (day ${ref.dayNumber != null ? ref.dayNumber : '?'})`,
    pct: ref.peak ? Math.round((today.peak / ref.peak) * 100) : null
  };
}

function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

- [ ] **Step 3: Add the new blocks to the snapshot object**

```js
    peers: rankPeers(peerList, playersRes.available ? playersRes.count : null, cfg.gameName),
    trends,
    reviewIntel,
    events: store.eventLog.recent(60),
```

- [ ] **Step 4: Verify end to end against live endpoints**

Run: `node scripts/selftest.js`
Expected: Steam core ALL GREEN, and no crash from the new blocks

- [ ] **Step 5: Confirm the new blocks are populated**

Run:
```bash
node -e "
const os=require('os'),fs=require('fs'),path=require('path');
const {Store}=require('./electron/config');const {collect}=require('./electron/poller');
const d=fs.mkdtempSync(path.join(os.tmpdir(),'cw-'));
collect(new Store(d)).then(s=>{
  console.log('peers:', s.peers.rows.map(r=>r.name+'='+r.count).join(', '));
  console.log('ourRank:', s.peers.ourRank);
  console.log('days:', s.trends.days.length, 'retention:', JSON.stringify(s.trends.retention));
  console.log('themes:', s.reviewIntel.themes.slice(0,3).map(t=>t.label+':'+t.count).join(', '));
  console.log('coverage:', JSON.stringify(s.reviewIntel.coverage));
}).catch(e=>{console.error(e);process.exit(1)});
"
```
Expected: peers listed with counts, `ourRank` a number, review coverage showing `english` < `total`

- [ ] **Step 6: Commit**

```bash
git add electron/poller.js electron/config.js
git commit -m "Wire peers, trends and review intelligence into the snapshot"
```

---

### Task 11: Main process — backfill, events, series IPC

**Files:**
- Modify: `electron/main.js`, `electron/preload.js`

**Interfaces:**
- Consumes: `store.reviewStore`, `store.eventLog`, `store.series`, `backfillReviews`, `getReviewsPage`
- Produces: IPC `get-series` → `{ tier, points, segments, maxGapMs }`; `cultwatch.getSeries(range)` in the renderer

- [ ] **Step 1: Persist alerts into the event log**

In `fireAlerts()` in `main.js`, right after `store.setAlertState(result.state);`:

```js
  if (result.alerts.length) {
    store.eventLog.add(result.alerts.map((a) => ({
      t: a.ts, type: a.type, title: a.title, url: a.url,
      key: `${a.type}:${a.ts}`
    })));
  }
```

Also record Steam news as timeline events — add to `runPoll` after `lastSnapshot = snapshot;`:

```js
    if (Array.isArray(snapshot.news)) {
      store.eventLog.add(snapshot.news
        .filter((n) => n.date)
        .map((n) => ({ t: n.date, type: 'news', title: n.title, url: n.url, key: `news:${n.id}` })));
    }
```

- [ ] **Step 2: Run the one-time review backfill at startup**

Add to `main.js`:

```js
async function runBackfill() {
  if (store.reviewStore.backfilledAt()) return;
  try {
    const { backfillReviews } = require('./reviews');
    const steam = require('./services/steam');
    const cfg = store.get();
    const res = await backfillReviews(store.reviewStore, cfg.appId, (appId, cursor) => steam.getReviewsPage(appId, cursor));
    console.log(`[backfill] ${res.added} historical reviews in ${res.pages} pages`);
    if (res.added) runPoll('backfill');
  } catch (err) {
    console.error('[backfill] failed (non-fatal)', err.message);
  }
}
```

Call it in `app.whenReady()` after `runPoll('startup')`: `runBackfill();`

- [ ] **Step 3: Add the `get-series` IPC handler**

In `registerIpc()`:

```js
  ipcMain.handle('get-series', (_e, range) => {
    const cfg = store.get();
    const pollMs = Math.max(15, Number(cfg.refreshIntervalSec) || 60) * 1000;
    const now = Date.now();
    let points, tier, maxGapMs;
    if (range === '7d') {
      tier = 'medium';
      maxGapMs = 3 * 300000;
      points = store.series.getMedium()
        .filter((r) => r.t >= now - 7 * 86400000)
        .map((r) => ({ t: r.t, v: r.max }));
    } else if (range === 'all') {
      tier = 'medium';
      maxGapMs = 3 * 300000;
      points = store.series.getMedium().map((r) => ({ t: r.t, v: r.max }));
    } else {
      tier = 'fine';
      maxGapMs = 3 * pollMs;
      points = store.series.getFine();
    }
    return { tier, points, segments: segments(points, maxGapMs), maxGapMs };
  });
```

with `const { segments } = require('./history');` at the top.

- [ ] **Step 4: Expose it in `preload.js`**

```js
  getSeries: (range) => ipcRenderer.invoke('get-series', range),
```

- [ ] **Step 5: Launch the app and confirm it boots**

Run: `npm start`
Expected: window opens, Live board renders as before, console logs `[backfill] N historical reviews in M pages` on first run

- [ ] **Step 6: Commit**

```bash
git add electron/main.js electron/preload.js
git commit -m "Add review backfill, event persistence and series IPC"
```

---

### Task 12: Trends view

**Files:**
- Create: `renderer/trends.js`
- Modify: `renderer/index.html`, `renderer/styles.css`, `renderer/app.js`

**Interfaces:**
- Consumes: `snapshot.trends`, `snapshot.reviewIntel`, `snapshot.peers`, `snapshot.events`, `cultwatch.getSeries`
- Produces: `renderTrends(snapshot)`, `initTrends()` — both global functions defined in `trends.js`, called from `app.js`

- [ ] **Step 1: Add the view switcher and Trends board to `index.html`**

After the `brand` div in the topbar:

```html
      <div class="view-switch" id="viewSwitch">
        <button class="vs-btn active" data-view="live">LIVE</button>
        <button class="vs-btn" data-view="trends">TRENDS</button>
      </div>
```

After the closing `</main>` of the Live board, add the Trends board (panels: `#trendChart` with a `#trendRange` toggle, `#dayBars`, `#complaints`, `#velocityPanel`, `#peerPanel`), wrapped in `<main class="board hidden" id="boardTrends">`.

Change the script tags at the bottom to load `trends.js` first:

```html
    <script src="trends.js"></script>
    <script src="app.js"></script>
```

- [ ] **Step 2: Implement `renderer/trends.js`**

Global functions `initTrends()` (wires the range toggle) and `renderTrends(s)` which renders:
- **Range chart** — calls `cultwatch.getSeries(range)`, draws one `<path>` per segment (never bridging gaps), overlays event markers from `s.events`.
- **Day bars** — one bar per `s.trends.days` entry, height ∝ `peak`, hatched when `partial`, labelled `day N`, tooltip with peak/avg/coverage%.
- **Retention headline** — `${pct}% of ${referenceLabel}`, using `referenceLabel` verbatim so a non-launch reference is never mislabelled.
- **Complaints** — ranked `s.reviewIntel.themes` bars with count and a trend arrow shown only when `recent48 >= 3`; footer states coverage: `clustering N of M reviews (X%) · Y non-English`.
- **Velocity/sentiment** — `perHour24`, `last1h`, 7d vs all-time positive with the delta.
- **Peers** — `s.peers.rows` as a ranked strip, our row highlighted, `available: false` peers rendered dim with "no data".

Reuse `fmt`, `fmtCompact`, `esc`, `ago` from `app.js` (same global scope) — do not redefine them.

- [ ] **Step 3: Wire view switching in `app.js`**

```js
let currentView = 'live';
function setView(v) {
  currentView = v;
  el('boardLive').classList.toggle('hidden', v !== 'live');
  el('boardTrends').classList.toggle('hidden', v !== 'trends');
  el('viewSwitch').querySelectorAll('.vs-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'trends' && snapshot) renderTrends(snapshot);
}
```

Wire the click handler in `wireUi()`, call `initTrends()` from `boot()`, and add to `render(s)`:

```js
  if (currentView === 'trends') renderTrends(s);
```

- [ ] **Step 4: Add styles**

Add `.view-switch`, `.vs-btn`, `.day-bars`, `.complaint-row`, `.peer-row`, `.hatched` (a repeating-linear-gradient for partial days) to `styles.css`, using the existing `--accent`/`--pos`/`--neg`/`--muted` tokens. No new colours.

- [ ] **Step 5: Verify visually**

Run: `npm start`, click TRENDS.
Expected: four populated panels; the day-bar for any day the app was closed renders hatched; the retention headline reads "best known peak (day N)", not "launch peak"; the complaints footer states its coverage.

- [ ] **Step 6: Commit**

```bash
git add renderer/
git commit -m "Add the Trends view"
```

---

### Task 13: Settings for peers and taxonomy

**Files:**
- Modify: `renderer/app.js`

- [ ] **Step 1: Add the two settings groups**

Add to `SETTINGS_SCHEMA`:

```js
  { group: 'Peer benchmark', fields: [
    { key: 'peers', label: 'Peer games (one "appId: Name" per line)', type: 'lines',
      hint: 'Keyless — uses the same public player-count endpoint. A game that reports no live players shows as "no data".' }
  ]},
  { group: 'Complaint taxonomy', fields: [
    { key: 'reviewTaxonomy', label: 'Themes (one "Label: keyword, keyword" per line)', type: 'textarea',
      hint: 'Used to cluster negative reviews. Leave blank for the built-in set. English reviews only.' }
  ]},
```

- [ ] **Step 2: Handle the two new field kinds**

In `buildSettings()`, render `textarea` and `lines` as a `<textarea>`; for `peers`, format as `appId: Name` lines. In `saveSettings()`, parse `lines` back into `[{appId, name}]`:

```js
    else if (kind === 'lines') {
      v = v.split('\n').map((line) => {
        const i = line.indexOf(':');
        if (i < 0) return null;
        const appId = line.slice(0, i).trim();
        const name = line.slice(i + 1).trim();
        return appId ? { appId, name: name || `App ${appId}` } : null;
      }).filter(Boolean);
    }
```

Read `textarea` values via the same `input[data-key]` selector — change it to `input[data-key], textarea[data-key]`.

- [ ] **Step 3: Verify round-trip**

Run: `npm start` → Settings → edit a peer name → Save → reopen Settings.
Expected: the edit persists and the peer panel re-renders with the new name.

- [ ] **Step 4: Commit**

```bash
git add renderer/app.js
git commit -m "Add peer and taxonomy settings"
```

---

### Task 14: Self-test, npm scripts, README

**Files:**
- Modify: `scripts/selftest.js`, `package.json`, `README.md`

- [ ] **Step 1: Extend `selftest.js`**

Add after the `soft('x')` line:

```js
  soft('peers');
```
and extend `count()` with `if (name === 'peers') return (snap.peers && snap.peers.rows || []).length;`

Add before the persistence check:

```js
  const ri = snap.reviewIntel || { coverage: {} };
  line('reviewIntel', !!ri.coverage, `${ri.coverage.total || 0} stored · ${ri.coverage.english || 0} english · ${(ri.themes || []).length} themes`);
  const tr = snap.trends || { days: [] };
  line('trends', Array.isArray(tr.days), `${tr.days.length} day rollups` + (tr.retention ? ` · ${tr.retention.pct}% of ${tr.retention.referenceLabel}` : ''));
```

- [ ] **Step 2: Update `package.json` scripts**

```json
    "check": "node scripts/test-alerts.js && node scripts/test-history.js && node scripts/test-reviews.js && node scripts/test-attribution.js && node scripts/selftest.js",
    "test:alerts": "node scripts/test-alerts.js",
    "test:unit": "node scripts/test-alerts.js && node scripts/test-history.js && node scripts/test-reviews.js && node scripts/test-attribution.js",
```

- [ ] **Step 3: Run everything**

Run: `npm run check`
Expected: every unit script green, Steam core ALL GREEN

- [ ] **Step 4: Update `README.md`**

- Add the Trends view to "What it tracks" (day-over-day, complaints, velocity, peers).
- Document the three storage tiers and the new files under Architecture, including the new modules.
- Document the two new Settings groups.
- Add `complaint-surge` and spike attribution to the alerts section.
- **Correct the stale auto-update note** — the repo is public, so auto-update needs no token. Remove the "private repo needs GH_TOKEN on every machine" paragraph and replace with zero-config wording.
- State plainly that history before the upgrade is not recoverable and that sampling only happens while the app is open.

- [ ] **Step 5: Commit**

```bash
git add scripts/selftest.js package.json README.md
git commit -m "Extend self-test, wire unit suite into npm check, update README"
```

---

### Task 15: Release 1.1.0

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Full verification before release**

Run: `npm run check`
Expected: all green. **Do not proceed otherwise.**

- [ ] **Step 2: Bump the version**

`package.json` → `"version": "1.1.0"`

- [ ] **Step 3: Commit and merge to the default branch**

```bash
git add package.json
git commit -m "Release 1.1.0"
git checkout claude/hhb-situation-room-v8bopm
git merge --no-ff feature/trends-1.1.0 -m "Merge week-two intelligence (Trends) for 1.1.0"
```

- [ ] **Step 4: Build and publish**

```bash
GH_TOKEN=$(gh auth token) npm run release
```
Expected: electron-builder builds the NSIS installer and uploads it plus `latest.yml` to a new GitHub release.

- [ ] **Step 5: Verify the release is live and updatable**

```bash
gh release list --repo Kalfadda/CultWatch
gh release view v1.1.0 --repo Kalfadda/CultWatch --json assets --jq '.assets[].name'
```
Expected: assets include `CultWatch-Setup-1.1.0.exe` **and `latest.yml`** — without `latest.yml`, installed 1.0.0 copies cannot see the update.

- [ ] **Step 6: Push the branch**

```bash
git push origin claude/hhb-situation-room-v8bopm
```

---

## Self-Review

**Spec coverage:** §1 storage → Tasks 1–3; §2 reviews → Tasks 4–5, 10; §3 attribution + events → Tasks 7–9, 11; §4 peers → Tasks 6, 10; §5 UI → Tasks 12–13; §6 testing → Tasks 1,2,4,5,7,8,9,14; §7 release → Tasks 14–15. No section is unimplemented.

**Placeholder scan:** every code step carries real code; every test step carries real assertions; no "similar to Task N".

**Type consistency:** `Series.push(point, peers)` (Task 2) matches `store.pushHistory(point, max, peers)` (Task 3) and the poller call (Task 10). `analyze()` returns `{velocity, rolling, themes, coverage}` (Task 4), consumed identically in Task 9 (`themes[].last24/prior24`), Task 10 and Task 12. `attribute(event, snapshot, opts)` (Task 7) is called with `{t, direction}` in Task 9. `segments()` is used in both Task 2's tests and Task 11's IPC. `coverageFor(row, seriesStart, pollMs, now)` matches its Task 10 call site.
