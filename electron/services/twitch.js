'use strict';

const { getJson, request } = require('./http');

/**
 * Twitch Helix: live streams for the game. Requires a Client ID + Client
 * Secret (free — create an app at dev.twitch.tv/console/apps). We mint an
 * app-access token via client_credentials and cache it until near expiry.
 */

let tokenCache = { token: null, clientId: null, expiresAt: 0 };

async function getAppToken(clientId, clientSecret, now) {
  if (
    tokenCache.token &&
    tokenCache.clientId === clientId &&
    tokenCache.expiresAt > now + 60000
  ) {
    return tokenCache.token;
  }
  const url =
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const res = await request(url, { method: 'POST' });
  if (!res.ok) throw new Error(`Twitch auth failed (HTTP ${res.status})`);
  const json = await res.json();
  tokenCache = {
    token: json.access_token,
    clientId,
    expiresAt: now + (json.expires_in || 3600) * 1000
  };
  return tokenCache.token;
}

async function getLiveStreams({ clientId, clientSecret, gameName }, now = Date.now()) {
  if (!clientId || !clientSecret) {
    return { enabled: false, reason: 'Add Twitch Client ID + Secret in Settings', live: [], totalViewers: 0 };
  }
  const token = await getAppToken(clientId, clientSecret, now);
  const headers = { 'Client-ID': clientId, Authorization: `Bearer ${token}` };

  // Resolve the game/category id by exact name.
  const gameJson = await getJson(
    `https://api.twitch.tv/helix/games?name=${encodeURIComponent(gameName)}`,
    { headers }
  );
  const game = gameJson.data && gameJson.data[0];
  if (!game) {
    return { enabled: true, live: [], totalViewers: 0, note: `No Twitch category named "${gameName}" yet` };
  }

  const streamsJson = await getJson(
    `https://api.twitch.tv/helix/streams?game_id=${game.id}&first=20`,
    { headers }
  );
  const live = (streamsJson.data || []).map((s) => ({
    id: s.id,
    user: s.user_name,
    title: (s.title || '').trim(),
    viewers: s.viewer_count || 0,
    language: s.language,
    thumbnail: (s.thumbnail_url || '').replace('{width}', '320').replace('{height}', '180'),
    url: `https://twitch.tv/${s.user_login}`,
    startedAt: s.started_at ? new Date(s.started_at).getTime() : null
  }));
  live.sort((a, b) => b.viewers - a.viewers);
  const totalViewers = live.reduce((sum, s) => sum + s.viewers, 0);
  return { enabled: true, live, totalViewers, gameBoxArt: game.box_art_url };
}

module.exports = { getLiveStreams };
