'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Crash-safe JSON persistence. Writes land in a sibling temp file, are flushed
 * to the physical disk, and are then renamed into place — rename is atomic on
 * both NTFS and POSIX, so a process death mid-write leaves the previous good
 * file intact rather than a truncated one.
 *
 * The fsync is not optional, and its absence cost the entire player record once.
 * Rename is atomic for *metadata* only: without a flush the file's contents can
 * still be sitting in the OS write cache, and an unclean shutdown then lets the
 * filesystem replay the rename while the data itself is lost. The file comes
 * back empty or NUL-filled. Anything rewritten every minute — the three series
 * tiers, the alert state — is nearly always inside that window when the power
 * goes; anything written once a day is long since flushed. That is exactly the
 * damage pattern observed on 2026-08-06 after an unexpected shutdown.
 *
 * The containing directory is deliberately not fsynced: it is unsupported on
 * Windows, where this was observed, and what was lost was file contents rather
 * than a rename.
 */

/**
 * A read that says *why* it failed.
 *
 * The distinction is the whole point: a missing file means "first run, start
 * fresh", an unreadable one means "the record is still there and must not be
 * written over". Collapsing both into a fallback value is what turned one
 * corrupt file into a deleted history.
 */
function readJsonState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', data: null, error: null };
    return { status: 'unreadable', data: null, error: err.message || String(err) };
  }
  try {
    return { status: 'ok', data: JSON.parse(raw), error: null };
  } catch (err) {
    // Includes the empty and NUL-filled files an interrupted write leaves behind.
    return { status: 'unreadable', data: null, error: err.message || String(err) };
  }
}

/** Convenience wrapper for callers with nothing to lose from a failed read. */
function readJson(file, fallback) {
  const r = readJsonState(file);
  return r.status === 'ok' ? r.data : fallback;
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[atomic] failed to write ${path.basename(file)}:`, err.message);
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/**
 * Move an unreadable file aside instead of overwriting it. The bytes are no use
 * to the app, but they are the only evidence of what went wrong, and a user who
 * has just lost a month of history is owed something to point a recovery tool at.
 * Returns the new path, or null if even the rename failed.
 */
function quarantine(file, stamp = Date.now()) {
  const dest = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

module.exports = { readJson, readJsonState, writeJson, quarantine };
