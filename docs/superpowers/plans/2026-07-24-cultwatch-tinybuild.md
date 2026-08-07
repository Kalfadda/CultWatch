# TINYBUILD Publisher Cohort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third view, TINYBUILD, ranking Happy's Humble Burger Cult against the tinyBuild titles released in the last 365 days on two axes — live concurrents and review reception.

**Architecture:** Follows the existing `peers` seam exactly. A new service `electron/services/tinybuild.js` splits into a network half that never rejects and a pure ranking half that is fully unit-testable. The poller fetches and derives; the renderer receives finished numbers and computes no analysis. No new dependencies, no new persisted files.

**Tech Stack:** Node 20 / Electron 32, zero runtime dependencies beyond `electron-updater`. Plain CommonJS in `electron/`, plain browser globals in `renderer/` (no bundler, no framework). Tests are hand-rolled `node scripts/test-*.js` files with a local `ok(name, cond)` helper.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-cultwatch-tinybuild-design.md` is authoritative. Where this plan and the spec disagree, the spec wins.
- **No new dependencies.** Not for tests, not for the renderer.
- **Services never reject.** A failing title degrades that row only; it must never redden the panel or shrink the cohort.
- **Unranked rows are returned, not dropped** — always last, `rank: null`, rendered dim. This one rule governs both axes.
- **"Us" is derived**, never flagged in config: a row is ours when `String(row.appId) === String(cfg.appId)`.
- **Renderer computes no analysis.** Every number arrives finished from the main process.
- **Style:** `'use strict';` at the top of every file. Comments explain *why*, not *what*, matching the density of the surrounding code.
- **Target version:** 1.2.0, published to GitHub.
- **Verified cohort App IDs** (use exactly these): `3453910` Happy's Humble Burger Cult, `1431300` SAND: Raiders of Sophie, `2706020` ALL WILL FALL, `3326230` Hozy, `1645630` FEROCIOUS, `2357000` KILL IT WITH FIRE! 2, `2893820` Of Ash and Steel.

---

## File Structure

| File | Responsibility |
|---|---|
| `electron/services/tinybuild.js` | **new** — cohort fetch (network, never rejects) + ranking/read-line (pure) |
| `electron/services/steam.js` | **modify** — extract `summarize()`, add `getReviewSummary()` |
| `electron/config.js` | **modify** — `tinybuild` defaults + `sources.tinybuild` |
| `electron/poller.js` | **modify** — one `settle()` task + one derived snapshot block |
| `renderer/tinybuild.js` | **new** — the view; mirrors `trends.js` |
| `renderer/index.html` | **modify** — view button, board, script tag |
| `renderer/app.js` | **modify** — view switching, Settings group |
| `renderer/styles.css` | **modify** — two-panel split, outside-window flag |
| `scripts/test-tinybuild.js` | **new** — pure logic tests |
| `scripts/selftest.js` | **modify** — live cohort line |

---

### Task 1: Config defaults

**Files:**
- Modify: `electron/config.js` (DEFAULTS, after the `peers` block)
- Test: `scripts/test-config.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULTS.tinybuild = { label: string, windowDays: number, cohort: Array<{appId: string, name: string}> }` and `DEFAULTS.sources.tinybuild = true`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-config.js`, immediately before the `fs.rmSync(tmp, …)` line:

```js
// ============================================================
// 4. tinyBuild cohort
// ============================================================
{
  const c = new Store(freshDir(null)).get();
  const ids = c.tinybuild.cohort.map((g) => g.appId);
  ok('cohort has the seven verified titles', ids.length === 7);
  ok('our own game is in the cohort', ids.includes('3453910'));
  ok('SAND is in the cohort', ids.includes('1431300'));
  ok('cohort App IDs are unique', new Set(ids).size === ids.length);
  ok('every cohort entry has a name', c.tinybuild.cohort.every((g) => g.name && g.appId));
  ok('window defaults to 365 days', c.tinybuild.windowDays === 365);
  ok('publisher label defaults to tinyBuild', c.tinybuild.label === 'tinyBuild');
  ok('the source defaults to on', c.sources.tinybuild === true);

  // A config saved before 1.2.0 has no `tinybuild` key at all, so the defaults
  // must flow in through the normal deep merge — no migration, unlike `peers`.
  const old = new Store(freshDir({ refreshIntervalSec: 30 })).get();
  ok('a pre-1.2.0 config inherits the cohort', old.tinybuild.cohort.length === 7);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-config.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'cohort')`

