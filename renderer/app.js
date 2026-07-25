'use strict';

/* global cultwatch, initTrends, renderTrends, resizeTrendChart, renderTinybuild */

// ============================================================
// State
// ============================================================
let snapshot = null;
let config = null;
let currentView = 'live';
let feedFilter = 'all';
let mediaFilter = 'all';
let countdownTimer = null;
let alertLog = [];
let unreadAlerts = 0;
let soundMuted = false;
let audioCtx = null;
const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

// ============================================================
// Formatting helpers
// ============================================================
const nf = new Intl.NumberFormat('en-US');
function fmt(n) {
  return n == null ? '—' : nf.format(n);
}
function fmtCompact(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  return (n / 1e6).toFixed(1) + 'M';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  config = await cultwatch.getConfig();
  snapshot = await cultwatch.getSnapshot();
  if (snapshot) render(snapshot);
  else renderSkeleton();
  buildSettings();
  wireUi();
  initTrends();
  startCountdown();

  cultwatch.onDataUpdate((snap) => {
    snapshot = snap;
    setBusy(false);
    render(snap);
  });
  cultwatch.onPollStart(() => setBusy(true));
  cultwatch.onPollError((e) => { setBusy(false); toast(e.message || 'Refresh failed', true); });
  cultwatch.onAlerts((list) => handleAlerts(list));
  cultwatch.onUpdateStatus((s) => handleUpdateStatus(s));

  soundMuted = await cultwatch.getOsMute();
  updateMuteBtn();
  renderAlertList();
}

function setBusy(on) {
  const dot = el('liveDot');
  const ico = el('refreshIco');
  if (on) { dot.classList.add('busy'); ico.classList.add('spin'); }
  else { dot.classList.remove('busy'); ico.classList.remove('spin'); }
}

// ============================================================
// Top-level render
// ============================================================
function render(s) {
  el('gameName').textContent = (s.game && s.game.name) || s.config.gameName || 'Happy\'s Humble Burger Cult';
  el('lastUpdated').textContent = 'updated ' + timeOfDay(s.ts);
  el('liveDot').classList.remove('stale');

  renderKpis(s);
  renderChart(s);
  renderReviews(s);
  renderTwitch(s);
  renderCommunityFeed(s);
  renderMediaFeed(s);
  renderSourceStatus(s);
  renderFoot(s);
  updateCountdown();
  if (currentView === 'trends') renderTrends(s);
  if (currentView === 'tinybuild') renderTinybuild(s);
}

