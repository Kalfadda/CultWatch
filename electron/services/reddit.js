'use strict';

const { getJson, request, getText } = require('./http');

/**
 * Reddit mentions.
 *
 * As of Reddit's "Responsible Builder Policy", the old unauthenticated
 * www.reddit.com/search.json endpoint returns HTTP 403 everywhere — read
 * access now requires an OAuth token. We support two auth shapes from a free
 * app registered at https://www.reddit.com/prefs/apps :
 *
 *   1. "installed app"  -> Client ID only (recommended). App-only token via the
 *      installed_client grant. No secret, no password, no approval queue.
 *   2. "web app/script" -> Client ID + Secret. App-only token via
 *      client_credentials.
 *
 * With a token we query https://oauth.reddit.com/search . With no credentials
 * we fall back to the public Atom RSS feed (best-effort; also increasingly
 * rate-limited, but works often enough to be useful before you add a key).
 */

let tokenCache = { token: null, id: null, expiresAt: 0, deviceId: null };

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function deviceId() {
  if (tokenCache.deviceId) return tokenCache.deviceId;
  // 24+ char opaque id; value is arbitrary and stable for the session.
  const id = 'CW' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  tokenCache.deviceId = id.slice(0, 30);
  return tokenCache.deviceId;
}

async function getToken(clientId, clientSecret, now) {
  if (tokenCache.token && tokenCache.id === clientId && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }
  const auth = b64(`${clientId}:${clientSecret || ''}`);
  const body = clientSecret
    ? 'grant_type=client_credentials'
    : `grant_type=https://oauth.reddit.com/grants/installed_client&device_id=${deviceId()}`;
  const res = await request('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Reddit auth failed (HTTP ${res.status})${t ? ' — ' + t.slice(0, 80) : ''}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Reddit auth: no access_token returned');
  tokenCache = { ...tokenCache, token: json.access_token, id: clientId, expiresAt: now + (json.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function normalizeOAuth(children) {
  return children
    .map((c) => c.data)
    .filter(Boolean)
    .map((d) => ({
      id: d.id,
      title: d.title,
      subreddit: d.subreddit_name_prefixed || `r/${d.subreddit}`,
      author: d.author,
      score: d.score || 0,
      comments: d.num_comments || 0,
      url: `https://www.reddit.com${d.permalink}`,
      thumbnail: d.thumbnail && d.thumbnail.startsWith('http') ? d.thumbnail : null,
      selftext: (d.selftext || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      created: d.created_utc ? d.created_utc * 1000 : null,
      nsfw: !!d.over_18
    }));
}

async function searchOAuth(query, limit, clientId, clientSecret, now) {
  const token = await getToken(clientId, clientSecret, now);
  const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=new&limit=${limit}&type=link&raw_json=1`;
  const json = await getJson(url, { headers: { Authorization: `Bearer ${token}` } });
  return normalizeOAuth((json.data && json.data.children) || []);
}

async function searchRss(query, limit) {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&limit=${limit}&type=link`;
  const xml = await getText(url, { headers: { Accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' } });
  return parseAtom(xml).slice(0, limit);
}

// Minimal Atom parser for Reddit's search feed (no XML dependency).
function parseAtom(xml) {
  const out = [];
  const entries = xml.split(/<entry>/i).slice(1);
  for (const e of entries) {
    const title = decodeXml(pick(e, 'title'));
    const link = (e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const author = decodeXml(pick(e, 'name'));
    const updated = pick(e, 'updated');
    const contentHtml = pick(e, 'content');
    const sub = (link.match(/\/r\/([^/]+)\//) || [])[1];
    out.push({
      id: pick(e, 'id') || link,
      title: title || '(untitled)',
      subreddit: sub ? `r/${sub}` : 'reddit',
      author: (author || '').replace(/^\/u\//, ''),
      score: 0,
      comments: 0,
      url: link,
      thumbnail: null,
      selftext: decodeXml(contentHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
      created: updated ? new Date(updated).getTime() : null,
      nsfw: false
    });
  }
  return out;
}
function pick(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/**
 * @param {{keywords:string[], clientId?:string, clientSecret?:string}} opts
 */
async function search(opts, limit = 25, now = Date.now()) {
  const { keywords = [], clientId = '', clientSecret = '' } = opts || {};
  const query = keywords.map((k) => `"${k}"`).join(' OR ');

  if (clientId) {
    return searchOAuth(query, limit, clientId, clientSecret, now);
  }
  // No credentials: best-effort RSS, with a clear error if Reddit blocks it.
  try {
    return await searchRss(query, limit);
  } catch (err) {
    throw new Error(
      `Reddit needs a free Client ID now (add it in Settings). Public access is blocked: ${err.message}`
    );
  }
}

module.exports = { search };