- [ ] **Step 3: Write minimal implementation**

In `electron/config.js`, insert directly after the `peers: [ … ],` block:

```js
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
```

And add `tinybuild: true` as the last entry of the `sources` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-config.js`
Expected: PASS — 29 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add electron/config.js scripts/test-config.js
git commit -m "Add tinyBuild cohort config defaults"
```

---

### Task 2: `steam.getReviewSummary`

**Files:**
- Modify: `electron/services/steam.js`
- Test: `scripts/test-tinybuild.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `summarize(json) → { score, scoreDesc, total, positive, negative, positivePct }` — pure, exported for tests. `positivePct` is `null` when `total` is 0.
  - `getReviewSummary(appId) → Promise<same shape>` — one request.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-tinybuild.js`:

```js
'use strict';

/**
 * Unit tests for the tinyBuild publisher cohort — review-summary parsing and
 * the pure ranking layer (no network, no Electron).
 *   node scripts/test-tinybuild.js
 */

const { summarize } = require('../electron/services/steam');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

// ============================================================
// 1. Review summary parsing
// ============================================================
{
  const s = summarize({ query_summary: {
    review_score: 8, review_score_desc: 'Very Positive',
    total_reviews: 345, total_positive: 290, total_negative: 55
  } });
  ok('total is read', s.total === 345);
  ok('positive pct rounds', s.positivePct === 84);
  ok('score description is read', s.scoreDesc === 'Very Positive');

  const empty = summarize({ query_summary: { total_reviews: 0 } });
  ok('zero reviews yields a null pct, not a divide-by-zero', empty.positivePct === null);
  ok('zero reviews still describes itself', empty.scoreDesc === 'No user reviews');

  ok('a missing query_summary does not throw', summarize({}).total === 0);
  ok('null input does not throw', summarize(null).total === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-tinybuild.js`
Expected: FAIL — `TypeError: summarize is not a function`

- [ ] **Step 3: Write minimal implementation**

In `electron/services/steam.js`, add `summarize` above `getReviews`:

```js
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
```

Then rewrite the body of `getReviews` to reuse it, replacing the manual `q`/`total`/`positive`/`negative`/`positivePct` derivation:

```js
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
```

Update the exports line:

```js
module.exports = { getAppDetails, getCurrentPlayers, getReviews, getReviewSummary, getReviewsPage, getNews, stripBB, summarize };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test-tinybuild.js && node scripts/test-reviews.js`
Expected: both PASS. `test-reviews.js` must stay green — `getReviews` keeps the same output shape, which is what proves the refactor was behaviour-preserving.

- [ ] **Step 5: Commit**

```bash
git add electron/services/steam.js scripts/test-tinybuild.js
git commit -m "Extract review summary parsing, add getReviewSummary"
```

---

### Task 3: `rankCohort` — the pure ranking layer

**Files:**
- Create: `electron/services/tinybuild.js`
- Test: `scripts/test-tinybuild.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `rankCohort(rows, ourAppId, now, windowDays) → { momentum, reception, shareOfCcu, cohortSize, flagged, readLine }` where each of `momentum`/`reception` is `{ rows, ourRank, ourOf, leader }`. Each output row is the input row plus `{ us, outsideWindow, rank, value }`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-tinybuild.js`, before the final `console.log`. Also add `const { rankCohort } = require('../electron/services/tinybuild');` to the requires at the top.

