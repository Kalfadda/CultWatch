'use strict';

const { getJson } = require('./http');

/**
 * Bluesky post search via the public AppView API (no auth required).
 * https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts
 */

async function search(keywords, limit = 25) {
  // The public search endpoint takes one query string, so we fire one request
  // per name variant (capped) and merge, newest first, de-duplicated.
  const terms = (keywords || []).slice(0, 4);
  if (!terms.length) return [];
  const perTerm = Math.max(8, Math.ceil(limit / terms.length));
  const settled = await Promise.all(
    terms.map((q) =>
      getJson(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${perTerm}&sort=latest`
      ).then((j) => ({ posts: j.posts || [] })).catch((err) => ({ error: err }))
    )
  );
  // If every term failed, surface the error instead of hiding it as "0 results".
  if (settled.every((s) => s.error)) throw settled[0].error;
  const batches = settled.map((s) => s.posts || []);
  const seen = new Set();
  const posts = [];
  for (const batch of batches) {
    for (const p of batch) {
      if (p.cid && seen.has(p.cid)) continue;
      if (p.cid) seen.add(p.cid);
      posts.push(p);
    }
  }
  return posts
    .map((p) => {
    const rkey = (p.uri || '').split('/').pop();
    const handle = p.author && p.author.handle ? p.author.handle : 'unknown';
    return {
      id: p.cid,
      author: (p.author && p.author.displayName) || handle,
      handle,
      avatar: p.author && p.author.avatar ? p.author.avatar : null,
      text: (p.record && p.record.text ? p.record.text : '').replace(/\s+/g, ' ').trim(),
      likes: p.likeCount || 0,
      reposts: p.repostCount || 0,
      replies: p.replyCount || 0,
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
      created: p.record && p.record.createdAt ? new Date(p.record.createdAt).getTime() : null
    };
    })
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, limit);
}

module.exports = { search };
