# CultWatch — Publisher Cohort (TINYBUILD)

**Date:** 2026-07-24
**Status:** Approved for implementation
**Target version:** 1.2.0

## Problem

CultWatch answers "how is Happy's Humble Burger Cult doing" against a hand-picked
peer set of tonally similar horror/job-sim titles. That set is useful for reading
the genre, but it is the wrong denominator for a different question the studio
actually asks: **how is our game doing against the other games our publisher
shipped this year?**

tinyBuild publishes Cult. It also published six other titles in the last 365 days.
Those seven games shared a publisher, a marketing apparatus and a storefront
position, which makes them the fairest available comparison set — and none of that
comparison is visible today.

## Goals

- Rank Cult against the tinyBuild titles released in the last 365 days.
- Rank on two independent axes — **momentum** (live concurrents) and **reception**
  (review volume and positive %) — because they disagree, and the disagreement is
  the insight.
- Make the roster's staleness visible rather than silent.

## Non-goals

- **Day-N launch curves** ("us at day 7 vs them at day 7"). Steam exposes only
  *current* players, never history. A rival's launch-day CCU is unrecoverable, so
  this comparison cannot be built retroactively and is explicitly deferred.
- **Automatic roster discovery.** Steam's publisher search (`/search/results/
  ?publisher=…&json=1`) does work keylessly and was prototyped during design, but
  it is undocumented, requires ~100 `appdetails` calls to filter demos/DLC/OSTs out
  of the raw roster, and adds a scraping dependency for data that changes maybe
  monthly. Rejected in favour of a curated list. See §4 for the staleness mitigation
  this choice requires.
- **Scythe back catalogue.** The four older Scythe Dev Team titles (Deep Cuts,
  Return to Northbury Grove, HHB Barn, HHB Farm) all fall outside the 365-day
  window. The cohort is strictly the window; Cult is the only "us" row.
- Revenue, wishlists or units — Steamworks partner data is out of scope here for
  the same reason it was rejected in the Trends spec.

---

## 1. The cohort

Seven titles, each verified live at spec time (`type: "game"`, released, publisher
tinyBuild, reporting `result: 1` on the player-count endpoint):

| App ID | Title | Released | CCU | Reviews | Positive |
|---|---|---|---|---|---|
| 3453910 | Happy's Humble Burger Cult | Jul 16, 2026 | 2,588 | 345 | 84% |
| 1431300 | SAND: Raiders of Sophie | Jun 22, 2026 | 28,795 | 11,966 | 50% |
| 2706020 | ALL WILL FALL | Apr 3, 2026 | 141 | 1,280 | 77% |
| 3326230 | Hozy | Mar 30, 2026 | 187 | 4,394 | 81% |
| 1645630 | FEROCIOUS | Dec 4, 2025 | 4 | 842 | 63% |
| 2357000 | KILL IT WITH FIRE! 2 | Nov 25, 2025 | 32 | 1,661 | 94% |
| 2893820 | Of Ash and Steel | Nov 24, 2025 | 101 | 6,748 | 66% |

Measured 2026-07-24. The cohort was confirmed complete by paging 100
release-sorted roster entries — back past Nov 2025, well beyond the window edge.

Note the shape of the data: Cult is **#2 on both axes**, and the momentum leader
(SAND) is the cohort's worst-received title. The two rankings must therefore be
presented side by side; either one alone misleads.

## 2. Config

New nested key in `electron/config.js` `DEFAULTS`, plus a source toggle:

```js
tinybuild: {
  label: 'tinyBuild',        // publisher name, shown in the header
  windowDays: 365,           // defines "recent"; drives the outside-window flag
  cohort: [                  // curated, Settings-editable
    { appId: '3453910', name: "Happy's Humble Burger Cult" },
    { appId: '1431300', name: 'SAND: Raiders of Sophie' },
    { appId: '2706020', name: 'ALL WILL FALL' },
    { appId: '3326230', name: 'Hozy' },
    { appId: '1645630', name: 'FEROCIOUS' },
    { appId: '2357000', name: 'KILL IT WITH FIRE! 2' },
    { appId: '2893820', name: 'Of Ash and Steel' }
  ]
},
sources: { …, tinybuild: true }
```

`tinybuild` is a **new** key, so an existing saved config picks the defaults up
through the normal deep merge. No migration is required — unlike the `peers` swap
in 1.1.2, which needed one precisely because the key already existed.

"Us" is identified by matching a cohort entry's `appId` against `cfg.appId`, not by
a flag in the list. A user who repoints CultWatch at another game gets a correct
"us" row for free, and there is no second place to keep in sync.

## 3. Services

### `steam.js` — new export

```js
getReviewSummary(appId) → { score, scoreDesc, total, positive, negative, positivePct }
```

One request (`num_per_page=0`). The existing `getReviews` fetches a summary *and* a
page of recent reviews; the cohort needs only the summary, and issuing seven
throwaway review pages per poll would be waste. `getReviews` is refactored to call
`getReviewSummary` internally so the parsing lives in exactly one place.

### `electron/services/tinybuild.js` — new

Mirrors the `peers.js` contract exactly:

```js
getCohort(cohort, opts) → Promise<Row[]>   // network; NEVER rejects
rankCohort(rows, ourAppId, now, windowDays) → { momentum, reception, ourAppId, … }  // pure
```

`Row` shape:

```js
{
  appId, name,
  count, ccuAvailable,          // live concurrents
  reviews: { total, positivePct, scoreDesc } | null,
  releasedAt,                   // epoch ms | null
  outsideWindow,                // bool — releasedAt older than windowDays
  us,                           // appId === cfg.appId
  error                         // string | null
}
```

Per poll: **2 requests per title (CCU + review summary), 14 total**, all parallel.

**Metadata cache.** Names and release dates are immutable, so `appdetails` is
fetched once per title per app launch into a module-level `Map` and reused for the
rest of the run. That is 7 extra requests on the first poll only, and keeps
`appdetails` off the hot path. The cache is memory-only and deliberately not
persisted: a restart re-fetching seven rows is cheaper than owning another file and
its invalidation rules.

**Failure contract.** `getCohort` never rejects. A title whose CCU call fails comes
back `ccuAvailable: false`; a title whose review call fails comes back
`reviews: null`. Each degrades that row only — a dead title must not redden the
panel or drop the other six.

### `rankCohort` — ordering rules

Two independent rankings over the same rows:

- **momentum** — descending `count`. Rows with `ccuAvailable: false` are unranked.
- **reception** — descending `positivePct`. Rows with no review data are unranked.
  Ties on percentage break by higher `total` (more reviews = more confidence).

**Unranked rows are still returned, always last, carrying `rank: null`.** They are
displayed dim at the bottom of their panel rather than dropped — a title that fails
to answer must remain visible as a title we tried to measure, not vanish and
quietly shrink the cohort. Only ranked rows receive a number and count toward
`ourOf`. This single rule governs both axes and §7.

Both rankings carry `ourRank` (1-based, or `null` when our row is absent or
unranked) and `ourOf` (count of *ranked* rows on that axis). `shareOfCcu` is our
count over the summed cohort count, `null` when the sum is zero.

Outside-window rows are **ranked normally, not excluded**. Dropping them would make
a stale roster silently shrink the comparison; flagging them makes the staleness
visible. §4 is the whole point of this choice.

## 4. Roster staleness is surfaced, not hidden

A curated list is the explicit trade accepted during design: no scraping
dependency, in exchange for a roster that goes stale as tinyBuild ships new games
and existing entries age past 365 days. That downside is mitigated rather than
ignored:

- Every row displays its release date.
- Any row whose `releasedAt` is older than `windowDays` renders an
  **`⚠ outside window`** flag.
- The header reports the cohort size and how many entries are flagged.

The page therefore tells the operator when it needs maintenance. Without release
dates this failure would be invisible — which is why §3 fetches them despite the
cohort list already carrying names.

## 5. Poller

`collect()` gains one `settle('tinybuild', src.tinybuild, …)` task alongside the
existing eleven, and one derived snapshot block:

```js
tinybuild: tinybuildSvc.rankCohort(
  by.tinybuild.data || [], cfg.appId, now, cfg.tinybuild.windowDays
)
```

Consistent with every other panel, the renderer receives finished numbers and
computes no analysis itself. The source appears in the existing `status` map, so a
failure is reported through the same channel as every other source.

## 6. Renderer

New view `TINYBUILD` beside LIVE and TRENDS. New file `renderer/tinybuild.js`
mirroring `trends.js` (render entry point, `el()`/`esc()`/`fmt()` helpers, no
framework). `index.html` gains the view button and board; `app.js` gains the
Settings group and view-switch wiring.

```
TINYBUILD · tinyBuild · last 365 days · 7 titles     #2 of 7 momentum

  ┌ MOMENTUM #2 ┐ ┌ RECEPTION #2 ┐ ┌ SHARE OF COHORT ┐
  │    2,588    │ │   84% · 345  │ │       8%        │
  └─────────────┘ └──────────────┘ └─────────────────┘

  MOMENTUM · live concurrents
  1   SAND: Raiders of Sophie      28,795  ████████████████
  2 ▸ Happy's Humble Burger Cult    2,588  █▌              ← us
  3   Hozy                            187  ▏
  …

  RECEPTION · positive % · review volume
  1   KILL IT WITH FIRE! 2      94%   1,661 revs  ███████
  2 ▸ Happy's Humble Burger Cult 84%    345 revs  ██████   ← us
  …
  7   SAND: Raiders of Sophie   50%  11,966 revs  ███

  ▸ #2 by players and #2 by sentiment. The cohort's biggest
    game is also its worst reviewed (SAND, 50%).