```js
// ============================================================
// 2. Ranking
// ============================================================
const DAY = 86400000;
const NOW = Date.parse('2026-07-24T00:00:00Z');

function row(appId, count, pct, total, releasedAt) {
  return {
    appId, name: 'App ' + appId,
    count, ccuAvailable: count != null,
    reviews: pct == null ? null : { total: total || 100, positivePct: pct, scoreDesc: 'x' },
    releasedAt: releasedAt === undefined ? NOW - 30 * DAY : releasedAt,
    error: null
  };
}

{
  const r = rankCohort([
    row('1', 100, 50),
    row('us', 500, 80),
    row('3', 900, 60)
  ], 'us', NOW, 365);

  ok('momentum ranks by descending players', r.momentum.rows.map((x) => x.appId).join() === '3,us,1');
  ok('our momentum rank is right', r.momentum.ourRank === 2);
  ok('momentum counts every ranked row', r.momentum.ourOf === 3);
  ok('reception ranks by descending pct', r.reception.rows.map((x) => x.appId).join() === 'us,3,1');
  ok('our reception rank is right', r.reception.ourRank === 1);
  ok('the momentum leader is exposed', r.momentum.leader.appId === '3');
  ok('us is flagged on exactly one row', r.momentum.rows.filter((x) => x.us).length === 1);
  ok('share of cohort CCU is our slice of the total', r.shareOfCcu === Math.round((500 / 1500) * 100));
  ok('cohort size counts every row', r.cohortSize === 3);
}

// Unranked rows sort last, keep rank null, and are still returned.
{
  const r = rankCohort([
    row('dead', null, null),
    row('us', 10, 70),
    row('live', 20, 90)
  ], 'us', NOW, 365);

  ok('a row with no CCU sorts last on momentum', r.momentum.rows[2].appId === 'dead');
  ok('a row with no CCU is unranked', r.momentum.rows[2].rank === null);
  ok('an unranked row is still returned', r.momentum.rows.length === 3);
  ok('unranked rows are excluded from the denominator', r.momentum.ourOf === 2);
  ok('a row with no reviews sorts last on reception', r.reception.rows[2].appId === 'dead');
  ok('ranks are 1-based and contiguous', r.momentum.rows[0].rank === 1 && r.momentum.rows[1].rank === 2);
}

// Reception ties break toward the title with more reviews.
{
  const r = rankCohort([
    row('few', null, 90, 10),
    row('many', null, 90, 5000)
  ], 'us', NOW, 365);
  ok('a tied pct breaks by review volume', r.reception.rows[0].appId === 'many');
}

// Window flagging, at the boundary.
{
  const r = rankCohort([
    row('inside', 5, 50, 100, NOW - 364 * DAY),
    row('edge', 5, 50, 100, NOW - 365 * DAY),
    row('outside', 5, 50, 100, NOW - 366 * DAY),
    row('undated', 5, 50, 100, null)
  ], 'us', NOW, 365);
  const by = Object.fromEntries(r.momentum.rows.map((x) => [x.appId, x.outsideWindow]));
  ok('a title inside the window is not flagged', by.inside === false);
  ok('a title exactly at the window edge is not flagged', by.edge === false);
  ok('a title past the window is flagged', by.outside === true);
  ok('a title with no known date is not flagged', by.undated === false);
  ok('flagged count is reported', r.flagged === 1);
}

// Degenerate cohorts.
{
  const empty = rankCohort([], 'us', NOW, 365);
  ok('an empty cohort does not throw', empty.cohortSize === 0);
  ok('an empty cohort has no rank', empty.momentum.ourRank === null);
  ok('an empty cohort has a null share', empty.shareOfCcu === null);
  ok('an empty cohort has no read line', empty.readLine === null);

  const junk = rankCohort([null, { name: 'no id' }, row('ok', 1, 50)], 'us', NOW, 365);
  ok('malformed entries are dropped', junk.cohortSize === 1);

  const zero = rankCohort([row('a', 0, 50), row('us', 0, 50)], 'us', NOW, 365);
  ok('an all-zero cohort yields a null share, not NaN', zero.shareOfCcu === null);

  const absent = rankCohort([row('a', 5, 50)], 'us', NOW, 365);
  ok('our rank is null when we are not in the cohort', absent.momentum.ourRank === null);
  ok('share is null when we are not in the cohort', absent.shareOfCcu === null);

  const allDead = rankCohort([row('a', null, null), row('b', null, null)], 'us', NOW, 365);
  ok('an all-unavailable cohort ranks nobody', allDead.momentum.ourOf === 0);
  ok('an all-unavailable cohort has no leader', allDead.momentum.leader === null);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-tinybuild.js`