// ---- View switching (Live board stays exactly as it was) ----
function setView(v) {
  currentView = v;
  el('boardLive').classList.toggle('hidden', v !== 'live');
  el('boardTrends').classList.toggle('hidden', v !== 'trends');
  el('boardTinybuild').classList.toggle('hidden', v !== 'tinybuild');
  el('viewSwitch').querySelectorAll('.vs-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'trends' && snapshot) renderTrends(snapshot);
  if (v === 'tinybuild' && snapshot) renderTinybuild(snapshot);
}

function timeOfDay(ms) {
  const d = new Date(ms || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---- KPIs ----
function renderKpis(s) {
  const p = s.players || {};
  const r = s.reviews || {};
  const tw = s.twitch || {};
  const social = (s.reddit || []).length + ((s.bluesky || []).length) + ((s.x && s.x.posts) ? s.x.posts.length : 0);
  const history = p.history || [];
  const delta = playerDelta(history);

  const preLaunch = s.game && s.game.comingSoon;

  const cards = [
    {
      k: 'var(--accent)',
      label: 'Live Players',
      value: p.available ? fmt(p.current) : '—',
      dim: !p.available,
      sub: p.available
        ? deltaHtml(delta)
        : (preLaunch ? 'awaiting launch' : 'no live data')
    },
    {
      k: 'var(--cult)',
      label: 'Session Peak',
      value: p.peakSession != null ? fmt(p.peakSession) : '—',
      dim: p.peakSession == null,
      sub: history.length ? `${history.length} samples` : 'collecting…'
    },
    {
      k: 'var(--pos)',
      label: 'Review Score',
      value: r && r.positivePct != null ? r.positivePct + '%' : '—',
      dim: !(r && r.positivePct != null),
      sub: r && r.scoreDesc ? r.scoreDesc : 'no reviews yet'
    },
    {
      k: 'var(--info)',
      label: 'Total Reviews',
      value: r ? fmt(r.total) : '—',
      dim: !(r && r.total),
      sub: r && r.total ? `${fmt(r.positive)}👍 / ${fmt(r.negative)}👎` : 'launch day incoming'
    },
    {
      k: 'var(--twitch)',
      label: 'Twitch Viewers',
      value: tw.enabled ? fmt(tw.totalViewers || 0) : '—',
      dim: !tw.enabled || !(tw.totalViewers),
      sub: tw.enabled ? `${(tw.live || []).length} live channels` : 'add Twitch keys'
    },
    {
      k: 'var(--reddit)',
      label: 'Social Mentions',
      value: fmt(social),
      dim: social === 0,
      sub: 'reddit · bluesky · x'
    }
  ];

  el('kpis').innerHTML = cards.map((c) => `
    <div class="kpi ${c.dim ? 'dim' : ''}" style="--k:${c.k}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value ${String(c.value).length > 6 ? 'small' : ''}">${c.value}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join('');
}

function playerDelta(history) {
  if (!history || history.length < 2) return null;
  const last = history[history.length - 1].v;
  const prev = history[history.length - 2].v;
  if (last == null || prev == null) return null;
  return last - prev;
}
function deltaHtml(delta) {
  if (delta == null || delta === 0) return 'steady';
  const up = delta > 0;
  return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt(Math.abs(delta))}</span> since last check`;
}

// ---- Player chart (hand-rolled SVG) ----
function renderChart(s) {
  const wrap = el('playerChart');
  const history = (s.players && s.players.history) || [];
  const peak = s.players && s.players.peakSession;
  el('playersPeakChip').textContent = 'peak ' + (peak != null ? fmt(peak) : '—');

  if (history.length < 2) {
    wrap.innerHTML = `<div class="chart-empty">${
      s.game && s.game.comingSoon
        ? 'Player telemetry begins the moment the game goes live.<br>Chart fills in automatically on launch day.'
        : 'Collecting player samples… the line appears after a couple of refreshes.'
    }</div>`;
    return;
  }

  const W = Math.max(320, Math.round(wrap.clientWidth) || 900);
  const H = Math.max(180, Math.round(wrap.clientHeight) || 230);
  const padL = 46, padR = 14, padT = 16, padB = 26;
  const xs = history.map((p) => p.t);
  const ys = history.map((p) => p.v == null ? 0 : p.v);
  const minX = xs[0], maxX = xs[xs.length - 1];
  const maxY = Math.max(1, ...ys);
  const spanX = Math.max(1, maxX - minX);

  const X = (t) => padL + ((t - minX) / spanX) * (W - padL - padR);
  const Y = (v) => H - padB - (v / maxY) * (H - padT - padB);

  let path = '', area = '';
  history.forEach((p, i) => {
    const x = X(p.t), y = Y(p.v == null ? 0 : p.v);
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  });
  area = path + `L${X(maxX).toFixed(1)} ${H - padB} L${X(minX).toFixed(1)} ${H - padB} Z`;

  // Y gridlines
  const ticks = niceTicks(maxY, 4);
  let grid = '';
  ticks.forEach((t) => {
    const y = Y(t);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${y + 4}" class="ylab">${fmtCompact(t)}</text>`;
  });

  // X labels (start / mid / end)
  const xlabels = [minX, minX + spanX / 2, maxX].map((t) => {
    const d = new Date(t);
    return `<text x="${X(t)}" y="${H - 8}" class="xlab" text-anchor="middle">${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`;
  }).join('');

  const last = history[history.length - 1];
  const lastX = X(last.t), lastY = Y(last.v == null ? 0 : last.v);
  const peakPoint = peak != null ? history.find((p) => p.v === peak) : null;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff7a1a" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#ff7a1a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <style>
        .grid { stroke: rgba(255,255,255,0.05); stroke-width: 1; }
        .ylab { fill: #7d879c; font: 11px var(--mono, monospace); text-anchor: end; }
        .xlab { fill: #7d879c; font: 11px var(--mono, monospace); }
        .line { fill: none; stroke: #ff7a1a; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
      </style>
      ${grid}
      ${xlabels}
      <path d="${area}" fill="url(#areaGrad)"/>
      <path d="${path}" class="line"/>
      ${peakPoint ? `<circle cx="${X(peakPoint.t)}" cy="${Y(peakPoint.v)}" r="3.5" fill="#ff3b57"/>` : ''}
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="#ff7a1a"/>
      <circle cx="${lastX}" cy="${lastY}" r="8" fill="#ff7a1a" opacity="0.25"/>
    </svg>`;
}

function niceTicks(max, count) {
  const step = niceNum(max / count);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v));
  return out;
}
function niceNum(x) {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

// ---- Reviews ----
function renderReviews(s) {
  const r = s.reviews;
  const box = el('reviewScore');
  if (!r || !r.total) {
    box.innerHTML = `<div class="rs-none">
      <div style="font-size:34px;margin-bottom:8px">🕯️</div>
      <strong>No reviews yet</strong><br>
      ${s.game && s.game.comingSoon ? 'Reviews unlock at launch.<br>This board lights up the second the first one lands.' : 'Waiting for the first Steam review.'}
    </div>`;
    return;
  }
  const pct = r.positivePct;
  const color = pct >= 70 ? 'var(--pos)' : pct >= 40 ? 'var(--accent)' : 'var(--neg)';
  box.innerHTML = `
    <div class="rs-badge">
      ${ring(pct, color)}
      <div class="rs-meta">
        <div class="rs-desc" style="color:${color}">${esc(r.scoreDesc)}</div>
        <div class="rs-total">${fmt(r.total)} reviews</div>
      </div>
    </div>
    <div>
      <div class="rs-bar"><div class="pos" style="width:${pct}%"></div></div>
      <div class="rs-split" style="margin-top:8px">
        <span class="p">▲ ${fmt(r.positive)} positive</span>
        <span class="n">${fmt(r.negative)} negative ▼</span>
      </div>
    </div>`;
}

function ring(pct, color) {
  const R = 40, C = 2 * Math.PI * R;
  const off = C * (1 - pct / 100);
  return `<svg class="rs-ring" viewBox="0 0 92 92">
    <circle cx="46" cy="46" r="${R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8"/>
    <circle cx="46" cy="46" r="${R}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 46 46)"/>
    <text x="46" y="52" text-anchor="middle" fill="#e9edf6" style="font:700 22px var(--mono,monospace)">${pct}%</text>
  </svg>`;
}

// ---- Twitch ----
function renderTwitch(s) {
  const tw = s.twitch || {};
  const grid = el('twitchStreams');
  el('twitchCount').textContent = tw.enabled ? `(${(tw.live || []).length})` : '';
  el('twitchViewers').textContent = tw.enabled ? fmt(tw.totalViewers || 0) + ' viewers' : '';

  if (!tw.enabled) {
    grid.innerHTML = `<div class="empty-inline">Add your Twitch Client ID + Secret in ⚙ Settings to see who's streaming Happy's Humble Burger Cult live.</div>`;
    return;
  }
  if (!(tw.live || []).length) {
    grid.innerHTML = `<div class="empty-inline">${esc(tw.note || 'No one is streaming right now — this fills up fast on launch day.')}</div>`;
    return;
  }
  grid.innerHTML = tw.live.map((st) => `
    <div class="stream" data-url="${esc(st.url)}">
      <div class="thumb" style="background-image:url('${esc(st.thumbnail)}')">
        <div class="viewers">${fmt(st.viewers)}</div>
      </div>
      <div class="s-body">
        <div class="s-title">${esc(st.title || 'Untitled stream')}</div>
        <div class="s-user">${esc(st.user)}</div>
      </div>
    </div>`).join('');
}

// ---- Community feed (reddit + bluesky + x) ----
function renderCommunityFeed(s) {
  const items = [];
  (s.reddit || []).forEach((r) => items.push({
    src: 'reddit', srcColor: 'var(--reddit)', icon: '🟠', time: r.created,
    author: r.subreddit, title: r.title, text: r.selftext, url: r.url,
    meta: [`▲ ${fmt(r.score)}`, `💬 ${fmt(r.comments)}`, `u/${r.author}`]
  }));
  (s.bluesky || []).forEach((b) => items.push({
    src: 'bluesky', srcColor: 'var(--bsky)', icon: '🦋', time: b.created, avatar: b.avatar,
    author: b.author + ' · @' + b.handle, text: b.text, url: b.url,
    meta: [`♥ ${fmt(b.likes)}`, `↻ ${fmt(b.reposts)}`, `💬 ${fmt(b.replies)}`]
  }));
  const xp = (s.x && s.x.posts) || [];
  xp.forEach((t) => items.push({
    src: 'x', srcColor: 'var(--x)', icon: '𝕏', time: t.created, avatar: t.avatar,
    author: t.author + ' · @' + t.handle, text: t.text, url: t.url,
    meta: [`♥ ${fmt(t.likes)}`, `↻ ${fmt(t.reposts)}`]
  }));

  const filtered = feedFilter === 'all' ? items : items.filter((i) => i.src === feedFilter);
  filtered.sort((a, b) => (b.time || 0) - (a.time || 0));
  renderFeedInto('communityFeed', filtered, communityEmpty(s));
}

function communityEmpty(s) {
  const x = s.x || {};
  const st = s.status || {};
  const notes = [];
  if (st.reddit && st.reddit.status === 'error') notes.push('Reddit needs a free Client ID (Settings)');
  if (!x.enabled && s.config.sources.x) notes.push('X needs a Bearer token (Settings)');
  return 'No community posts matched yet.<br>New mentions appear here in real time.' +
    (notes.length ? `<br><span style="color:var(--muted-2);font-size:11px">${notes.join(' · ')}</span>` : '');
}

// ---- Media feed (news + youtube + reviews) ----
function renderMediaFeed(s) {
  const items = [];
  (s.web || []).forEach((w) => items.push({
    src: 'web', srcColor: 'var(--web)', icon: '🌐', time: w.date,
    author: w.source, title: w.title, text: '', url: w.url, meta: []
  }));
  (s.news || []).forEach((n) => items.push({
    src: 'news', srcColor: 'var(--accent)', icon: '📰', time: n.date,
    author: n.author, title: n.title, text: n.summary, url: n.url, meta: [n.source]
  }));
  const yt = (s.youtube && s.youtube.videos) || [];
  yt.forEach((v) => items.push({
    src: 'youtube', srcColor: 'var(--yt)', icon: '▶', time: v.published, thumb: v.thumbnail,
    author: v.channel, title: v.title, text: v.description, url: v.url, meta: []
  }));
  (s.reviews && s.reviews.recent || []).forEach((rv) => items.push({
    src: 'reviews', srcColor: rv.votedUp ? 'var(--pos)' : 'var(--neg)',
    icon: rv.votedUp ? '👍' : '👎', time: rv.timestamp,
    author: 'Steam user ' + rv.author, text: rv.text, votedUp: rv.votedUp,
    url: `https://store.steampowered.com/app/${s.config.appId}/`,
    meta: [rv.hoursPlayed != null ? `${rv.hoursPlayed}h played` : null, `${fmt(rv.votesUp)} found helpful`].filter(Boolean)
  }));

  const filtered = mediaFilter === 'all' ? items : items.filter((i) => i.src === mediaFilter);
  filtered.sort((a, b) => (b.time || 0) - (a.time || 0));
  renderFeedInto('mediaFeed', filtered, 'No news, videos, or reviews yet.<br>Web news &amp; Steam announcements show here without any setup.');
}

function renderFeedInto(id, items, emptyHtml) {
  const box = el(id);
  if (!items.length) { box.innerHTML = `<div class="feed-empty">${emptyHtml}</div>`; return; }
  box.innerHTML = items.slice(0, 60).map((i) => {
    const media = i.thumb
      ? `<img class="fi-thumb" src="${esc(i.thumb)}" loading="lazy"/>`
      : i.avatar
        ? `<img class="fi-avatar" src="${esc(i.avatar)}" loading="lazy" data-fallback="${esc(i.icon)}"/>`
        : `<div class="fi-icon" style="color:${i.srcColor}">${i.icon}</div>`;
    const reviewTag = i.src === 'reviews'
      ? `<span class="review-tag ${i.votedUp ? 'up' : 'down'}">${i.votedUp ? 'RECOMMENDED' : 'NOT REC.'}</span>` : '';
    return `<div class="feed-item" data-url="${esc(i.url)}">
      ${media}
      <div class="fi-body">
        <div class="fi-top">
          <span class="fi-src" style="color:${i.srcColor};background:${i.srcColor}22">${esc(i.src)}</span>
          ${reviewTag}
          <span class="fi-author">${esc(i.author || '')}</span>
          <span class="fi-time">${ago(i.time)}</span>
        </div>
        ${i.title ? `<div class="fi-title">${esc(i.title)}</div>` : ''}
        ${i.text ? `<div class="fi-text">${esc(i.text)}</div>` : ''}
        ${i.meta && i.meta.length ? `<div class="fi-meta">${i.meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// CSP-safe image fallbacks: hide broken thumbnails, swap broken avatars for an icon.
function installImageFallbacks() {
  document.body.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('fi-avatar') && img.dataset.fallback) {
      const d = document.createElement('div');
      d.className = 'fi-icon';
      d.textContent = img.dataset.fallback;
      img.replaceWith(d);
    } else {
      img.style.display = 'none';
    }
  }, true); // capture — image error events don't bubble
}

// ---- Source status dots ----
function renderSourceStatus(s) {
  const map = s.status || {};
  const order = [['players', 'Steam players'], ['reviews', 'Reviews'], ['news', 'Steam news'],
    ['web', 'Web / News'], ['reddit', 'Reddit'], ['bluesky', 'Bluesky'], ['twitch', 'Twitch'],
    ['youtube', 'YouTube'], ['x', 'X']];
  el('sourceStatus').innerHTML = order.map(([k, name]) => {
    const st = map[k] || { status: 'off' };
    const title = `${name}: ${st.status}${st.error ? ' — ' + st.error : ''}${st.ms ? ` (${st.ms}ms)` : ''}`;
    return `<span class="s ${st.status}" title="${esc(title)}"></span>`;
  }).join('');
}

function renderFoot(s) {
  const errs = Object.entries(s.status || {}).filter(([, v]) => v.status === 'error');
  el('footStatus').textContent = errs.length
    ? `${errs.length} source(s) erroring: ` + errs.map(([k]) => k).join(', ')
    : 'all sources nominal';
}

function renderSkeleton() {
  el('kpis').innerHTML = Array.from({ length: 6 }).map(() =>
    `<div class="kpi dim"><div class="kpi-label">—</div><div class="kpi-value">…</div><div class="kpi-sub">loading</div></div>`).join('');
}

// ============================================================
// Countdown
// ============================================================
function startCountdown() {
  updateCountdown();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 1000);
}
function updateCountdown() {
  const box = el('launchStatus');
  const out = el('countdown');
  const iso = (config && config.launchDate) || (snapshot && snapshot.config.launchDate);
  if (!iso) { out.textContent = '—'; return; }
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diff = target - now;
  if (diff <= 0) {
    box.classList.add('live');
    const up = now - target;
    const d = Math.floor(up / 86400000);
    out.innerHTML = `🔴 LIVE${d > 0 ? ` · day ${d + 1}` : ''}`;
    return;
  }
  box.classList.remove('live');
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const sec = Math.floor((diff % 60000) / 1000);
  out.textContent = d > 0 ? `T–${d}d ${h}h ${m}m` : `T–${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ============================================================
// Settings drawer
// ============================================================
const SETTINGS_SCHEMA = [
  { group: 'Target Game', fields: [
    { key: 'appId', label: 'Steam App ID', type: 'text', hint: 'The number in your store URL: store.steampowered.com/app/<b>APPID</b>/' },
    { key: 'gameName', label: 'Game name (display)', type: 'text' },
    { key: 'launchDate', label: 'Launch date/time (ISO or YYYY-MM-DD)', type: 'text', hint: 'Drives the countdown. Example: 2026-07-16T17:00:00Z' },
    { key: 'refreshIntervalSec', label: 'Refresh interval (seconds)', type: 'number', hint: 'Minimum 15s. Steam endpoints are generous but be kind.' }
  ]},
  { group: 'Discovery keywords', fields: [
    { key: 'keywords', label: 'Search keywords (comma-separated)', type: 'list', hint: 'Used for Reddit, Bluesky, X and YouTube search.' },
    { key: 'twitchGameName', label: 'Twitch category / game name', type: 'text', hint: 'Must exactly match the Twitch category once it exists.' }
  ]},
  { group: 'Steam (optional key)', fields: [
    { key: 'steamApiKey', label: 'Steam Web API key', type: 'password', hint: 'Optional — core Steam data works without it. Get one at <a href="https://steamcommunity.com/dev/apikey">steamcommunity.com/dev/apikey</a>' }
  ]},
  { group: 'Reddit', fields: [
    { key: 'redditClientId', label: 'Reddit Client ID', type: 'text', hint: 'Reddit now requires auth. Create a free app at <a href="https://www.reddit.com/prefs/apps">reddit.com/prefs/apps</a> — pick type <b>installed app</b>, set redirect URI to http://localhost, then paste the ID shown under the app name. Client ID alone is enough.' },
    { key: 'redditClientSecret', label: 'Reddit Client Secret (only for "web app" type)', type: 'password', hint: 'Leave blank for an "installed app". Only needed if you registered a "web app".' }
  ]},
  { group: 'Twitch', fields: [
    { key: 'twitchClientId', label: 'Twitch Client ID', type: 'text', hint: 'Create an app at <a href="https://dev.twitch.tv/console/apps">dev.twitch.tv/console/apps</a>' },
    { key: 'twitchClientSecret', label: 'Twitch Client Secret', type: 'password' }
  ]},
  { group: 'YouTube', fields: [
    { key: 'youtubeApiKey', label: 'YouTube Data API v3 key', type: 'password', hint: 'Enable "YouTube Data API v3" in Google Cloud Console.' }
  ]},
  { group: 'X / Twitter (optional)', fields: [
    { key: 'xBearerToken', label: 'X API Bearer token', type: 'password', hint: 'Requires a paid X API tier. Bluesky covers free social.' }
  ]},
  { group: 'Peer benchmark', fields: [
    { key: 'peers', label: 'Peer games — one "appId: Name" per line', type: 'lines',
      hint: 'Keyless: uses the same public player-count endpoint as your own game. A title that reports no live players shows as "no data" rather than an error.' }
  ]},
  { group: 'Publisher cohort', fields: [
    { key: 'tinybuild.cohort', label: 'Cohort games — one "appId: Name" per line', type: 'lines',
      hint: 'Titles from your publisher released recently. Hand-maintained: anything released longer ago than the window below is flagged ⚠ rather than dropped, so a stale list stays visible instead of quietly skewing the ranking.' },
    { key: 'tinybuild.label', label: 'Publisher name', type: 'text' },
    { key: 'tinybuild.windowDays', label: 'Window (days)', type: 'days' }
  ]},
  { group: 'Complaint taxonomy', fields: [
    { key: 'reviewTaxonomy', label: 'Themes — one "Label: keyword, keyword" per line', type: 'textarea',
      hint: 'Clusters negative reviews. Leave blank for the built-in set. Keywords match literally (English reviews only).' }
  ]}
];

/** Reads "a.b.c" out of a config object. Settings keys are mostly flat, but the
 *  publisher cohort is nested, and flattening it in the store would just move the
 *  problem into the poller. */
function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Writes "a.b.c" into a patch, creating intermediate objects. The store deep-
 *  merges, so a partial nested patch leaves its siblings alone. */
function setPath(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

function buildSettings() {
  const body = el('settingsBody');
  let html = '';

  // Source toggles
  html += `<div class="set-group"><h3>Active Sources</h3><div class="toggles" id="sourceToggles"></div></div>`;

  SETTINGS_SCHEMA.forEach((g) => {
    html += `<div class="set-group"><h3>${esc(g.group)}</h3>`;
    g.fields.forEach((f) => {
      let val = config ? getPath(config, f.key) : '';
      if (f.type === 'list') val = Array.isArray(val) ? val.join(', ') : (val || '');
      if (f.type === 'lines') {
        val = Array.isArray(val) ? val.map((p) => `${p.appId}: ${p.name || ''}`).join('\n') : '';
      }
      if (f.type === 'textarea') val = val || '';

      const control = (f.type === 'textarea' || f.type === 'lines')
        ? `<textarea data-key="${f.key}" data-kind="${f.type}" rows="6"
             placeholder="${esc(f.key === 'reviewTaxonomy' && config ? (config.defaultTaxonomyText || '') : '')}">${esc(val)}</textarea>`
        : `<input type="${f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}"
             data-key="${f.key}" data-kind="${f.type}" value="${esc(val)}" ${f.type === 'password' ? 'autocomplete="off"' : ''}/>`;

      html += `<div class="field">
        <label>${esc(f.label)}</label>
        ${control}
        ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  });

  // Launch alerts
  const a = (config && config.alerts) || {};
  const alertToggles = [
    ['enabled', 'Master switch'], ['onLaunch', 'Game goes live'], ['milestones', 'Player milestones'],
    ['newPeak', 'New peak'], ['spikes', 'Spikes / drops'], ['reviews', 'New reviews'],
    ['reviewsOnlyNegative', 'Only negative reviews'], ['scoreBandChange', 'Rating band change'],
    ['bigStreams', 'Big Twitch streams']
  ];
  html += `<div class="set-group"><h3>Launch Alerts</h3><div class="toggles" id="alertToggles">` +
    alertToggles.map(([k, label]) => {
      const on = a[k];
      return `<label class="toggle ${on ? 'on' : ''}"><input type="checkbox" data-alert="${k}" ${on ? 'checked' : ''}/> ${esc(label)}</label>`;
    }).join('') + `</div>`;
  const alertNums = [
    ['spikePct', 'Spike threshold (% change)'],
    ['spikeMinPlayers', 'Ignore spikes below N players'],
    ['bigStreamViewers', 'Big-stream viewer threshold']
  ];
  alertNums.forEach(([k, label]) => {
    html += `<div class="field"><label>${esc(label)}</label>
      <input type="number" data-alertnum="${k}" value="${esc(a[k] != null ? a[k] : '')}"/></div>`;
  });
  html += `</div>`;

  body.innerHTML = html;

  const srcNames = { steam: 'Steam', reddit: 'Reddit', bluesky: 'Bluesky', news: 'Steam News', web: 'Web / News', twitch: 'Twitch', youtube: 'YouTube', x: 'X' };
  el('sourceToggles').innerHTML = Object.entries(srcNames).map(([k, name]) => {
    const on = config && config.sources && config.sources[k];
    return `<label class="toggle ${on ? 'on' : ''}"><input type="checkbox" data-src="${k}" ${on ? 'checked' : ''}/> ${name}</label>`;
  }).join('');
  body.querySelectorAll('.toggles input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => cb.closest('.toggle').classList.toggle('on', cb.checked));
  });
}

async function saveSettings() {
  const patch = { sources: {} };
  el('settingsBody').querySelectorAll('input[data-key], textarea[data-key]').forEach((inp) => {
    const key = inp.dataset.key, kind = inp.dataset.kind;
    let v = inp.value.trim();
    if (kind === 'number') {
      v = Math.max(15, parseInt(v, 10) || 60);
    } else if (kind === 'days') {
      // A window, not a poll interval — it has its own floor and default.
      v = Math.max(1, parseInt(v, 10) || 365);
    } else if (kind === 'list') {
      v = v.split(',').map((x) => x.trim()).filter(Boolean);
    } else if (kind === 'lines') {
      v = v.split('\n').map((line) => {
        const i = line.indexOf(':');
        if (i < 0) return null;
        const appId = line.slice(0, i).trim();
        const name = line.slice(i + 1).trim();
        return appId ? { appId, name: name || `App ${appId}` } : null;
      }).filter(Boolean);
    } else if (kind === 'textarea') {
      v = v || null; // blank means "use the built-in set"
    }
    setPath(patch, key, v);
  });
  el('sourceToggles').querySelectorAll('input[data-src]').forEach((cb) => {
    patch.sources[cb.dataset.src] = cb.checked;
  });
  patch.alerts = {};
  document.querySelectorAll('input[data-alert]').forEach((cb) => {
    patch.alerts[cb.dataset.alert] = cb.checked;
  });
  document.querySelectorAll('input[data-alertnum]').forEach((inp) => {
    const v = parseInt(inp.value, 10);
    if (!Number.isNaN(v)) patch.alerts[inp.dataset.alertnum] = Math.max(0, v);
  });
  el('saveHint').textContent = 'saving…';
  config = await cultwatch.updateConfig(patch);
  el('saveHint').textContent = 'saved ✓';
  toast('Settings saved — refreshing sources');
  setTimeout(() => { el('saveHint').textContent = ''; closeDrawer(); }, 700);
}

function openDrawer() { buildSettings(); el('settingsDrawer').classList.add('open'); el('drawerScrim').classList.add('open'); }
function closeDrawer() { el('settingsDrawer').classList.remove('open'); el('drawerScrim').classList.remove('open'); }

// ============================================================
// UI wiring
// ============================================================
function wireUi() {
  installImageFallbacks();
  el('refreshBtn').addEventListener('click', () => { setBusy(true); cultwatch.refreshNow(); });
  el('settingsBtn').addEventListener('click', openDrawer);
  el('closeSettings').addEventListener('click', closeDrawer);
  el('drawerScrim').addEventListener('click', closeDrawer);
  el('saveSettings').addEventListener('click', saveSettings);
  el('clearHistBtn').addEventListener('click', async () => {
    if (confirm(
      'Clear ALL stored player history?\n\n' +
      'This deletes the rolling chart, the permanent day-by-day rollups and the ' +
      'event timeline. Steam publishes no historical player data, so none of it ' +
      'can be recovered.\n\nStored reviews are kept.'
    )) {
      await cultwatch.clearHistory();
      toast('History cleared');
    }
  });

  document.body.addEventListener('click', (e) => {
    const item = e.target.closest('[data-url]');
    if (item && item.dataset.url) cultwatch.openExternal(item.dataset.url);
  });

  // Alert center
  el('bellBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAlertCenter(); });
  el('alertCenter').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleAlertCenter(false));
  el('alertList').addEventListener('click', (e) => {
    const it = e.target.closest('[data-alert]');
    if (!it) return;
    const a = alertLog[Number(it.dataset.alert)];
    if (a && a.url) cultwatch.openExternal(a.url);
  });
  el('muteBtn').addEventListener('click', async () => {
    soundMuted = !soundMuted;
    await cultwatch.setOsMute(soundMuted);
    updateMuteBtn();
    toast(soundMuted ? 'Notifications muted' : 'Notifications on');
  });
  el('testAlertBtn').addEventListener('click', () => cultwatch.testAlert());
  el('clearAlertsBtn').addEventListener('click', () => { alertLog = []; unreadAlerts = 0; updateBadge(); renderAlertList(); });

  // Auto-update
  el('updatePill').addEventListener('click', () => {
    if (el('updatePill').classList.contains('downloading')) return;
    cultwatch.installUpdate();
  });
  el('checkUpdatesBtn').addEventListener('click', async () => {
    manualUpdateCheck = true;
    const r = await cultwatch.checkUpdates();
    if (!r.ok) { manualUpdateCheck = false; toast(r.error || 'Update check unavailable', true); }
  });

  el('viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.vs-btn');
    if (b) setView(b.dataset.view);
  });

  el('feedTabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    el('feedTabs').querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); feedFilter = t.dataset.feed;
    if (snapshot) renderCommunityFeed(snapshot);
  });
  el('mediaTabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    el('mediaTabs').querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); mediaFilter = t.dataset.feed;
    if (snapshot) renderMediaFeed(snapshot);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!snapshot) return;
      renderChart(snapshot);
      resizeTrendChart();
    }, 150);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); setBusy(true); cultwatch.refreshNow(); }
    if (e.key === 'Escape') closeDrawer();
    if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openDrawer(); }
  });

  // Mark data stale if no update for a while
  setInterval(() => {
    if (snapshot && Date.now() - snapshot.ts > (config.refreshIntervalSec || 60) * 1000 * 2.5) {
      el('liveDot').classList.add('stale');
    }
    // refresh relative timestamps in feeds
    document.querySelectorAll('.fi-time').forEach(() => {});
  }, 5000);
}

