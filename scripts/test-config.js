'use strict';

/**
 * Unit tests for the config store — defaults, deep merge and the peer
 * line-up migration (no network, no Electron).
 *   node scripts/test-config.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJson } = require('../electron/atomic');
const { Store, DEFAULTS } = require('../electron/config');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

const LEGACY_PEERS = [
  { appId: '1433340', name: "Happy's Humble Burger Farm" },
  { appId: '1295920', name: 'The Mortuary Assistant' },
  { appId: '2916430', name: 'Fast Food Simulator' },
  { appId: '4121170', name: 'Fears to Fathom: Scratch Creek' },
  { appId: '2881650', name: 'Content Warning' }
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-'));
let n = 0;
function freshDir(seed) {
  const dir = path.join(tmp, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  if (seed) writeJson(path.join(dir, 'cultwatch-config.json'), seed);
  return dir;
}

// ============================================================
// 1. Defaults
// ============================================================
{
  const c = new Store(freshDir(null)).get();
  ok('a fresh install gets the default peers', c.peers.length === DEFAULTS.peers.length);
  ok('defaults are deep-cloned, not shared', c.peers !== DEFAULTS.peers && c.peers[0] !== DEFAULTS.peers[0]);

  const ids = DEFAULTS.peers.map((p) => p.appId);
  ok('R.E.P.O. is a default peer', ids.includes('3241660'));
  ok('RV There Yet? is a default peer', ids.includes('3949040'));
  ok('The Mortuary Assistant is gone', !ids.includes('1295920'));
  ok('peer App IDs are unique', new Set(ids).size === ids.length);
  ok('every default peer has a name', DEFAULTS.peers.every((p) => p.name && p.appId));
}

// ============================================================
// 2. Deep merge of a saved config over defaults
// ============================================================
{
  const c = new Store(freshDir({ refreshIntervalSec: 15, sources: { reddit: false } })).get();
  ok('a saved scalar wins over the default', c.refreshIntervalSec === 15);
  ok('a saved nested key wins', c.sources.reddit === false);
  ok('unsaved siblings keep their defaults', c.sources.steam === true);
  ok('keys absent from the save still exist', typeof c.appId === 'string');
}

// ============================================================
// 3. Peer migration
// ============================================================
{
  const c = new Store(freshDir({ peers: LEGACY_PEERS })).get();
  ok('an untouched legacy line-up migrates', c.peers.map((p) => p.appId).join(',') ===
    DEFAULTS.peers.map((p) => p.appId).join(','));
}
{
  const mine = [{ appId: '400', name: 'Portal 2' }];
  const c = new Store(freshDir({ peers: mine })).get();
  ok('a customised line-up is left alone', c.peers.length === 1 && c.peers[0].appId === '400');
}
{
  // Same games, one removed — a deliberate edit, not the shipped default.
  const c = new Store(freshDir({ peers: LEGACY_PEERS.slice(0, 4) })).get();
  ok('a trimmed legacy line-up is left alone', c.peers.length === 4);
}
{
  // Same IDs, reordered — also a deliberate edit.
  const c = new Store(freshDir({ peers: [LEGACY_PEERS[1], ...LEGACY_PEERS.slice(2), LEGACY_PEERS[0]] })).get();
  ok('a reordered legacy line-up is left alone', c.peers[0].appId === '1295920');
}
{
  const c = new Store(freshDir({ peers: [] })).get();
  ok('an intentionally empty line-up stays empty', c.peers.length === 0);
}
{
  const dir = freshDir({ peers: LEGACY_PEERS });
  new Store(dir);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cultwatch-config.json'), 'utf8'));
  ok('migration does not write on startup', onDisk.peers.length === LEGACY_PEERS.length &&
    onDisk.peers[1].appId === '1295920');

  const store = new Store(dir);
  store.update({ refreshIntervalSec: 30 });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'cultwatch-config.json'), 'utf8'));
  ok('the next save persists the migrated line-up', after.peers.map((p) => p.appId).join(',') ===
    DEFAULTS.peers.map((p) => p.appId).join(','));

  ok('a migrated config does not re-migrate', new Store(dir).get().peers.map((p) => p.appId).join(',') ===
    DEFAULTS.peers.map((p) => p.appId).join(','));
}
{
  // Malformed entries must not throw the fingerprint check.
  const c = new Store(freshDir({ peers: [null, { name: 'no id' }] })).get();
  ok('a malformed line-up does not throw or migrate', c.peers.length === 2);
}

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