Expected: FAIL — `Cannot find module '../electron/services/tinybuild'`

- [ ] **Step 3: Write minimal implementation**

Create `electron/services/tinybuild.js`:

```js
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

module.exports = { rankCohort, readLine };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-tinybuild.js`
Expected: PASS — all ranking assertions green.

- [ ] **Step 5: Commit**

```bash
git add electron/services/tinybuild.js scripts/test-tinybuild.js
git commit -m "Add pure cohort ranking with two independent axes"
```

---

### Task 4: Read-line generation tests

**Files:**
- Modify: `scripts/test-tinybuild.js`

**Interfaces:**
- Consumes: `readLine(momentum, reception)` from Task 3.
- Produces: nothing new — hardens existing behaviour.

- [ ] **Step 1: Write the failing test**

The spec requires four read-line behaviours that Task 3's tests do not pin down. Add to `scripts/test-tinybuild.js` before the final `console.log`:

```js
// ============================================================
// 3. Read line
// ============================================================
{
  const both = rankCohort([row('a', 900, 40, 9000), row('us', 500, 80), row('b', 100, 60)], 'us', NOW, 365);
  ok('the read line names both ranks', /#2 of 3 by players and #1 of 3 by sentiment/.test(both.readLine) ||
    /#1 by sentiment, #2 of 3 by players/.test(both.readLine));

  // Leader is last of three on reception -> in the bottom third -> called out.
  ok('a badly-reviewed leader is called out', /biggest game is also among its worst reviewed/.test(both.readLine));
  ok('the call-out names the leader and its pct', /App a, 40%/.test(both.readLine));
}
{
  // Leader is also the best reviewed -> nothing to call out.
  const clean = rankCohort([row('a', 900, 95), row('us', 500, 80), row('b', 100, 60)], 'us', NOW, 365);
  ok('a well-reviewed leader is not called out', !/worst reviewed/.test(clean.readLine));
}
{
  const usLeads = rankCohort([row('us', 900, 95), row('a', 100, 60)], 'us', NOW, 365);
  ok('leading both axes is stated plainly', usLeads.readLine === 'Top of the cohort on both players and sentiment.');
  ok('we are never called out as our own bad leader', !/worst reviewed/.test(usLeads.readLine));
}
{
  const noReviews = rankCohort([row('a', 900, null), row('us', 500, null)], 'us', NOW, 365);
  ok('one axis degrades to a single clause', noReviews.readLine === '#2 of 2 by players; no sentiment data.');

  const noCcu = rankCohort([row('a', null, 90), row('us', null, 70)], 'us', NOW, 365);
  ok('the other axis degrades too', noCcu.readLine === '#2 of 2 by sentiment; no player data.');

  const neither = rankCohort([row('a', null, null), row('us', null, null)], 'us', NOW, 365);
  ok('no data at all yields no read line', neither.readLine === null);
}
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node scripts/test-tinybuild.js`
Expected: these assertions PASS against Task 3's implementation. If any fail, the implementation — not the test — is wrong; fix `readLine`/`leaderNote` in `electron/services/tinybuild.js` until green. This task exists to prove the spec's stated degradation rules actually hold.

- [ ] **Step 3: Wire the suite into `npm run test:unit`**

In `package.json`, append to the `test:unit` script:

```
 && node scripts/test-tinybuild.js
```

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test:unit`
Expected: every suite PASS, including the pre-existing 27 + 29 config assertions.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-tinybuild.js package.json
git commit -m "Pin down read-line degradation rules"
```

---

### Task 5: `getCohort` — the network half

**Files:**
- Modify: `electron/services/tinybuild.js`

**Interfaces:**
- Consumes: `steam.getCurrentPlayers`, `steam.getReviewSummary`, `steam.getAppDetails`.
- Produces: `getCohort(cohort, opts) → Promise<Row[]>`, never rejects. `Row = { appId, name, count, ccuAvailable, reviews, releasedAt, error }`. Also exports `_resetMetaCache()` for tests.

- [ ] **Step 1: Write the implementation**

