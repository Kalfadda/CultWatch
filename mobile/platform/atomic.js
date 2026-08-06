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

/**
 * Mirrors the desktop contract exactly, including the distinction the desktop
 * version was missing: an absent key means "first run", a value that will not
 * parse means "the record is still there and must not be written over".
 * history.js is shared verbatim and relies on the difference.
 */
function readJsonState(file) {
  let raw;
  try {
    raw = localStorage.getItem(PREFIX + file);
  } catch (err) {
    return { status: 'unreadable', data: null, error: err.message || String(err) };
  }
  if (raw == null) return { status: 'missing', data: null, error: null };
  try {
    return { status: 'ok', data: JSON.parse(raw), error: null };
  } catch (err) {
    return { status: 'unreadable', data: null, error: err.message || String(err) };
  }
}

function readJson(file, fallback) {
  const r = readJsonState(file);
  return r.status === 'ok' ? r.data : fallback;
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

/**
 * Move an unparseable value aside rather than overwriting it, so the bytes
 * survive for diagnosis. Quota is the constraint here, not corruption, so a
 * failed copy is not worth fighting: the live key is rewritten by the next poll
 * either way, and the caller reports the loss honestly.
 */
function quarantine(file, stamp = Date.now()) {
  const dest = `${file}.corrupt-${stamp}`;
  try {
    const raw = localStorage.getItem(PREFIX + file);
    if (raw == null) return null;
    localStorage.setItem(PREFIX + dest, raw);
    localStorage.removeItem(PREFIX + file);
    return dest;
  } catch {
    return null;
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

module.exports = { readJson, readJsonState, writeJson, quarantine, usageBytes };
