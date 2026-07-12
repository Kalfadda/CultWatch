'use strict';

/**
 * Thin fetch wrapper: sane User-Agent (many public APIs 403 datacenter/no-UA
 * requests), hard timeout, and JSON/text helpers. Uses the global fetch that
 * ships with modern Node / Electron main process.
 */

const UA = 'CultWatch/1.0 (+situation-room; contact: dev@scythedevteam)';

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...headers },
      body,
      signal: ctrl.signal,
      redirect: 'follow'
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${short(url)}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${short(url)} (got "${text.slice(0, 60)}")`);
  }
}

async function getText(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${short(url)}`);
  return res.text();
}

function short(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 60);
  }
}

module.exports = { request, getJson, getText, UA };