There is no unit test for this step — it is pure I/O orchestration whose only logic is "never reject", and the live `selftest.js` in Task 7 exercises it against the real API. Add to `electron/services/tinybuild.js`, above `module.exports`:

```js
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
```

Update the exports:

```js
module.exports = { getCohort, rankCohort, readLine, _resetMetaCache };
```

- [ ] **Step 2: Verify it loads and behaves on the empty path**

Run:

```bash
node -e "const t=require('./electron/services/tinybuild'); t.getCohort([]).then(r=>console.log('empty:',JSON.stringify(r))); t.getCohort(null).then(r=>console.log('null:',JSON.stringify(r)));"
```

Expected: `empty: []` and `null: []` — no throw.

- [ ] **Step 3: Verify it never rejects on a bad App ID**

Run:

```bash
node -e "require('./electron/services/tinybuild').getCohort([{appId:'0',name:'nope'}]).then(r=>console.log(JSON.stringify(r[0],null,1))).catch(e=>{console.log('REJECTED — BUG:',e.message);process.exit(1)})"
```

Expected: a row object printed with `ccuAvailable: false`. It must NOT print `REJECTED`.

- [ ] **Step 4: Verify a real title end to end**

Run:

```bash
node -e "const t=require('./electron/services/tinybuild');t.getCohort([{appId:'3453910',name:'Cult'}]).then(r=>console.log(JSON.stringify(r[0])))"
```

Expected: real `count`, a `reviews` object, and a `releasedAt` that parses to Jul 16 2026.

- [ ] **Step 5: Commit**

```bash
git add electron/services/tinybuild.js
git commit -m "Add cohort fetch with a per-run metadata cache"
```

---

### Task 6: Poller wiring

**Files:**
- Modify: `electron/poller.js`

**Interfaces:**
- Consumes: `getCohort`, `rankCohort`.
- Produces: `snapshot.tinybuild` (the `rankCohort` return value, or `null` when the source is off) and `snapshot.status.tinybuild`.

- [ ] **Step 1: Add the require**

At the top of `electron/poller.js`, after the `peersSvc` line:

```js
const tinybuildSvc = require('./services/tinybuild');
```

- [ ] **Step 2: Add the fetch task**

In the `tasks` array, after the `peers` entry:

```js
    settle('tinybuild', src.tinybuild, () => tinybuildSvc.getCohort(cfg.tinybuild && cfg.tinybuild.cohort))
```

- [ ] **Step 3: Derive the ranked block**

In the `snapshot` object literal, directly after the `peers:` line:

```js
    tinybuild: by.tinybuild.data
      ? tinybuildSvc.rankCohort(by.tinybuild.data, appId, now, cfg.tinybuild && cfg.tinybuild.windowDays)
      : null,
```

Also add the publisher label to the `config` block of the snapshot so the renderer can title the view without reaching for config itself — after the `sources: src` line, insert:

```js
      tinybuildLabel: (cfg.tinybuild && cfg.tinybuild.label) || 'Publisher',
      tinybuildWindowDays: (cfg.tinybuild && cfg.tinybuild.windowDays) || 365,
```

- [ ] **Step 4: Verify the snapshot shape**

Run:

```bash
node -e "
const os=require('os'),fs=require('fs'),path=require('path');
const {Store}=require('./electron/config');
const {collect}=require('./electron/poller');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-poll-'));
collect(new Store(dir)).then(s=>{
  const t=s.tinybuild;
  console.log('status:',JSON.stringify(s.status.tinybuild));
  console.log('cohort:',t.cohortSize,'flagged:',t.flagged,'share:',t.shareOfCcu);
  console.log('momentum #'+t.momentum.ourRank+' of '+t.momentum.ourOf);
  console.log('reception #'+t.reception.ourRank+' of '+t.reception.ourOf);
  console.log('read:',t.readLine);
});
"
```

Expected: `status: {"status":"ok",…}`, cohort 7, and both ranks populated. At spec time this printed momentum #2 of 7 and reception #2 of 7.

- [ ] **Step 5: Commit**

```bash
git add electron/poller.js
git commit -m "Wire the tinyBuild cohort into the poll"
```

---

### Task 7: The view

