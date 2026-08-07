# Durable player history

**Status:** approved 2026-08-06
**Problem:** the permanent player-count record is destroyed on load after an unclean shutdown.

## What was actually happening

The series was never failing to *save* — it saves on every poll. It was being destroyed on
*load*, and the destruction was silent.

Observed in the real store on 2026-08-06 (`%APPDATA%/CultWatch`):

| file | write cadence | state |
|---|---|---|
| `cultwatch-history.json` (fine) | every poll | only the current session |
| `cultwatch-series-daily.json` (forever tier) | every poll | **1 row — today** |
| `cultwatch-alertstate.json` | every poll | reset (`peakAlerted` 2432, though 2,500 was crossed on Jul 25) |
| `cultwatch-events.json` | only when a new event lands | intact since Jun 11 — 106 live alerts |
| `cultwatch-reviews.json` | only when new reviews land | intact, backfilled Jul 24 |

Everything written on every poll had been reset; everything written rarely had survived. The
Windows System log supplies the trigger:

```
2026-08-06 12:23  previous system shutdown was unexpected   (Event 6008)
2026-08-06 12:42  rebooted without cleanly shutting down    (Event 41)
```

The chain:

1. `writeJson` writes a temp file and renames it into place. Rename is atomic for *metadata*,
   but nothing ever called `fsync`, so the file's **data** may still sit in the OS write cache.
   An unclean shutdown lets NTFS replay the rename while the data is lost — the file comes back
   truncated, empty or NUL-filled. Files rewritten every 60s are almost always in that window;
   files written once a day are long since flushed. That is exactly the split observed.
2. `readJson(file, fallback)` catches the resulting `JSON.parse` throw and returns the fallback.
   It **cannot distinguish "missing" (first run) from "unreadable" (corrupt)**.
3. `Series` therefore loaded an empty fine tier, treated the derived tiers as invalid, rebuilt
   both from nothing, and `_persistDerived()` overwrote the permanent daily file with the empty
   rebuild on the very next line.

One crash destroys the entire record, with no error and no trace. Loading the real data through
`Store` round-trips correctly, which confirms the load path is only destructive when a read fails.

## Design

Five changes. The first two are the fix; the rest are the belt-and-braces the record deserves.

### 1. Durable writes — `electron/atomic.js`

`writeJson` opens the temp file, writes, **`fsyncSync`s the descriptor**, closes, then renames.
The corrupt-file state stops arising at all. Cost is roughly a millisecond per poll.

The containing directory is deliberately not fsynced: it is unsupported on Windows, which is the
platform this bug was observed on, and the loss here was file *contents*, not a lost rename.

### 2. "Unreadable" is not "empty" — `electron/atomic.js` + `electron/history.js`

New `readJsonState(file)` returns `{ status: 'ok' | 'missing' | 'unreadable', data }`. `readJson`
stays as a thin wrapper for the callers that genuinely do not care.

`Series` then follows one rule: **a tier is only ever rebuilt-and-overwritten when its file is
missing or of an older version — never when it failed to read.** Consequences:

- Each derived tier is rebuilt from `fine` **independently**. Previously a single unreadable
  medium file took the daily record down with it. They cover different spans by design, so
  rebuilding one has never required discarding the other.
- An unreadable file is renamed to `<name>.corrupt-<ts>` rather than overwritten, so the bytes
  survive for inspection even when they cannot be parsed.
- Damage is recorded and surfaced (see 5), never swallowed.

### 3. Backup of the permanent record — `electron/history.js`

`cultwatch-series-daily.bak.json` holds a second copy of the daily tier, written on the first
push of a session, on each day rollover, and every 4 hours thereafter — comfortably the "at
least 4 times a day" the feature was asked for, and, being written rarely, a copy that is
essentially always flushed to disk when a crash hits.

The daily tier is restored from it whenever the primary yields no usable rows, whether the file
was unreadable *or* missing. The backup is never written with fewer rows than it already holds,
so a session that starts from an empty record cannot erase a fuller safety copy. `clear()` resets
it too — an explicit clear is meant to clear.

### 4. Single-instance lock — `electron/main.js`

There is none today, so a second copy will happily fight the first over the same files. Six
lines; a second launch focuses the existing window instead.

### 5. Honest gaps on the live chart — `renderer/app.js`

Once history spans days, `renderChart`'s single continuous path draws a straight line from
yesterday evening to this afternoon, asserting player counts that were never sampled. It breaks
the path wherever the gap exceeds a threshold supplied by the main process (`players.gapMs`), the
same way Trends already does via `segments()`. The renderer still computes no analysis: it
receives the threshold and only decides where the ink stops. X labels gain a date once the span
exceeds a day.

Storage damage from (2) renders as a line under the chart, so a quarantined file is visible
rather than inferred from a suspiciously short record.

## Mobile

`mobile/platform/atomic.js` must export the same surface or the Android build breaks silently —
`scripts/build-mobile.js` swaps that module in underneath the shared `history.js`. localStorage
is atomic per key and synchronous, so there is no fsync equivalent; `readJsonState` maps a null
`getItem` to `missing` and a parse failure to `unreadable`, and `quarantine` renames the key.

## Testing

`scripts/test-history.js`:

- `readJsonState` distinguishes missing / ok / unreadable; an empty file and a NUL-filled file
  both read as unreadable, not as valid emptiness.
- **Regression:** a corrupt fine file leaves the daily and medium tiers intact.
- A corrupt daily file with a backup present restores from it and quarantines the original.
- A corrupt daily file with no backup quarantines rather than overwrites, and reports damage.
- The backup is written on first push, on day rollover and after 4h — and not more often.
- A session loading an empty daily tier cannot shrink an existing backup.
- `clear()` resets primary, derived tiers and backup.

`scripts/test-mobile.js`: the mobile atomic is exercised against a localStorage stub and must
match the desktop `readJsonState` semantics, plus export every name the desktop module does.

## Not doing

Reconstructing the lost days. Steam serves no historical CCU, and the peak events in the event
log would only produce a partial record wearing the costume of a real one.

## Ships as

1.5.0 — desktop installer and signed APK, per the standing rule.
