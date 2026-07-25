'use strict';

/**
 * Mobile replacement for electron/services/http.js.
 *
 * This module is the entire reason CultWatch can run on Android at all. Steam's
 * store and Web API endpoints send no `Access-Control-Allow-Origin` header, so a
 * plain `fetch` from inside the WebView is blocked by the browser before the
 * response is ever readable — not because Steam refused it, but because the page
 * is not allowed to see it. CapacitorHttp performs the request in the native
 * layer instead, where CORS does not apply, and hands the body back across the
 * bridge.
 *
 * The exported surface is identical to the desktop version (`request`, `getJson`,
 * `getText`, `UA`), so every service on top compiles against it unchanged. The
 * returned object mimics just enough of the fetch `Response` shape for the two
 * things callers actually do: check `ok`/`status`, and read `.text()`.
 *
 * A native User-Agent still matters here — several of these endpoints 403 a
 * request that arrives without one.
 */

const UA = 'CultWatch/1.0 (+situation-room; contact: dev@scythedevteam)';

function nativeHttp() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : null;
  return (cap && cap.Plugins && cap.Plugins.CapacitorHttp) || null;
}

/** Mimics the slice of `Response` that the services rely on. */
function toResponse(res, url) {
  const status = res.status == null ? 0 : res.status;
  const body = typeof res.data === 'string' ? res.data
    : res.data == null ? ''
      : JSON.stringify(res.data);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: res.headers || {},
    text: async () => body,
    json: async () => (typeof res.data === 'object' && res.data !== null ? res.data : JSON.parse(body))
  };
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 12000 } = {}) {
  const http = nativeHttp();

  // Fall back to plain fetch when running in a desktop browser (npm run
  // mobile:serve). Same-origin dev proxies work; cross-origin Steam calls will
  // be blocked, which is expected and is exactly what the native layer fixes.
  if (!http) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { method, headers: { Accept: 'application/json,*/*', ...headers }, body, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  }

  const res = await http.request({
    url,
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...headers },
    data: body,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    // Steam answers some player-count queries with HTTP 404 and a valid JSON
    // body; the desktop code parses regardless of status, so the transport must
    // hand back error bodies rather than throwing them away.
    responseType: 'text'
  });
  return toResponse(res, url);
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${short(url)}`);
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
    return String(url).slice(0, 60);
  }
}

module.exports = { request, getJson, getText, UA };