```

Reuses the existing `.peer-row` / `.pr-bar` design-system classes so the view
inherits the situation-room look; new CSS is limited to the two-panel split and
the outside-window flag.

The closing **read line** is generated, not hand-written — from the two ranks and
the identity of the momentum leader. Rules: state our rank on each axis; if the
momentum leader is in the bottom third by reception, say so; if we lead either
axis, lead with that. It degrades to a single clause when only one axis has data,
and is omitted entirely when neither does.

Bars are scaled relative to the largest value in their own panel, `Math.max(1, …)`
so a tiny value still renders a visible sliver. With SAND at ~11× Cult the
momentum bars are heavily skewed; this is accepted as honest, matching the
established behaviour of the peers panel.

## 7. Error handling

| Condition | Behaviour |
|---|---|
| One title's CCU fails | Unranked on momentum — renders dim and last there; its reception rank is unaffected |
| One title's reviews fail | Unranked on reception — renders dim and last there; its momentum rank is unaffected |
| Whole source fails | Panel shows the error; `status.tinybuild` reports it |
| Source toggled off | View still reachable, shows "tinyBuild cohort is off" |
| Empty cohort | "Add tinyBuild titles in ⚙ Settings." |
| Our appId absent from cohort | Rankings render; rank tiles show "—" |
| Malformed entry (no appId) | Filtered before fetch, exactly as `peers.js` does |

## 8. Testing

New `scripts/test-tinybuild.js` (pure, no network), wired into `npm run test:unit`:

- momentum ordering, including unavailable rows sorting last
- reception ordering, including the ties-broken-by-volume rule
- `ourRank` / `ourOf` correctness, and `null` when our row is missing
- `shareOfCcu` math, and `null` on a zero-sum cohort
- outside-window flagging at the boundary (exactly `windowDays` old, and one day past)
- empty cohort, malformed entries, all-unavailable cohort
- read-line generation: both axes, one axis, neither

`scripts/selftest.js` gains a live `tinybuild` line reporting cohort size, our rank
on each axis, and any flagged entries.

## 9. Release

Ships as **1.2.0** — a new user-visible view. Version bump, commit, and
`npm run release` publishing directly to GitHub so existing installs auto-update.
