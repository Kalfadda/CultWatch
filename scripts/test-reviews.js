'use strict';

/**
 * Unit tests for the review corpus, complaint clustering and backfill
 * (no network, no Electron).
 *   node scripts/test-reviews.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ReviewStore, classify, analyze, parseTaxonomy, formatTaxonomy,
  backfillReviews, DEFAULT_TAXONOMY, MAX_TEXT
} = require('../electron/reviews');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rev-'));
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-07-24T12:00:00Z').getTime();

(async () => {

// ============================================================
// 1. Classification
// ============================================================
{
  const c = (txt, lang) => classify(txt, lang || 'english', DEFAULT_TAXONOMY);
  ok('detects crash complaints', c('the game keeps crashing on startup').themes.includes('crash'));
  ok('detects freeze as a crash', c('it just freezes on the menu').themes.includes('crash'));
  ok('detects performance complaints', c('terrible fps, stutters constantly').themes.includes('performance'));
  ok('detects price complaints', c('not worth it, way overpriced').themes.includes('price'));
  ok('detects length complaints', c('way too short, beat it in 2 hours').themes.includes('length'));
  ok('detects save complaints', c('lost my progress, no autosave').themes.includes('saves'));
  ok('detects controller complaints', c('controller support is broken').themes.includes('controller'));
  ok('detects motion sickness', c('the fov made me nauseous').themes.includes('motion'));
  ok('one review can match several themes', c('crashes constantly and the fps is awful').themes.length >= 2);
  ok('clean review matches nothing', c('i love this game so much').themes.length === 0);
  ok('english flag is true for english', c('great').english === true);
  ok('non-english is flagged not classified', c('el juego se bloquea', 'spanish').english === false);
  ok('non-english returns no themes', c('el juego se bloquea', 'spanish').themes.length === 0);
  ok('missing text does not throw', c(null).themes.length === 0);
  ok('missing language is treated as english', classify('it crashes', null, DEFAULT_TAXONOMY).english === true);

  // Themes below were derived from this game's real negative reviews; the
  // phrasings are taken verbatim from them.
  ok('microstutters count as performance (no leading word boundary)',
    c('Performance is not stable, many microstutters').themes.includes('performance'));
  ok('detects tutorial / clarity complaints', c('poorly explained objectives, fix the tutorial').themes.includes('onboarding'));
  ok('detects solo-balance complaints', c('Not playable solo as described on the store page').themes.includes('solo'));
  ok('detects gameplay-loop complaints', c('boring gameplay loop, gets stale quick').themes.includes('loop'));
  ok('detects polish complaints', c('Game needs to be put back in the oven').themes.includes('polish'));
  ok('detects unfavourable comparison to the predecessor', c('Poor follow up to the first game').themes.includes('sequel'));
  ok('detects griefing complaints', c('Game needs a kick system, griefers are persistent').themes.includes('griefing'));
  ok('detects high-pitched audio complaints', c('Godawful high pitched sound in the lobby').themes.includes('audio'));
  ok('detects UI complaints', c('disgustingly ugly UI and bad UX').themes.includes('ui'));
}

// ============================================================
// 2. Taxonomy parsing / formatting
// ============================================================
{
  const txt = 'Crashes: crash, freeze\nPrice: expensive, overpriced';
  const tax = parseTaxonomy(txt);
  ok('parseTaxonomy reads label + keywords', tax.length === 2 && tax[0].label === 'Crashes');
  ok('parsed taxonomy generates a key', tax[0].key === 'crashes');
  ok('parsed taxonomy classifies', classify('it freezes constantly', 'english', tax).themes.length === 1);
  ok('parsed keywords match literally, not by stem', classify('it froze', 'english', tax).themes.length === 0);
  ok('formatTaxonomy round-trips', parseTaxonomy(formatTaxonomy(tax)).length === 2);
  ok('blank input yields an empty taxonomy', parseTaxonomy('').length === 0);
  ok('lines without a colon are skipped', parseTaxonomy('nonsense line\nGood: word').length === 1);
  ok('lines with no keywords are skipped', parseTaxonomy('Empty:   \nGood: word').length === 1);
  ok('regex metacharacters in keywords are escaped',
    classify('costs $9.99', 'english', parseTaxonomy('Price: $9.99')).themes.length === 1);
  ok('built-in taxonomy round-trips through format/parse',
    parseTaxonomy(formatTaxonomy(DEFAULT_TAXONOMY)).length === DEFAULT_TAXONOMY.length);
}

// ============================================================
// 3. Analysis
// ============================================================
{
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ id: `c${i}`, t: NOW - i * HOUR, up: false, txt: 'it crashes on launch', lang: 'english' });
  for (let i = 0; i < 2; i++) rows.push({ id: `o${i}`, t: NOW - DAY - i * HOUR, up: false, txt: 'crash again', lang: 'english' });
  for (let i = 0; i < 20; i++) rows.push({ id: `p${i}`, t: NOW - i * HOUR, up: true, txt: 'great game', lang: 'english' });
  rows.push({ id: 'ne1', t: NOW - HOUR, up: false, txt: 'se bloquea todo el tiempo', lang: 'spanish' });
  rows.push({ id: 'un1', t: NOW - HOUR, up: false, txt: 'just did not enjoy it', lang: 'english' });

  const a = analyze(rows, DEFAULT_TAXONOMY, NOW, { total: 34, positive: 20, negative: 14, positivePct: 61 });
  const crash = a.themes.find((t) => t.key === 'crash');
  ok('theme ranked with a count', crash && crash.count === 12);
  ok('theme has a 24h window', crash.last24 === 10 && crash.prior24 === 2);
  ok('theme has a 48h window', crash.recent48 === 12);
  ok('themes with no hits are dropped', !a.themes.some((t) => t.key === 'motion'));
  ok('themes are sorted by count desc', a.themes.every((t, i, arr) => i === 0 || arr[i - 1].count >= t.count));
  ok('positive reviews do not feed complaint themes', crash.count === 12);

  ok('velocity is reviews per hour over 24h', a.velocity.perHour24 > 0);
  ok('velocity counts the last hour', a.velocity.last1h >= 1);
  ok('velocity exposes the prior-24h comparison', a.velocity.countPrior24 === 2);

  ok('coverage counts non-english separately', a.coverage.nonEnglish === 1);
  ok('coverage totals every row', a.coverage.total === rows.length);
  ok('coverage english + nonEnglish === total', a.coverage.english + a.coverage.nonEnglish === a.coverage.total);
  ok('coverage counts themed negatives', a.coverage.themed === 12);
  ok('coverage counts untagged english negatives', a.coverage.untagged === 1);

  ok('rolling 7d positive rate is computed', a.rolling.pct7d != null);
  ok('rolling exposes the all-time rate from the summary', a.rolling.pctAll === 61);
  ok('rolling delta is 7d minus all-time', a.rolling.delta === a.rolling.pct7d - 61);

  ok('analyze of an empty corpus does not throw', analyze([], DEFAULT_TAXONOMY, NOW, null).coverage.total === 0);
  ok('analyze with no summary still returns rolling', analyze(rows, DEFAULT_TAXONOMY, NOW, null).rolling.pctAll === null);
  ok('analyze tolerates a null corpus', analyze(null, DEFAULT_TAXONOMY, NOW, null).themes.length === 0);
}

// ============================================================
// 4. Review store
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 'rs-'));
  const s = new ReviewStore(dir);
  const added = s.ingest([
    { id: 'a', timestamp: NOW, votedUp: true, text: 'good', language: 'english', hoursPlayed: 3, votesUp: 1 },
    { id: 'b', timestamp: NOW, votedUp: false, text: 'bad', language: 'english', hoursPlayed: 1, votesUp: 0 }
  ]);
  ok('ingest returns the number added', added === 2);
  ok('ingest dedupes by id', s.ingest([{ id: 'a', timestamp: NOW, votedUp: true, text: 'good', language: 'english' }]) === 0);
  ok('ingest ignores rows with no id', s.ingest([{ timestamp: NOW, votedUp: true, text: 'x' }]) === 0);
  ok('ingest tolerates a null list', s.ingest(null) === 0);
  ok('rows persist across reopen', new ReviewStore(dir).rows().length === 2);
  ok('stored row keeps the fields analyze needs',
    new ReviewStore(dir).rows().every((r) => 't' in r && 'up' in r && 'txt' in r && 'lang' in r));

  s.ingest([{ id: 'long', timestamp: NOW, votedUp: false, text: 'x'.repeat(2000), language: 'english' }]);
  ok('text is truncated for storage',
    new ReviewStore(dir).rows().every((r) => (r.txt || '').length <= MAX_TEXT));

  ok('rows are stored oldest-first', (() => {
    const s2 = new ReviewStore(fs.mkdtempSync(path.join(tmp, 'rs2-')));
    s2.ingest([{ id: 'n', timestamp: NOW, votedUp: true, text: 'b' }, { id: 'o', timestamp: NOW - DAY, votedUp: true, text: 'a' }]);
    return s2.rows()[0].id === 'o';
  })());

  s.setBackfilled(NOW);
  ok('backfill marker persists', new ReviewStore(dir).backfilledAt() === NOW);
  s.clear();
  ok('clear empties the store', new ReviewStore(dir).rows().length === 0);
  ok('clear resets the backfill marker', new ReviewStore(dir).backfilledAt() === null);
}

// ============================================================
// 5. Backfill
// ============================================================
{
  const dir = fs.mkdtempSync(path.join(tmp, 'bf-'));
  const s = new ReviewStore(dir);
  let calls = 0;
  const fakePage = async () => {
    calls++;
    if (calls === 1) return { reviews: [{ id: 'r1', timestamp: NOW, votedUp: true, text: 'a', language: 'english' }], cursor: 'c2' };
    if (calls === 2) return { reviews: [{ id: 'r2', timestamp: NOW, votedUp: false, text: 'b', language: 'english' }], cursor: 'c3' };
    return { reviews: [], cursor: 'c3' };
  };
  const res = await backfillReviews(s, '1', fakePage);
  ok('backfill walks pages until empty', res.pages === 3);
  ok('backfill adds every review', res.added === 2);
  ok('backfill sets the marker', s.backfilledAt() != null);

  const second = await backfillReviews(s, '1', fakePage);
  ok('backfill runs only once', second.skipped === true);
  ok('backfill makes no further requests once done', calls === 3);
}

{
  // A repeated cursor must terminate the walk rather than loop forever.
  const dir = fs.mkdtempSync(path.join(tmp, 'bf2-'));
  const s = new ReviewStore(dir);
  let calls = 0;
  const stuck = async () => {
    calls++;
    return { reviews: [{ id: `x${calls}`, timestamp: NOW, votedUp: true, text: 'a' }], cursor: 'same' };
  };
  const res = await backfillReviews(s, '1', stuck);
  ok('backfill stops on a repeated cursor', res.pages === 2);

  // maxPages is a hard stop.
  const dir3 = fs.mkdtempSync(path.join(tmp, 'bf3-'));
  const s3 = new ReviewStore(dir3);
  let n = 0;
  const endless = async () => {
    n++;
    return { reviews: [{ id: `y${n}`, timestamp: NOW, votedUp: true, text: 'a' }], cursor: `c${n}` };
  };
  const capped = await backfillReviews(s3, '1', endless, { maxPages: 4 });
  ok('backfill respects maxPages', capped.pages === 4);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

})().catch((err) => {
  console.error('\n  test-reviews crashed:', err);
  process.exit(2);
});
