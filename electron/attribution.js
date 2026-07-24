'use strict';

/**
 * Spike attribution.
 *
 * A "+62% surge" alert that doesn't say why creates work instead of saving it.
 * Every feed item already carries a timestamp, so when the player count jumps we
 * can score what else happened in the same window and name the likely driver.
 *
 * Pure: no IO, no Electron, no network — unit-testable, and safe to call from
 * the alert engine without breaking its own purity contract.
 */

const DEFAULT_WINDOW_MS = 20 * 60 * 1000;

function inWindow(ts, at, windowMs) {
  return typeof ts === 'number' && Math.abs(at - ts) <= windowMs;
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function num(n) {
  return (n || 0).toLocaleString('en-US');
}

function attribute(event, snapshot, { windowMs = DEFAULT_WINDOW_MS, limit = 3 } = {}) {
  const s = snapshot || {};
  const at = (event && event.t) || Date.now();
  const direction = (event && event.direction) || 'up';
  const out = [];

  // A stream going live can drive a surge; it cannot drive a drop. A stream
  // *ending* is invisible to the API, so we don't pretend to have seen it.
  if (direction === 'up') {
    for (const st of (s.twitch && s.twitch.live) || []) {
      if (!inWindow(st.startedAt, at, windowMs)) continue;
      out.push({
        kind: 'twitch',
        score: st.viewers || 0,
        ts: st.startedAt,
        label: `${st.user} went live`,
        detail: `${num(st.viewers)} viewers · ${truncate(st.title, 60)}`,
        url: st.url || ''
      });
    }
  }

  for (const n of s.news || []) {
    if (!inWindow(n.date, at, windowMs)) continue;
    out.push({
      kind: 'news',
      score: 1000, // an official post is a strong prior either direction
      ts: n.date,
      label: `Steam post: ${truncate(n.title, 60)}`,
      detail: n.source || 'Steam',
      url: n.url || ''
    });
  }

  for (const r of s.reddit || []) {
    if (!inWindow(r.created, at, windowMs)) continue;
    out.push({
      kind: 'reddit',
      score: (r.score || 0) + (r.comments || 0) * 2,
      ts: r.created,
      label: `r/${r.subreddit || 'reddit'}: ${truncate(r.title, 60)}`,
      detail: `▲ ${num(r.score)} · 💬 ${num(r.comments)}`,
      url: r.url || ''
    });
  }

  const socials = [['bluesky', s.bluesky || []], ['x', (s.x && s.x.posts) || []]];
  for (const [kind, list] of socials) {
    for (const p of list) {
      if (!inWindow(p.created, at, windowMs)) continue;
      out.push({
        kind,
        score: (p.likes || 0) + (p.reposts || 0) * 2,
        ts: p.created,
        label: `${p.author || kind}: ${truncate(p.text, 60)}`,
        detail: `♥ ${num(p.likes)} · ↻ ${num(p.reposts)}`,
        url: p.url || ''
      });
    }
  }

  for (const v of (s.youtube && s.youtube.videos) || []) {
    if (!inWindow(v.published, at, windowMs)) continue;
    out.push({
      kind: 'youtube',
      score: 250,
      ts: v.published,
      label: `${v.channel}: ${truncate(v.title, 60)}`,
      detail: 'new video',
      url: v.url || ''
    });
  }

  for (const w of s.web || []) {
    if (!inWindow(w.date, at, windowMs)) continue;
    out.push({
      kind: 'web',
      score: 200,
      ts: w.date,
      label: truncate(w.title, 60),
      detail: w.source || 'web',
      url: w.url || ''
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** One-line summary for an alert body. Says so plainly when nothing lines up —
 *  a weak correlation presented as a cause is worse than no answer. */
function describeCauses(causes) {
  if (!causes || !causes.length) return 'No clear cause found in the same window.';
  const top = causes[0];
  const rest = causes.length > 1 ? ` (+${causes.length - 1} more)` : '';
  return `Likely: ${top.label} — ${top.detail}${rest}`;
}

module.exports = { attribute, describeCauses, DEFAULT_WINDOW_MS };