// ============================================================
// Alert center
// ============================================================
const ALERT_ICONS = {
  launch: '🚀', milestone: '🎉', peak: '📈', 'spike-up': '⚡', 'spike-down': '🔻',
  'review-pos': '👍', 'review-neg': '👎', 'first-review': '⭐', 'score-band': '📊',
  'big-stream': '📺', test: '🔔'
};

function handleAlerts(list) {
  if (!Array.isArray(list) || !list.length) return;
  const centerOpen = !el('alertCenter').classList.contains('hidden');
  for (const a of list) {
    alertLog.unshift({ ...a, read: centerOpen });
    if (!centerOpen) unreadAlerts++;
  }
  if (alertLog.length > 100) alertLog = alertLog.slice(0, 100);

  updateBadge();
  renderAlertList();

  // Bell shake + toast + sound for the newest alert.
  const bell = el('bellBtn');
  bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring');
  const top = list[0];
  toast(`${ALERT_ICONS[top.type] || '🔔'} ${top.title}`, top.urgency === 'critical');
  if (!soundMuted) playChime(list.some((a) => a.urgency === 'critical'));
}

function updateBadge() {
  const b = el('alertBadge');
  if (unreadAlerts > 0) { b.textContent = unreadAlerts > 99 ? '99+' : unreadAlerts; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderAlertList() {
  const box = el('alertList');
  if (!alertLog.length) {
    box.innerHTML = `<div class="ac-empty">No alerts yet.<br>Launch-day events — milestones, spikes, reviews and big streams — show up here and as desktop notifications.</div>`;
    return;
  }
  box.innerHTML = alertLog.map((a, i) => `
    <div class="ac-item ${a.read ? '' : 'unread'} ${a.urgency === 'critical' ? 'crit' : ''}" data-alert="${i}">
      <div class="ac-ico">${ALERT_ICONS[a.type] || '🔔'}</div>
      <div class="ac-body">
        <div class="ac-title">${esc(a.title)}</div>
        <div class="ac-text">${esc(a.body)}</div>
        <div class="ac-time">${new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${ago(a.ts)} ago</div>
      </div>
    </div>`).join('');
}

function toggleAlertCenter(force) {
  const c = el('alertCenter');
  const show = force != null ? force : c.classList.contains('hidden');
  c.classList.toggle('hidden', !show);
  if (show) {
    unreadAlerts = 0;
    alertLog.forEach((a) => { a.read = true; });
    updateBadge();
    renderAlertList();
  }
}

function updateMuteBtn() {
  const btn = el('muteBtn');
  if (btn) btn.textContent = soundMuted ? '🔇 muted' : '🔊 on';
}

// Short synthesized chime — no external audio asset (CSP-safe).
function playChime(critical) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = critical ? [880, 660, 880] : [660, 880];
    let t = audioCtx.currentTime;
    for (const f of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.18);
      t += 0.14;
    }
  } catch { /* audio not available */ }
}

