'use strict';

/**
 * Measures the real layout inside the Android WebView, over adb.
 *
 * Static tests cannot catch a button that has been pushed off the edge of a
 * phone, and a screenshot only proves the part you happen to look at. This
 * connects to the running debug build via the Chrome DevTools Protocol and asks
 * the page itself where every interactive element actually is.
 *
 * It exists because two real bugs shipped that nothing else would have caught:
 * the ⚙ settings button sat off-screen on a ~344px viewport, and the panel range
 * tabs overflowed ~80px past the right edge where `overflow-x: hidden` silently
 * clipped them — visibly fine, completely unreachable.
 *
 * Requires a connected device running the DEBUG build (release builds disable
 * WebView debugging by design).
 *
 *   node scripts/check-mobile-layout.js
 */

const http = require('http');
const { execFileSync } = require('child_process');

const ADB = process.env.ADB || 'C:/Users/Kaleb/android-tools/sdk/platform-tools/adb.exe';
const PKG = 'com.scythedevteam.cultwatch';
const PORT = 9222;

// Off-canvas by design: the settings drawer sits beyond the right edge until
// opened, so it is not an overflow bug.
const OFFCANVAS = ['drawer', 'drawer-scrim', 'alert-center', 'toast'];

function adb(args) {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout: 30000 });
}

function forwardDevtools() {
  const socks = adb(['shell', 'cat', '/proc/net/unix']);
  const m = [...socks.matchAll(/webview_devtools_remote_(\d+)/g)].map((x) => x[0]);
  if (!m.length) {
    throw new Error('No WebView devtools socket. Is the DEBUG build running on the device?');
  }
  adb(['forward', `tcp:${PORT}`, `localabstract:${m[m.length - 1]}`]);
}

function targets() {
  return new Promise((res, rej) => {
    const req = http.get(`http://localhost:${PORT}/json/list`, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(10000, () => req.destroy(new Error('devtools timed out')));
  });
}

const EXPR = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth, vh = de.clientHeight;
  const skip = ${JSON.stringify(OFFCANVAS)};
  const isOffCanvas = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = (n.className || '').toString();
      if (skip.some((s) => c.split(/\\s+/).includes(s))) return true;
    }
    return false;
  };
  const named = ['#refreshBtn','#bellBtn','#settingsBtn','#viewSwitch','#launchStatus','.brand','.updated'];
  const out = { vw, vh, overflowX: de.scrollWidth - de.clientWidth, named: [], overflowers: [] };
  out.named = named.map((s) => {
    const el = document.querySelector(s);
    if (!el) return { sel: s, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { sel: s, x: Math.round(r.x), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
      off: r.right > vw + 0.5 || r.left < -0.5,
      hidden: cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 };
  });
  out.overflowers = [...document.querySelectorAll('body *')]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (getComputedStyle(e).display === 'none') return false;
      if (isOffCanvas(e)) return false;
      return r.right > vw + 1 || r.left < -1;
    })
    .map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 40),
      right: Math.round(e.getBoundingClientRect().right) }));
  return out;
})()`;

/**
 * Widths worth proving, in CSS px. A single device only ever exercises one of
 * these, and "it looked fine on my phone" is how the ⚙ button shipped
 * off-screen. Device emulation lets one handset stand in for the range.
 */
const WIDTHS = [
  [320, 'small Android (Galaxy S/A at 320dp)'],
  [344, 'Z Fold cover screen'],
  [360, 'most common Android width'],
  [393, 'Pixel 8 / iPhone class'],
  [412, 'Pixel Pro class'],
  [480, 'large phone landscape-ish'],
  [673, 'Z Fold inner screen'],
  [840, 'small tablet / unfolded wide']
];

/** Minimal CDP session: one socket, promise per command id. */
function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let next = 1;
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('devtools websocket failed'));
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };
  return {
    ready,
    send(method, params) {
      const id = next++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error(method + ' timed out'));
        }, 15000);
      });
    },
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    },
    close() { try { ws.close(); } catch { /* already gone */ } }
  };
}

const VIEWS = ['live', 'trends', 'tinybuild'];

(async () => {
  adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
  await new Promise((r) => setTimeout(r, 4000));
  forwardDevtools();

  const page = (await targets()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page found');

  const cdp = session(page.webSocketDebuggerUrl);
  await cdp.ready;

  let fail = 0;
  const problems = [];

  for (const [width, label] of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: 0, mobile: true
    });

    for (const view of VIEWS) {
      // Drive the real view switch rather than toggling classes, so each board is
      // measured in exactly the state a user would put it in.
      await cdp.eval(`document.querySelector('[data-view="${view}"]').click()`);
      await new Promise((r) => setTimeout(r, 250));

      const v = await cdp.eval(EXPR);
      const missing = v.named.filter((e) => e.missing || e.off || e.hidden);
      const bad = missing.length + v.overflowers.length + (v.overflowX > 0 ? 1 : 0);
      if (bad) {
        fail += bad;
        problems.push({ width, label, view, v, missing });
      }
      const tag = bad ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mPASS\x1b[0m';
      console.log(`  ${tag}  ${String(width).padStart(4)}px ${view.padEnd(10)} ${label}`);
    }
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  cdp.close();

  for (const p of problems) {
    console.log(`\n  --- ${p.width}px · ${p.view} ---`);
    if (p.v.overflowX > 0) console.log(`      page scrolls horizontally by ${p.v.overflowX}px`);
    for (const e of p.missing) {
      console.log(`      ${e.sel}: ${e.missing ? 'MISSING' : e.hidden ? 'HIDDEN' : `off-screen (right=${e.right} > ${p.v.vw})`}`);
    }
    for (const o of p.v.overflowers.slice(0, 6)) {
      console.log(`      clipped: ${o.tag}.${o.cls} right=${o.right} > ${p.v.vw}`);
    }
  }

  console.log(fail
    ? `\n  ${fail} layout problem(s) across ${WIDTHS.length} widths x ${VIEWS.length} views\n`
    : `\n  layout clean across all ${WIDTHS.length} widths x ${VIEWS.length} views\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n  layout check failed:', err.message, '\n');
  process.exit(2);
});