**Files:**
- Create: `renderer/tinybuild.js`
- Modify: `renderer/index.html`, `renderer/app.js`, `renderer/styles.css`
- Modify: `scripts/selftest.js`

**Interfaces:**
- Consumes: `snapshot.tinybuild`, and `fmt`/`esc`/`el` globals from `app.js`.
- Produces: global `renderTinybuild(s)`.

- [ ] **Step 1: Create the view module**

Create `renderer/tinybuild.js`:

```js
'use strict';

/* global fmt, esc, el */

/**
 * Publisher cohort view — us against the titles our publisher shipped this year.
 *
 * Two rankings side by side because they disagree, and the disagreement is the
 * story. Like the other views, this one renders finished numbers and computes no
 * analysis of its own.
 */

function renderTinybuild(s) {
  const t = s.tinybuild || null;
  const cfg = s.config || {};
  const label = cfg.tinybuildLabel || 'Publisher';
  const days = cfg.tinybuildWindowDays || 365;

  const head = el('tbHead');
  if (head) {
    head.textContent = t
      ? `${label} · last ${days} days · ${t.cohortSize} title${t.cohortSize === 1 ? '' : 's'}` +
        (t.flagged ? ` · ${t.flagged} outside window` : '')
      : `${label} · cohort unavailable`;
  }

  const chip = el('tbChip');
  if (chip) {
    chip.textContent = t && t.momentum.ourRank
      ? `#${t.momentum.ourRank} of ${t.momentum.ourOf} momentum`
      : '—';
  }

  renderTbKpis(t);
  renderTbPanel('tbMomentum', t && t.momentum, momentumCell);
  renderTbPanel('tbReception', t && t.reception, receptionCell);

  const read = el('tbRead');
  if (read) {
    read.textContent = (t && t.readLine) || '';
    read.classList.toggle('hidden', !(t && t.readLine));
  }
}

function renderTbKpis(t) {
  const box = el('tbKpis');
  if (!box) return;
  const cards = [
    {
      k: 'var(--info)',
      label: 'Momentum',
      value: t && t.momentum.ourRank ? `#${t.momentum.ourRank}` : '—',
      dim: !(t && t.momentum.ourRank),
      sub: t && t.momentum.ourRank ? `of ${t.momentum.ourOf} by live players` : 'no player data'
    },
    {
      k: 'var(--pos)',
      label: 'Reception',
      value: t && t.reception.ourRank ? `#${t.reception.ourRank}` : '—',
      dim: !(t && t.reception.ourRank),
      sub: t && t.reception.ourRank ? `of ${t.reception.ourOf} by positive %` : 'no review data'
    },
    {
      k: 'var(--accent)',
      label: 'Share of cohort',
      value: t && t.shareOfCcu != null ? `${t.shareOfCcu}%` : '—',
      dim: !(t && t.shareOfCcu != null),
      sub: 'of all live players'
    }
  ];
  box.innerHTML = cards.map((c) => `
    <div class="kpi ${c.dim ? 'dim' : ''}" style="--k:${c.k}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>`).join('');
}

function renderTbPanel(id, axis, cell) {
  const box = el(id);
  if (!box) return;
  if (!axis || !axis.rows.length) {
    box.innerHTML = `<div class="feed-empty">No cohort data.<br>Add titles in ⚙ Settings.</div>`;
    return;
  }
  const max = Math.max(...axis.rows.map((r) => r.value || 0), 1);
  box.innerHTML = `<div class="peer-list">` + axis.rows.map((r) => cell(r, max)).join('') + `</div>`;
}

/** Shared row chrome: rank, name, out-of-window flag. */
function rowHead(r) {
  const rank = r.rank == null ? '·' : r.rank;
  const flag = r.outsideWindow ? `<span class="tb-flag" title="Released outside the tracked window">⚠</span>` : '';
  return `<span class="tb-rank">${rank}</span><span class="pr-name">${esc(r.name)}${flag}</span>`;
}