// ============================================================
// Auto-update UI
// ============================================================
let manualUpdateCheck = false;
function handleUpdateStatus(s) {
  const pill = el('updatePill');
  const text = el('updatePillText');
  switch (s.state) {
    case 'checking':
      if (manualUpdateCheck) toast('Checking for updates…');
      break;
    case 'available':
      toast(`⬇ Update ${s.info && s.info.version ? 'v' + s.info.version : ''} available — downloading…`);
      pill.classList.remove('hidden', 'downloading');
      text.textContent = 'Downloading update…';
      pill.classList.add('downloading');
      break;
    case 'downloading':
      pill.classList.remove('hidden');
      pill.classList.add('downloading');
      text.textContent = `Downloading… ${s.info ? s.info.percent : 0}%`;
      break;
    case 'downloaded': {
      // The desktop updater has already downloaded the update, so the action is
      // "Restart". Android only ever *offers* the APK, so it supplies its own
      // label — promising a restart there would be a lie.
      const action = (s.info && s.info.actionLabel) || 'Restart';
      const ver = s.info && s.info.version ? ' v' + s.info.version : '';
      pill.classList.remove('hidden', 'downloading');
      text.textContent = `Update ready${ver} — ${action}`;
      toast(`✅ Update ${ver.trim() || 'available'} — click "Update ready" to ${action.toLowerCase()}`);
      handleAlerts([{ type: 'test', title: '⬇ Update ready', body: `A new version of CultWatch${ver ? ' (' + ver.trim() + ')' : ''} is ready — ${action.toLowerCase()} to install.`, urgency: 'normal', url: '', ts: Date.now() }]);
      break;
    }
    case 'none':
      if (manualUpdateCheck) toast('You are on the latest version ✓');
      break;
    case 'error':
      if (manualUpdateCheck) toast(`Update check failed: ${s.info ? s.info.message : 'unknown'}`, true);
      break;
    default:
      break;
  }
  if (s.state === 'none' || s.state === 'error') manualUpdateCheck = false;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

boot();
