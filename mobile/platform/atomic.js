'use strict';

/**
 * Mobile replacement for electron/atomic.js.
 *
 * Keeps the exact same synchronous `readJson` / `writeJson` interface, which is
 * the whole trick: config.js, history.js, reviews.js and events.js sit directly
 * on top of this and carry on working unmodified. An async store (Preferences,
 * SQLite) would have forced every one of them to be rewritten.
 *
 * localStorage is already atomic per key — there is no partial-write window to
 * defend against, so the temp-file-and-rename dance from the desktop version has
 * no mobile equivalent and is simply dropped.
 *
 * The real risk here is the quota (~5 MB per origin in an Android WebView)
 * rather than corruption, so a failed write is reported loudly instead of being
 * swallowed: silently dropping history would look identical to a quiet day.
 */

const PREFIX = 'cultwatch:';

function readJson(file, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + file);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    localStorage.setItem(PREFIX + file, JSON.stringify(data));
    return true;
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
    console.error(`[atomic] failed to write ${file}:`, quota ? 'storage quota exceeded' : err.message);
    if (quota && typeof window !== 'undefined' && window.cultwatchOnQuotaFull) {
      window.cultwatchOnQuotaFull(file);
    }
    return false;
  }
}

/** Total bytes held under our prefix — surfaced in the UI so a filling quota is
 *  visible before it starts costing us data. */
function usageBytes() {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) n += k.length + (localStorage.getItem(k) || '').length;
  }
  return n;
}

module.exports = { readJson, writeJson, usageBytes };
