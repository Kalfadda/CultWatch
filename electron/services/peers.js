'use strict';

const { request } = require('./http');

/**
 * Peer concurrent players — the denominator for our own number.
 *
 * Keyless: the same public endpoint the app already uses for its own CCU, one
 * request per peer in parallel.
 *
 * Steam answers HTTP 404 with `result: 42` for apps that report no live player
 * data (small or delisted titles). That is "no data", not a failure — such a
 * peer renders dim rather than turning the whole panel red.
 */

const API = 'https://api.steampowered.com';

async function getOne(peer) {
  const base = { appId: String(peer.appId), name: peer.name || `App ${peer.appId}` };
  try {
    const res = await request(
      `${API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(peer.appId)}`
    );
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`unreadable response (HTTP ${res.status})`);
    }
    const r = (json && json.response) || {};
    if (r.result === 1 && typeof r.player_count === 'number') {
      return { ...base, count: r.player_count, available: true, error: null };
    }
    return { ...base, count: null, available: false, error: null };
  } catch (err) {
    return { ...base, count: null, available: false, error: err.message || String(err) };
  }
}

/** Never rejects — a peer that fails comes back as `available: false`. */
async function getPeerPlayers(peers) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && p.appId) : [];
  if (!list.length) return [];
  return Promise.all(list.map(getOne));
}

/** Merge our own count into the peer list and rank them together. */
function rankPeers(list, ourCount, ourName) {
  const rows = (list || []).map((p) => ({ ...p, us: false }));
  if (typeof ourCount === 'number') {
    rows.push({ appId: 'us', name: ourName || 'Us', count: ourCount, available: true, error: null, us: true });
  }
  rows.sort((a, b) => (b.count == null ? -1 : b.count) - (a.count == null ? -1 : a.count));
  const idx = rows.findIndex((r) => r.us);
  return { rows, ourRank: idx < 0 ? null : idx + 1, ourCount: typeof ourCount === 'number' ? ourCount : null };
}

module.exports = { getPeerPlayers, rankPeers };
