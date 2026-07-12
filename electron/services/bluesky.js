'use strict';

const { getJson } = require('./http');

/**
 * Bluesky post search via the public AppView API (no auth required).
 * https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts
 */

async function search(keywords, limit = 25) {
  // The public search endpoint takes a single query string.
  const query = keywords[0] || '';
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}&sort=latest`;
  const json = await getJson(url);
  const posts = json.posts || [];
  return posts.map((p) => {
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
  });
}

module.exports = { search };
