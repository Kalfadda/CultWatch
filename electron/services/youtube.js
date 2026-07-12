'use strict';

const { getJson } = require('./http');

/**
 * YouTube Data API v3 search — recent videos mentioning the game. Requires a
 * free API key (console.cloud.google.com → enable "YouTube Data API v3").
 */

async function search({ apiKey, keywords }, maxResults = 12) {
  if (!apiKey) {
    return { enabled: false, reason: 'Add a YouTube Data API key in Settings', videos: [] };
  }
  // YouTube treats "|" as OR, so we search every name variant at once.
  const q = (keywords || []).map((k) => `"${k}"`).join('|') || '';
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date` +
    `&maxResults=${maxResults}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`;
  const json = await getJson(url);
  if (json.error) {
    throw new Error(json.error.message || 'YouTube API error');
  }
  const videos = (json.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      published: it.snippet.publishedAt ? new Date(it.snippet.publishedAt).getTime() : null,
      description: decodeEntities(it.snippet.description || '').slice(0, 160)
    }));
  return { enabled: true, videos };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

module.exports = { search };
