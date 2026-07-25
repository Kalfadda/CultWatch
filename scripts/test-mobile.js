'use strict';

/**
 * Guards the mobile bundle against the failure mode that shipped in the first
 * Android build: `bootstrap.js` declared `let snapshot` at the top level and so
 * did `app.js`. Classic scripts share one global lexical scope, so the second
 * declaration is a SyntaxError — and the whole of app.js never executed. The UI
 * sat on its loading state forever and no button did anything, while the data
 * layer underneath polled and persisted perfectly.
 *
 * Nothing catches that except loading the app on a device, which is far too late
 * and far too slow. These checks are static and take milliseconds.
 *   node scripts/test-mobile.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { build, assets } = require('./build-mobile');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'mobile', 'www');

// Always test what the build actually produces, not a stale copy.
build();
assets();

// ============================================================
// 1. The scripts must survive being loaded into one shared scope
// ============================================================
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

ok('index.html loads the core bundle first', srcs[0] === 'js/cultwatch-core.js');
ok('bootstrap runs before any view script', srcs.indexOf('js/bootstrap.js') === 1);
ok('app.js loads last', srcs[srcs.length - 1] === 'app.js');

{
  // Compiling the concatenation reproduces exactly what the WebView does when it
  // evaluates each classic script into the same global lexical scope. A
  // duplicate top-level let/const/class throws here, just as it did on the phone.
  const combined = srcs.map((s) => fs.readFileSync(path.join(WWW, s), 'utf8')).join('\n;\n');
  let err = null;
  try {
    new vm.Script(combined, { filename: 'combined-mobile-scripts.js' });
  } catch (e) {
    err = e;
  }
  ok('all scripts share one global scope without redeclaring anything', !err,
    err ? err.message : '');
}

// ============================================================
// 2. bootstrap.js must not leak globals at all
// ============================================================
// The scope collision above is only possible because bootstrap declares things
// at the top level. Keeping its body inside an IIFE removes the entire class of
// bug rather than the one instance of it, so that property is asserted directly.
{
  const boot = fs.readFileSync(path.join(WWW, 'js', 'bootstrap.js'), 'utf8');
  const leaked = [
    ...[...boot.matchAll(/^(?:let|const|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...boot.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...boot.matchAll(/^class\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
  ];
  ok('bootstrap declares nothing in the global scope', leaked.length === 0,
    leaked.length ? 'leaks: ' + leaked.join(', ') : '');
  ok('bootstrap still exposes the renderer bridge', /window\.cultwatch\s*=/.test(boot));
}

// ============================================================
// 3. The bridge must cover everything the renderer calls
// ============================================================
// app.js/trends.js/tinybuild.js are copied verbatim from the desktop build, so
// any IPC method they use has to exist on the mobile bridge or that button is
// dead — the same silent breakage, just narrower.
{
  const boot = fs.readFileSync(path.join(WWW, 'js', 'bootstrap.js'), 'utf8');

  // Look only *inside* the bridge literal. Scanning the whole file would happily
  // match a same-named local function that is never actually exposed, which is a
  // false pass on the one thing this check exists to catch.
  const start = boot.indexOf('window.cultwatch = {');
  let depth = 0, end = -1;
  for (let i = boot.indexOf('{', start); i < boot.length; i++) {
    if (boot[i] === '{') depth++;
    else if (boot[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const literal = start >= 0 && end > start ? boot.slice(start, end) : '';
  ok('the bridge literal is parseable', literal.length > 0);

  // Strip comments before reading keys, or a commented line preceding a key
  // hides it. Only whole-line `//` comments are removed — a mid-line strip would
  // eat the `https://` in the store URL.
  const clean = literal
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Keys at depth 1, covering both `name:` and shorthand `name,`.
  const keys = new Set();
  for (const m of clean.matchAll(/(?:^|[{,])\s*([A-Za-z0-9_$]+)\s*(?=[:,}])/gm)) keys.add(m[1]);

  const used = new Set();
  for (const f of ['app.js', 'trends.js', 'tinybuild.js']) {
    const src = fs.readFileSync(path.join(WWW, f), 'utf8');
    for (const m of src.matchAll(/cultwatch\.([A-Za-z0-9_$]+)\s*\(/g)) used.add(m[1]);
  }
  const missing = [...used].filter((m) => !keys.has(m));
  ok(`bridge implements all ${used.size} methods the renderer calls`, missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : '');
}

// ============================================================
// 4. The mobile platform swaps must actually be in the bundle
// ============================================================
{
  const core = fs.readFileSync(path.join(WWW, 'js', 'cultwatch-core.js'), 'utf8');
  ok('atomic is the localStorage version, not the fs one', /localStorage\.setItem/.test(core) &&
    !/fs\.writeFileSync\(tmp/.test(core));
  ok('http is the CapacitorHttp version', /CapacitorHttp/.test(core));
  ok('the cohort service is bundled', /rankCohort/.test(core));
  ok('no bare Node require survived the bundle', !/require\('node:/.test(core));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