function momentumCell(r, max) {
  if (r.rank == null) {
    return `<div class="peer-row dim">${rowHead(r)}<div class="pr-bar"></div>
      <span class="pr-val">${r.error ? 'error' : 'no data'}</span></div>`;
  }
  const w = Math.max(1, Math.round((r.value / max) * 100));
  return `<div class="peer-row ${r.us ? 'us' : ''}">${rowHead(r)}
    <div class="pr-bar"><div style="width:${w}%"></div></div>
    <span class="pr-val">${fmt(r.value)}</span></div>`;
}

function receptionCell(r, max) {
  if (r.rank == null) {
    return `<div class="peer-row dim">${rowHead(r)}<div class="pr-bar"></div>
      <span class="pr-val">no reviews</span></div>`;
  }
  const w = Math.max(1, Math.round((r.value / max) * 100));
  const total = r.reviews ? fmt(r.reviews.total) : '—';
  return `<div class="peer-row ${r.us ? 'us' : ''}">${rowHead(r)}
    <div class="pr-bar"><div style="width:${w}%"></div></div>
    <span class="pr-val">${r.value}%</span>
    <span class="tb-vol">${total}</span></div>`;
}
```

- [ ] **Step 2: Add the board and button to `index.html`**

In the `view-switch` div, after the trends button:

```html
        <button class="vs-btn" data-view="tinybuild" title="Us vs the publisher's recent releases">TINYBUILD</button>
```

After the closing `</main>` of `boardTrends`, add:

```html
    <!-- ===== Publisher cohort dashboard ===== -->
    <main class="board hidden" id="boardTinybuild">
      <section class="kpis" id="tbKpis"></section>

      <section class="panel">
        <div class="panel-head">
          <h2 id="tbHead">Publisher cohort</h2>
          <div class="panel-tools"><span class="chip" id="tbChip">—</span></div>
        </div>
        <div class="tb-read hidden" id="tbRead"></div>
      </section>

      <section class="grid-2 feeds">
        <div class="panel">
          <div class="panel-head"><h2>Momentum <span class="count">live players</span></h2></div>
          <div id="tbMomentum"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Reception <span class="count">positive %</span></h2></div>
          <div id="tbReception"></div>
        </div>
      </section>
    </main>
```

And add the script tag before `trends.js`:

```html
    <script src="tinybuild.js"></script>
```

- [ ] **Step 3: Wire view switching in `app.js`**

Update the globals comment on line 3 to include `renderTinybuild`:

```js
/* global cultwatch, initTrends, renderTrends, resizeTrendChart, renderTinybuild */
```

In `setView`, after the `boardTrends` line:

```js
  el('boardTinybuild').classList.toggle('hidden', v !== 'tinybuild');
```

and after the trends render line:

```js
  if (v === 'tinybuild' && snapshot) renderTinybuild(snapshot);
```

In the render path (currently line 100), after `if (currentView === 'trends') renderTrends(s);`:

```js
  if (currentView === 'tinybuild') renderTinybuild(s);
```

- [ ] **Step 4: Add the Settings group in `app.js`**

After the `Peer benchmark` group in the settings field definitions:

```js
  { group: 'Publisher cohort', fields: [
    { key: 'tinybuild.cohort', label: 'Cohort games — one "appId: Name" per line', type: 'lines',
      hint: 'Titles from your publisher released recently. Hand-maintained: anything released longer ago than the window below is flagged ⚠ rather than dropped, so a stale list is visible instead of silently skewing the ranking.' },
    { key: 'tinybuild.label', label: 'Publisher name', type: 'text' },
    { key: 'tinybuild.windowDays', label: 'Window (days)', type: 'number' }
  ]},
