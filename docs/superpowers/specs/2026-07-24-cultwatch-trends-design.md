# CultWatch — Week-Two Intelligence (Trends)

**Date:** 2026-07-24
**Status:** Approved for implementation
**Target version:** 1.1.0

## Problem

CultWatch was built as a launch-*day* situation room. The game shipped 2026-07-16;
it is now day 8. Three gaps make the app progressively less useful the further
launch recedes:

1. **The app forgets.** `historyMaxPoints: 2880` (~48h at 1/min) is a hard rolling
   cap. Measured on the live machine at spec time: the buffer is **full (2880/2880)
   and actively evicting**, its oldest sample is `2026-07-21T03:30Z` — **day 4.4**.
   Days 1 through 4.4, including the true launch peak, are **permanently gone**.
   The buffer also spans 90 wall-clock hours rather than 48 because it contains a
   **30.3-hour hole** where the app was closed, and the chart draws a straight line
   across it — a visually confident lie.
2. **Reviews are counted, not understood.** The poller keeps a rolling summary plus
   the last 15 reviews. There is no corpus, no velocity, and no way to answer "what
   are people actually complaining about."
3. **Numbers have no denominator.** "1,987 concurrent" is unreadable without a peer
   set, and a spike alert names no cause, so every alert creates investigation work.

## Goals

- Stop the data loss permanently; preserve everything from today forward.
- Give reviews a memory and a shape (themes, velocity, rolling sentiment).
- Make spike alerts self-explaining.
- Put every number next to a comparable number.

## Non-goals

- **Recovering days 1–4.4.** Steam exposes no historical CCU. Gone is gone; the UI
  must say so rather than imply a complete record.
- **Sampling while the app is closed.** A background service or autostart is a
  separate project. Coverage will be partial on some days; the UI reports it.
- Team distribution (Discord/Slack relay) — explicitly deferred.
- Steamworks partner data (units/revenue/refunds) — rejected during design as
  session-cookie scraping, too fragile to bake in.

---

## 1. Storage — tiered series

New module `electron/history.js` exporting a `Series` class. Three tiers, each in
its own file under `<userData>`, each written atomically.

| tier | resolution | retention | file |
|---|---|---|---|
| fine | raw sample (~1/min) | 48h / 2,880 pts | `cultwatch-history.json` *(existing, format unchanged)* |
| medium | 5-minute buckets | 30 days (~8,600 rows) | `cultwatch-series-medium.json` |
| daily | one row per local calendar day | forever (cap 3,650) | `cultwatch-series-daily.json` |

### Row shapes

```js
fine:   { t, v }                                  // unchanged — back-compatible
medium: { t, max, min, sum, n }                   // t = 5-min bucket start (epoch ms)
daily:  { d, peak, min, sum, n, first, last,      // d = 'YYYY-MM-DD' local
          peers: { [appId]: peakCcu } }
```

Derived tier files are versioned envelopes: `{ v: 2, rows: [...] }`. `avg` is
derived from `sum`/`n` at read time and never stored.

