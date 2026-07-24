'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Crash-safe JSON persistence. Writes land in a sibling temp file and are then
 * renamed into place — rename is atomic on both NTFS and POSIX, so a process
 * death mid-write leaves the previous good file intact rather than a truncated
 * one. Reads never throw: a missing or corrupt file yields the fallback.
 */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[atomic] failed to write ${path.basename(file)}:`, err.message);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

module.exports = { readJson, writeJson };
