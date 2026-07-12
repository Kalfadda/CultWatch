'use strict';

const { getJson } = require('./http');

/**
 * Reddit mentions via the public search JSON endpoint (no key required — just
 * a real User-Agent, which http.js provides). Returns newest-first posts that
 * match any of the configured keywords.
 */

async function search(keywords, limit = 25) {
  const query = keywords.map((k) => `"${k}"`).join(' OR ');
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=${limit}&type=link`;
  const json = await getJson(url);
  const children = (json.data && json.data.children) || [];
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

module.exports = { search };
