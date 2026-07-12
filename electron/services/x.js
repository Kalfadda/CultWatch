'use strict';

const { getJson } = require('./http');

/**
 * X / Twitter recent search (API v2). Requires a Bearer token with recent
 * search access. This is an optional/paid tier — Bluesky covers the free
 * social angle. Gracefully disabled when no token is present.
 */

async function search({ bearerToken, keywords }, maxResults = 20) {
  if (!bearerToken) {
    return { enabled: false, reason: 'Add an X API Bearer token in Settings (optional)', posts: [] };
  }
  const query = `(${keywords.map((k) => `"${k}"`).join(' OR ')}) -is:retweet`;
  const url =
    `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}` +
    `&max_results=${Math.min(Math.max(maxResults, 10), 100)}` +
    `&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name,profile_image_url`;
  const json = await getJson(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
  if (json.errors && !json.data) {
    throw new Error((json.errors[0] && json.errors[0].detail) || 'X API error');
  }
  const users = {};
  if (json.includes && json.includes.users) {
    for (const u of json.includes.users) users[u.id] = u;
  }
  const posts = (json.data || []).map((t) => {
    const u = users[t.author_id] || {};
    const m = t.public_metrics || {};
    return {
      id: t.id,
      author: u.name || u.username || 'unknown',
      handle: u.username || '',
      avatar: u.profile_image_url || null,
      text: (t.text || '').replace(/\s+/g, ' ').trim(),
      likes: m.like_count || 0,
      reposts: m.retweet_count || 0,
      replies: m.reply_count || 0,
      url: u.username ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/web/status/${t.id}`,
      created: t.created_at ? new Date(t.created_at).getTime() : null
    };
  });
  return { enabled: true, posts };
}

module.exports = { search };
