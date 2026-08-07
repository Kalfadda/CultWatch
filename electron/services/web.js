'use strict';

const { getText } = require('./http');

/**
 * Web mentions via Google News RSS — a keyless, whole-web sweep for press,
 * blog, and news coverage of the game (any of the configured keywords, old and
 * new names alike). Returns newest-first articles.
 *
 *   https://news.google.com/rss/search?q=<query>
 */

async function search(keywords, limit = 20) {
  const query = (keywords || []).map((k) => `"${k}"`).join(' OR ');
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await getText(url, {
    headers: { Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }
  });
  return parseRss(xml).slice(0, limit);
}

function parseRss(xml) {
  const out = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const raw of items) {
    const block = raw.split(/<\/item>/i)[0];
    const source = decode(pick(block, 'source')) || 'Web';
    let title = decode(pick(block, 'title'));
    // Google News titles are "Headline - Source"; drop the trailing source.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = decode(pick(block, 'link'));
    const pub = pick(block, 'pubDate');
    out.push({
      id: decode(pick(block, 'guid')) || link,
      title: title || '(untitled)',
      source,
      url: link,
      date: pub ? new Date(pub).getTime() : null
    });
  }
  return out;
}

function pick(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { search };
