'use strict';

/**
 * Unit tests for atomic persistence, the tiered player-count series and the
 * event log (no network, no Electron).
 *   node scripts/test-history.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJson, readJsonState, writeJson, quarantine } = require('../electron/atomic');
const { Series, segments, dayKey, bucketStart, coverageFor, DAILY_BACKUP_MS } = require('../electron/history');
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
// 1b. A failed read must say *why* it failed
// ============================================================
// Collapsing "missing" and "unreadable" into one fallback value is what let a
// single file corrupted by an unclean shutdown wipe the permanent record: the
// empty result was rebuilt into the tiers and written straight back over it.
{
  const dir = fs.mkdtempSync(path.join(tmp, 'state-'));
  const f = path.join(dir, 'x.json');
  ok('readJsonState reports a missing file as missing', readJsonState(f).status === 'missing');
  writeJson(f, { a: 1 });
  const good = readJsonState(f);
  ok('readJsonState reports a good file as ok', good.status === 'ok' && good.data.a === 1);

  fs.writeFileSync(f, '{ not json');
  ok('readJsonState reports garbage as unreadable', readJsonState(f).status === 'unreadable');

  // The two shapes an interrupted write actually leaves behind on NTFS.
  fs.writeFileSync(f, '');
  ok('an empty file is unreadable, not valid emptiness', readJsonState(f).status === 'unreadable');
  fs.writeFileSync(f, Buffer.alloc(64));
  ok('a NUL-filled file is unreadable', readJsonState(f).status === 'unreadable');

  const moved = quarantine(f, 12345);
  ok('quarantine moves the file aside', moved === f + '.corrupt-12345' && fs.existsSync(moved));
  ok('quarantine leaves the original path free', !fs.existsSync(f));
  ok('quarantine preserves the bytes', fs.readFileSync(moved).length === 64);
  ok('quarantine of a missing file returns null', quarantine(f, 1) === null);
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

  // A half-migrated state (one derived file lost) rebuilds the lost tier and
  // leaves the surviving one alone. Rebuilding both is what destroyed the daily
  // record when only the medium file was damaged.
  fs.unlinkSync(path.join(dir, 'cultwatch-series-medium.json'));
  const rebuilt = new Series(dir, { maxFine: 2880 });
  ok('a missing derived tier rebuilds without discarding the other',
    rebuilt.getMedium().length === 120 && rebuilt.getDaily().reduce((n, d) => n + d.n, 0) === 600);
}

// ============================================================
// 6b. An unreadable file must never cost more than itself
// ============================================================
// The bug this whole section exists for: an unclean shutdown on 2026-08-06 left
// the files that are rewritten every minute empty, the empty read was taken for
// a first run, and the rebuild was written over a month of daily rollups.
const DAY = 86400000;
function seedDays(dir, days, opts) {
  const s = new Series(dir, opts || { maxFine: 2880 });
  const t0 = new Date('2026-07-01T12:00:00').getTime();
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < 10; i++) s.push({ t: t0 + d * DAY + i * 60000, v: 100 + i });
  }
  return s;
}

{
  const dir = fs.mkdtempSync(path.join(tmp, 'dur-fine-'));
  seedDays(dir, 3);
  const fineFile = path.join(dir, 'cultwatch-history.json');

  fs.writeFileSync(fineFile, ''); // what an interrupted write leaves behind
  const after = new Series(dir, { maxFine: 2880 });
  ok('a corrupt fine tier does not take the daily record with it', after.getDaily().length === 3);
  ok('a corrupt fine tier does not take the medium tier with it', after.getMedium().length === 6);
  ok('fine itself starts empty', after.getFine().length === 0);
  ok('the corrupt file is quarantined, not overwritten',
    fs.readdirSync(dir).some((n) => n.startsWith('cultwatch-history.json.corrupt-')));
  ok('the damage is reported rather than swallowed',
    after.health().damaged.length === 1 && after.health().damaged[0].file === 'cultwatch-history.json');
}

// ============================================================
// 6c. The daily record is recovered from its backup
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 'dur-bak-'));
  seedDays(dir, 3);
  const bakFile = path.join(dir, 'cultwatch-series-daily.bak.json');
  ok('a backup is written alongside the record', fs.existsSync(bakFile));

  // The realistic crash: every file that was being rewritten comes back empty.
  fs.writeFileSync(path.join(dir, 'cultwatch-series-daily.json'), Buffer.alloc(32));
  fs.writeFileSync(path.join(dir, 'cultwatch-history.json'), '');

  const after = new Series(dir, { maxFine: 2880 });
  ok('the daily record is restored from the backup', after.getDaily().length === 3);
  ok('the recovery is reported', after.health().recovered === true);
  // The backup is deliberately allowed to lag by up to four hours — the last
  // day comes back thinner, which is the whole point of it being written rarely.
  ok('the restored record is the backup, staleness and all', after.getDaily()[2].n === 1);
  ok('the corrupt daily file is quarantined',
    fs.readdirSync(dir).some((n) => n.startsWith('cultwatch-series-daily.json.corrupt-')));

  fs.unlinkSync(bakFile);
  ok('the restored record was written back to the primary',
    new Series(dir, { maxFine: 2880 }).getDaily().length === 3);
}

// ============================================================
// 6d. Cadence: rarely, and never shrinking
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 'dur-cad-'));
  const bakFile = path.join(dir, 'cultwatch-series-daily.bak.json');
  const s = new Series(dir, { maxFine: 5000 });
  const t0 = new Date('2026-07-01T08:00:00').getTime();

  s.push({ t: t0, v: 10 });
  ok('the backup is written on the first push of a session', readJson(bakFile, {}).savedAt === t0);
  s.push({ t: t0 + 60000, v: 11 });
  ok('the backup is not rewritten on every push', readJson(bakFile, {}).savedAt === t0);
  s.push({ t: t0 + DAILY_BACKUP_MS, v: 12 });
  ok('the backup is refreshed after four hours', readJson(bakFile, {}).savedAt === t0 + DAILY_BACKUP_MS);
  s.push({ t: t0 + DAY, v: 13 });
  ok('the backup is refreshed on a day rollover', readJson(bakFile, {}).rows.length === 2);
}

{
  // A primary that reads fine but holds less than the backup: a session started
  // from a thin record must not be able to erase the fuller safety copy.
  const dir = fs.mkdtempSync(path.join(tmp, 'dur-shrink-'));
  const bakFile = path.join(dir, 'cultwatch-series-daily.bak.json');
  const thin = [{ d: '2026-07-03', peak: 5, min: 5, sum: 5, n: 1, first: 1, last: 1, peers: {} }];
  const fat = ['2026-07-01', '2026-07-02', '2026-07-03'].map((d) => ({ d, peak: 9, min: 9, sum: 9, n: 1, first: 1, last: 1, peers: {} }));
  writeJson(path.join(dir, 'cultwatch-series-daily.json'), { v: 2, rows: thin });
  writeJson(path.join(dir, 'cultwatch-series-medium.json'), { v: 2, rows: [] });
  writeJson(bakFile, { v: 2, savedAt: 0, rows: fat });

  const s = new Series(dir, { maxFine: 100 });
  ok('a readable primary is not second-guessed', s.getDaily().length === 1);
  s.push({ t: new Date('2026-07-03T09:00:00').getTime(), v: 7 });
  ok('the backup is never traded for a thinner copy', readJson(bakFile, {}).rows.length === 3);
}

{
  // Clearing has to clear the backup too, or the next launch restores exactly
  // what the user just asked to delete.
  const dir = fs.mkdtempSync(path.join(tmp, 'dur-clear-'));
  seedDays(dir, 2).clear();
  ok('clear empties the backup as well',
    readJson(path.join(dir, 'cultwatch-series-daily.bak.json'), null).rows.length === 0);
  ok('a cleared series does not restore itself on reopen',
    new Series(dir, { maxFine: 2880 }).getDaily().length === 0);
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