```

Verify how the existing `lines` type reads and writes `peers` and mirror it for a nested key path; if the settings code only supports flat keys, add dotted-path get/set rather than flattening the config — the nested shape is what the spec and poller expect.

- [ ] **Step 5: Add styles**

Append to `renderer/styles.css`, after the `/* Peers */` block:

```css
/* Publisher cohort */
.tb-read { padding: 10px 14px; font-size: 13px; color: var(--text-2); border-left: 3px solid var(--accent); background: var(--bg-2); border-radius: 0 6px 6px 0; }
.tb-rank { font-family: var(--mono); font-size: 11px; color: var(--muted-2); width: 16px; flex: 0 0 auto; text-align: right; }
.tb-flag { color: var(--neg); margin-left: 5px; cursor: help; }
.tb-vol { font-family: var(--mono); font-size: 11px; color: var(--muted-2); width: 52px; text-align: right; flex: 0 0 auto; }
.peer-row.us .tb-rank { color: var(--accent); font-weight: 700; }
```

- [ ] **Step 6: Add the live self-test line**

In `scripts/selftest.js`, follow the existing `peers` / `peer ranking` pattern and add:

```js
  const tb = await tinybuildSvc.getCohort(cfg.tinybuild.cohort);
  const ranked = tinybuildSvc.rankCohort(tb, cfg.appId, Date.now(), cfg.tinybuild.windowDays);
  line('tinybuild', ranked.cohortSize
    ? `${ranked.cohortSize} titles · momentum #${ranked.momentum.ourRank} of ${ranked.momentum.ourOf}` +
      ` · reception #${ranked.reception.ourRank} of ${ranked.reception.ourOf}` +
      (ranked.flagged ? ` · ${ranked.flagged} outside window` : '')
    : 'empty cohort');
```

Match the file's existing `line()`/`pass()`/`warn()` helper names exactly — read the surrounding code first rather than assuming.

- [ ] **Step 7: Run the app and verify the view**

Run: `npm run check` then `npm start`

Expected: `npm run check` is fully green including the new `tinybuild` self-test line. In the app, clicking TINYBUILD shows three KPI tiles, two ranked panels with Cult highlighted in amber in both, and a read line beneath the header. Confirm no console errors, and that switching LIVE → TRENDS → TINYBUILD → LIVE leaves each board rendering correctly.

- [ ] **Step 8: Commit**

```bash
git add renderer/ scripts/selftest.js
git commit -m "Add the TINYBUILD publisher cohort view"
```

---

### Task 8: Release 1.2.0

**Files:**
- Modify: `package.json`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a published GitHub release.

- [ ] **Step 1: Update the README**

Add `tinybuild.js` to both the `electron/services/` and `renderer/` file maps in the architecture section, described as the publisher cohort. Add a short feature bullet describing the TINYBUILD view alongside the existing LIVE and TRENDS descriptions.

- [ ] **Step 2: Bump the version**

In `package.json`, set `"version": "1.2.0"`.

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: every unit suite passes and the live self-test is green. Do not proceed on a red result.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "Publisher cohort view (1.2.0)"
```

- [ ] **Step 5: Publish**

```bash
GH_TOKEN=$(gh auth token) npm run release
```

Then verify it is live and not a draft:

```bash
gh release view v1.2.0 --repo kalfadda/cultwatch --json assets,isDraft --jq '{draft:.isDraft, assets:[.assets[].name]}'
```

Expected: `draft: false` and three assets — the `.exe`, its `.blockmap`, and `latest.yml`. Without `latest.yml`, `electron-updater` cannot see the release and existing installs will never update.

- [ ] **Step 6: Push**

```bash
git push
```

---

## Self-Review

**Spec coverage:** §1 cohort → Task 1. §2 config → Task 1. §3 `getReviewSummary` → Task 2; `rankCohort`/ordering → Task 3; `getCohort`/metadata cache/failure contract → Task 5. §4 staleness flagging → Task 3 (`outsideWindow`, `flagged`) and Task 7 (`⚠` render). §5 poller → Task 6. §6 renderer/read line → Tasks 3, 4, 7. §7 error handling → Tasks 3, 5, 7. §8 testing → Tasks 2, 3, 4, 7. §9 release → Task 8.

**Placeholder scan:** clean — every code step carries real code. Task 7 steps 4 and 6 direct the implementer to read neighbouring code before writing, which is a genuine dependency on existing local convention rather than an unspecified requirement.

**Type consistency:** `rankCohort(rows, ourAppId, now, windowDays)` is called with that arity in Task 6 and the Task 7 self-test. Row fields (`ccuAvailable`, `releasedAt`, `reviews.positivePct`, `reviews.total`) are produced in Task 5 and consumed in Task 3 under the same names. `momentum`/`reception` expose `rows`/`ourRank`/`ourOf`/`leader` in Task 3 and are read under exactly those names in Tasks 6 and 7.