Daily keys use the **machine's local timezone at fold time**. A machine that
changes timezone mid-run will attribute subsequent samples to the new local day;
this is accepted (the alternative, UTC keys, would put "day 1" boundaries in the
middle of the team's working day).

### Folding

`Series.push({t, v}, peers)` performs three writes in one call:

1. Append to `fine`; trim to `historyMaxPoints`.
2. Fold into the medium bucket `floor(t / 300000) * 300000` — update `max`, `min`,
   `sum`, `n`, or insert a new row. Monotonic timestamps are the fast path; a
   sample older than the last row (clock skew) is located by binary search and
   folded in place. Trim rows older than 30 days.
3. Fold into the daily row keyed by the **local** `YYYY-MM-DD` of `t`, updating
   `peak`, `min`, `sum`, `n`, `first`, `last`, and per-peer `peak`.

### Migration

Migration triggers when **either** derived file is missing, unparseable, or not
`v: 2`. On first construction under 1.1.0, both derived tiers are discarded and
every existing `fine` point is replayed through the medium and daily folds, then
both files are written. Rebuilding both (rather than only the missing one) keeps
the two tiers derived from the same source and avoids a half-migrated state. This
**permanently preserves days 4.4 → 8.2**, which would otherwise evict within two
days. Migration is idempotent: once both files exist at `v: 2`, it never re-runs.
`clearHistory()` clears all three tiers and writes empty `v: 2` envelopes, so
clearing does not resurrect a migration.

### Gap awareness

`segments(points, maxGapMs)` splits a point array wherever consecutive samples are
more than `maxGapMs` apart (default `3 × pollIntervalMs`). The renderer draws one
SVG path per segment, so holes render as holes.

Daily `coverage` is computed at read time (the analysis layer knows the poll
interval), not stored:

```
seriesStart = first  of the earliest daily row   // first sample ever recorded
observed    = min(dayEnd, now) - max(dayStart, seriesStart)
coverage    = clamp(n / (observed / pollIntervalMs), 0, 1)
```

`observed <= 0` (a day entirely before the series began) yields `coverage = 0`
rather than a division by zero.

Any day below 90% coverage is flagged `partial: true` and rendered with a hatched
bar and a coverage % in its tooltip.

### Atomic writes

All persistence (including the existing config, history and alert-state writes)
moves to write-temp-then-`renameSync`. The current bare `writeFileSync` corrupts a
file if the process dies mid-write — unacceptable for a feature whose entire point
is not losing data.

### Retention math

```js
retention = {
  todayPeak, referencePeak, referenceDay, referenceLabel,
  referenceIsLaunch,  // false when the launch-day row is missing
  pct                 // todayPeak / referencePeak
}
```

When the launch-day row is absent — which it is, and will remain — the reference
falls back to the **earliest surviving day's peak** and `referenceLabel` reads
"best known peak (day 5)", never "launch peak". The UI must not imply a complete
record.

---

## 2. Review intelligence

New module `electron/reviews.js` owning `cultwatch-reviews.json`:

```js
{ v: 1, backfilledAt: <ts|null>, rows: [ { id, t, up, txt, hrs, lang, votes } ] }
```

`txt` is truncated to 400 chars (clustering needs keywords, not essays); `rows` is
capped at 2,500 newest (~1MB worst case).

### Backfill

Verified working at spec time: `store.steampowered.com/appreviews/<id>` with
`num_per_page=100&cursor=…` returned **342 reviews in 4 requests**, back to
`2026-07-16T13:44Z` (launch day), terminating cleanly on an empty page. Backfill
runs **once**, guarded by `backfilledAt`, capped at 25 pages, and is non-fatal on
error — a failure leaves the app ingesting incrementally exactly as before.

### Classification

A taxonomy of `{ key, label, patterns[] }` — crash, performance, controller, price,
length, saves, motion sickness, bugs, audio, difficulty — editable in Settings as
`label: kw1, kw2, kw3` lines.

`classify(text, lang)` only matches **English** reviews. Measured corpus: **222 of
342 reviews are English (65%)**. Non-English rows are counted separately and never
silently dropped. The panel reports its own coverage:

```js
coverage = { total, english, nonEnglish, themed, untagged }
```

"Untagged" = English but matched no theme. Both denominators are shown, so a
complaint count is never mistaken for the whole picture.

### Derived stats

- **Velocity** — reviews/hr over 24h, count in the last 1h, trend vs prior 24h.
- **Rolling sentiment** — positive rate over the last 7 days vs all-time. These
  diverge, and the 7-day figure is what Steam surfaces to buyers.
- **Theme stats** — per theme over negative reviews, computed over **two windows**
  so the UI and the alert engine never disagree:

  ```js
  { key, label, count, last24, prior24, recent48, prior48, trend }
  ```

  The **UI trend arrow** uses the 48h pair (steadier, less jumpy on a panel someone
  stares at) and renders only when `recent48 >= 3`, so three reviews can't
  manufacture a "4× surge". The **alert** uses the 24h pair (tighter, so a genuine
  post-patch regression is caught the same day).

### New alert: `complaint-surge`

Fires when a theme's `last24` is `>= max(5, 3 × prior24)`. Per-theme 6h cooldown
tracked in alert state (`themeAlerts: { [key]: lastTs }`). Urgency `critical`.

---

## 3. Spike attribution

New module `electron/attribution.js` — a pure function, no IO:

```js
attribute(event, snapshot, { windowMs = 1200000 }) -> [ { kind, label, detail, url, score, ts } ]
```

Every feed item already carries a timestamp (`twitch.startedAt`, `reddit.created`,
`bluesky.created`, `x.created`, `news.date`, `youtube.published`, `web.date`), so
candidates are filtered to a ±20min window around the event and scored:

| kind | score |
|---|---|
| twitch | `viewers` |
| news | 1000 (an official post is a strong prior) |
| reddit | `score + comments × 2` |
| bluesky / x | `likes + reposts × 2` |
| youtube / web | recency-weighted |

Top 3 by score are attached as `alert.causes` and folded into the alert body:
*"⚡ +62% — likely: Northernlion went live 8 min ago (12.4K viewers)."*

For **drops**, a stream *ending* is invisible to the API, so an empty candidate set
must render as "no clear cause found" rather than reaching for a weak correlation.

### Event log

`electron/events.js` owning `cultwatch-events.json` (`{ v: 1, rows: [...] }`, cap
500). `alerts.js` **stays pure**: `main.js` persists the alerts it returns into the
event log after evaluation, plus deduped Steam news items. Events render as markers
on the Trends chart, so the curve annotates itself.

---

## 4. Peer benchmark

New service `electron/services/peers.js`. Keyless — the same
`GetNumberOfCurrentPlayers` endpoint the app already uses, one parallel request per
peer. Verified live at spec time:

| App ID | Game | CCU | role |
|---|---|---|---|
| 1433340 | Happy's Humble Burger Farm | 89 | predecessor, apples-to-apples |
| 1295920 | The Mortuary Assistant | 76 | job-sim horror, same scale |
| 2916430 | Fast Food Simulator | 304 | thematic twin |
| 4121170 | Fears to Fathom: Scratch Creek | 556 | current genre benchmark |
| 2881650 | Content Warning | 2,453 | the ceiling |
| 3453910 | **Happy's Humble Burger Cult** | **1,987** | us |

**Night of the Consumers is deliberately excluded** — it returns `result: 42` (no
CCU data). The service treats `result: 42` as `available: false`, *not* an error,
and an individual peer failure never fails the batch.

Config gains `peers: [{ appId, name }]`, editable in Settings. Peer peaks fold into
the daily rollup (a few bytes/day), so "we passed Content Warning on day 9" stays
answerable later.

---

## 5. UI — the Trends view

A `[LIVE] [TRENDS]` switcher in the top bar. **The Live board is untouched.**

`renderer/app.js` is already 856 lines; the Trends view goes in a new
`renderer/trends.js` loaded *before* `app.js` (plain scripts, no module system —
`app.js` calls `boot()` at end of file, so definitions must exist first).

Trends panels:

1. **Day-over-day** — peak-per-day bars, launch-relative day labels, partial days
   hatched, retention headline ("38% of best known peak").
2. **Top complaints** — ranked themes with counts, trend arrows, coverage footer.
3. **Review velocity & sentiment** — reviews/hr, 7-day vs all-time positive rate.
4. **Peer benchmark** — ranked strip with our position highlighted.

The Trends chart has a **24h / 7d / all** range toggle backed by a new IPC call
`get-series(range)` returning `{ tier, points, segments }`. The medium tier is
**never** included in the 60s snapshot — shipping 8,600 points over IPC every
minute is exactly the kind of thing that makes an app feel broken.

### Snapshot additions

```js
snapshot.trends     = { days: [...], retention: {...} }
snapshot.reviewIntel = { velocity, rolling, themes, coverage }
snapshot.peers      = { list: [...], ourRank, ourCount }
snapshot.events     = [ ...last 60 ]
```

### Settings additions

- **Peer benchmark** — one `appId: Name` per line.
- **Complaint taxonomy** — one `label: kw1, kw2` per line.
- **Retention** — read-only summary of what is stored and since when.

---

## 6. Testing

Three new zero-dep scripts in the existing hand-rolled `ok()` style, plus additions
to the current two:

- `scripts/test-history.js` — bucket folding, rollup math, 30-day trim, **migration
  from a synthetic legacy fine array**, gap segmentation, coverage, atomic-write
  round-trip, clear-then-no-remigrate.
- `scripts/test-reviews.js` — English vs non-English classification, coverage
  counts, theme stats and trend gating, velocity math, ingest dedupe, row cap.
- `scripts/test-attribution.js` — window filtering, score ordering, empty →
  "no clear cause", drop-direction handling.
- `scripts/test-alerts.js` — extended: `complaint-surge` firing and cooldown,
  attribution attached to spike alerts.
- `scripts/selftest.js` — extended: live peer fetch line, review-backfill line.

`npm run check` runs all unit scripts, then the live smoke test.

## 7. Release

1. `npm run check` green.
2. README updated — new panels, new settings, new files, architecture tree. The
   "private repo needs a token" note is **stale** (the repo is public) and gets
   corrected to zero-config auto-update.
3. Version → **1.1.0**.
4. `electron-builder --publish always` with `GH_TOKEN` from `gh auth token`.
5. Installed 1.0.0 copies pick it up on next launch or within 6h.

## Risks

| risk | mitigation |
|---|---|
| Days 1–4.4 unrecoverable | Stated in UI via `referenceIsLaunch: false`; never labelled "launch peak" |
| 35% of reviews unclassifiable (non-English) | Coverage reported explicitly on the panel |
| App closed → coverage holes | Gap-aware chart + per-day coverage %; not hidden |
| Steam endpoint drift | Existing `settle()` tolerance; every new source degrades to a dim panel |
| Snapshot bloat over IPC | Medium tier served on demand, never pushed |
