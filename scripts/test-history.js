'use strict';

/**
 * Unit tests for atomic persistence, the tiered player-count series and the
 * event log (no network, no Electron).
 *   node scripts/test-history.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJson, writeJson } = require('../electron/atomic');
const { Series, segments, dayKey, bucketStart, coverageFor } = require('../electron/history');
const { EventLog } = require('../electron/events');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hist-'));

// ============================================================
// 1. Atomic JSON persistence
// ============================================================
{
  const f = path.join(tmp, 'a.json');
  ok('readJson returns fallback when missing', readJson(f, { z: 1 }).z === 1);
  writeJson(f, { hello: 'world' });
  ok('writeJson round-trips', readJson(f, null).hello === 'world');
  fs.writeFileSync(f, '{ not json');
  ok('readJson returns fallback on corrupt file', readJson(f, { z: 2 }).z === 2);
  ok('writeJson leaves no .tmp behind', !fs.readdirSync(tmp).some((n) => n.endsWith('.tmp')));
  writeJson(path.join(tmp, 'nested', 'deep', 'b.json'), [1, 2, 3]);
  ok('writeJson creates missing directories', readJson(path.join(tmp, 'nested', 'deep', 'b.json'), []).length === 3);
}

// ============================================================
// 2. Tier folding
// ============================================================
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
  ok('daily min is the min', day[0].min === 50);
  ok('daily n counts every sample', day[0].n === 4);
  ok('daily key is a local YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(day[0].d));
}

// ============================================================
// 3. Out-of-order samples (clock skew) fold into the right bucket
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 's-skew-'));
  const s = new Series(dir, { maxFine: 100 });
  const t0 = new Date('2026-07-20T12:00:00Z').getTime();
  s.push({ t: t0, v: 10 });
  s.push({ t: t0 + 600000, v: 20 });          // +10min, third bucket
  s.push({ t: t0 + 60000, v: 99 });           // late arrival, first bucket
  const first = s.getMedium().find((r) => r.t === bucketStart(t0));
  ok('late sample folds into its own bucket, not the newest', first.max === 99);
  ok('late sample does not create a duplicate bucket',
    s.getMedium().filter((r) => r.t === bucketStart(t0)).length === 1);
  ok('medium rows stay sorted by time',
    s.getMedium().every((r, i, a) => i === 0 || a[i - 1].t < r.t));
}

// ============================================================
// 4. Fine tier trimming
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 's2-'));
  const s = new Series(dir, { maxFine: 3 });
  for (let i = 0; i < 6; i++) s.push({ t: 1000 + i * 60000, v: i });
  ok('fine trims to maxFine', s.getFine().length === 3);
  ok('fine keeps the newest', s.getFine()[2].v === 5);
  ok('daily still counts every sample pushed', s.getDaily()[0].n === 6);
  ok('daily peak survives fine eviction', s.getDaily()[0].peak === 5);
}

// ============================================================
// 5. Persistence, clear, and no re-migration after clear
// ============================================================
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

// ============================================================
// 6. Migration from the legacy flat history file
// ============================================================
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
  ok('migrated sample count is exact', s.getDaily().reduce((n, d) => n + d.n, 0) === 600);

  const again = new Series(dir, { maxFine: 2880 });
  ok('migration does not double-count on reopen', again.getDaily().reduce((n, d) => n + d.n, 0) === 600);

  // A half-migrated state (one derived file lost) rebuilds both, not one.
  fs.unlinkSync(path.join(dir, 'cultwatch-series-medium.json'));
  const rebuilt = new Series(dir, { maxFine: 2880 });
  ok('a missing derived tier rebuilds both from fine',
    rebuilt.getMedium().length === 120 && rebuilt.getDaily().reduce((n, d) => n + d.n, 0) === 600);
}

// ============================================================
// 7. Legacy file with junk entries survives migration
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 's5-'));
  fs.writeFileSync(path.join(dir, 'cultwatch-history.json'), JSON.stringify([
    { t: 1000, v: 5 }, null, { t: 2000 }, { v: 9 }, { t: 3000, v: 7 }
  ]));
  const s = new Series(dir, { maxFine: 100 });
  ok('migration skips malformed points', s.getDaily().reduce((n, d) => n + d.n, 0) === 2);
  ok('migration keeps the good peak', Math.max(...s.getDaily().map((d) => d.peak)) === 7);
}

// ============================================================
// 8. Peer peaks fold into the daily rollup
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 's6-'));
  const s = new Series(dir, { maxFine: 100 });
  const t0 = Date.now();
  s.push({ t: t0, v: 100 }, { 1433340: 80, 2881650: 2000 });
  s.push({ t: t0 + 60000, v: 120 }, { 1433340: 95, 2881650: 1900 });
  const row = s.getDaily()[0];
  ok('peer peak is the max across samples', row.peers['1433340'] === 95);
  ok('peer peak does not fall back', row.peers['2881650'] === 2000);
  s.push({ t: t0 + 120000, v: 130 }, { 1433340: null });
  ok('non-numeric peer counts are ignored', s.getDaily()[0].peers['1433340'] === 95);
}

// ============================================================
// 9. Gap segmentation
// ============================================================
{
  const pts = [{ t: 0, v: 1 }, { t: 60000, v: 2 }, { t: 60000 + 3600000, v: 3 }, { t: 60000 + 3660000, v: 4 }];
  const segs = segments(pts, 180000);
  ok('segments splits on a gap', segs.length === 2);
  ok('segments keeps points in order', segs[0].length === 2 && segs[1].length === 2);
  ok('no gap yields a single segment', segments(pts.slice(0, 2), 180000).length === 1);
  ok('empty input yields no segments', segments([], 180000).length === 0);
  ok('a single point yields one segment', segments([{ t: 0, v: 1 }], 180000).length === 1);
}

// ============================================================
// 10. Day coverage
// ============================================================
{
  const dayStart = new Date('2026-07-22T00:00:00').getTime();
  const DAYMS = 86400000;
  const row = { d: dayKey(dayStart), n: 720, first: dayStart, last: dayStart + DAYMS - 1 };
  const cov = coverageFor(row, dayStart - DAYMS, 60000, dayStart + DAYMS);
  ok('coverage of a half-sampled full day is ~0.5', Math.abs(cov - 0.5) < 0.02);
  ok('coverage caps at 1', coverageFor({ ...row, n: 5000 }, dayStart - DAYMS, 60000, dayStart + DAYMS) === 1);
  ok('coverage of a day before the series began is 0',
    coverageFor(row, dayStart + DAYMS, 60000, dayStart + DAYMS) === 0);
  ok('coverage with no poll interval is 0', coverageFor(row, dayStart - DAYMS, 0, dayStart + DAYMS) === 0);
  ok('a partially elapsed day is scored against elapsed time, not 24h',
    Math.abs(coverageFor({ ...row, n: 360 }, dayStart - DAYMS, 60000, dayStart + DAYMS / 2) - 0.5) < 0.02);
}

// ============================================================
// 11. Event log
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 'ev-'));
  const log = new EventLog(dir);
  ok('event add returns count', log.add([{ t: 1000, type: 'peak', title: 'New peak', key: 'p1' }]) === 1);
  ok('event add dedupes by key', log.add([{ t: 1000, type: 'peak', title: 'New peak', key: 'p1' }]) === 0);
  ok('events persist', new EventLog(dir).rows().length === 1);
  ok('events ignore rows with no timestamp', log.add([{ type: 'peak', title: 'x' }]) === 0);
  log.add([{ t: 500, type: 'launch', title: 'live', key: 'l1' }]);
  ok('events are stored in time order', log.rows()[0].t === 500);
  ok('recent() returns the newest slice', log.recent(1)[0].t === 1000);
  log.clear();
  ok('event clear empties', new EventLog(dir).rows().length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
