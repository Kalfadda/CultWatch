'use strict';

/* global cultwatch, fmt, fmtCompact, esc, el */

/**
 * Trends view — the week-two half of the board.
 *
 * Live answers "what is happening right now"; this answers "how does now
 * compare to before". It leans on formatting helpers defined in app.js (same
 * global scope, loaded after this file) and never computes analysis itself —
 * the main process ships finished numbers.
 */

let trendRange = '24h';
let trendSeries = null;      // cached {tier, points, segments} for the range
let trendSeriesRange = null; // which range trendSeries belongs to

const EVENT_MARKS = {
  launch: { glyph: '🚀', color: 'var(--cult)' },
  milestone: { glyph: '🎉', color: 'var(--accent)' },
  peak: { glyph: '📈', color: 'var(--pos)' },
  'spike-up': { glyph: '⚡', color: 'var(--accent)' },
  'spike-down': { glyph: '🔻', color: 'var(--neg)' },
  'complaint-surge': { glyph: '⚠️', color: 'var(--neg)' },
  news: { glyph: '📰', color: 'var(--info)' }
};

function initTrends() {
  const range = el('trendRange');
  if (!range) return;
  range.addEventListener('click', async (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    range.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    trendRange = t.dataset.range;
    trendSeries = null;
    await loadSeries();
    if (window.__snapshot) renderTrendChart(window.__snapshot);
  });
}

async function loadSeries() {
  try {
    trendSeries = await cultwatch.getSeries(trendRange);
    trendSeriesRange = trendRange;
  } catch {
    trendSeries = null;
  }
}

async function renderTrends(s) {
  window.__snapshot = s;
  if (!trendSeries || trendSeriesRange !== trendRange) await loadSeries();
  renderTrendKpis(s);
  renderTrendChart(s);
  renderDayBars(s);
  renderComplaints(s);
  renderVelocity(s);
  renderPeers(s);
  renderTrendFoot(s);
}

// ============================================================
// KPI row
// ============================================================
function renderTrendKpis(s) {
  const r = (s.trends && s.trends.retention) || null;
  const ri = s.reviewIntel || {};
  const vel = ri.velocity || {};
  const roll = ri.rolling || {};
  const peers = s.peers || {};

  const cards = [
    {
      k: 'var(--accent)',
      label: 'Retention',
      value: r && r.pct != null ? r.pct + '%' : '—',
      dim: !r,
      // referenceLabel is used verbatim: it says "best known peak (day N)"
      // whenever launch day is missing, which for this install it is.
      sub: r ? `of ${esc(r.referenceLabel)} (${fmt(r.referencePeak)})` : 'no daily data yet'
    },
    {
      k: 'var(--cult)',
      label: 'Days tracked',
      value: r ? String(r.daysTracked) : '—',
      dim: !r,
      sub: r && r.referenceIsLaunch ? 'launch day included' : 'launch day not recorded'
    },
    {
      k: 'var(--pos)',
      label: 'Review velocity',
      value: vel.perHour24 != null ? vel.perHour24 + '/hr' : '—',
      dim: !vel.count24,
      sub: vel.trendPct != null
        ? `${deltaArrow(vel.trendPct)} vs previous 24h`
        : `${fmt(vel.count24 || 0)} in the last 24h`
    },
    {
      k: 'var(--info)',
      label: 'Peer rank',
      value: peers.ourRank ? `#${peers.ourRank}` : '—',
      dim: !peers.ourRank,
      sub: peers.rows && peers.rows.length ? `of ${peers.rows.length} tracked` : 'no peer data'
    },
    {
      k: roll.delta != null && roll.delta < 0 ? 'var(--neg)' : 'var(--pos)',
      label: '7-day sentiment',
      value: roll.pct7d != null ? roll.pct7d + '%' : '—',
      dim: roll.pct7d == null,
      sub: roll.delta != null
        ? `${deltaArrow(roll.delta, 'pt')} vs all-time ${roll.pctAll}%`
        : 'positive, last 7 days'
    },
    {
      k: 'var(--neg)',
      label: 'Top complaint',
      value: (ri.themes && ri.themes[0]) ? String(ri.themes[0].count) : '—',
      dim: !(ri.themes && ri.themes.length),
      sub: (ri.themes && ri.themes[0]) ? esc(ri.themes[0].label) : 'nothing clustered yet'
    }
  ];

  el('trendKpis').innerHTML = cards.map((c) => `
    <div class="kpi ${c.dim ? 'dim' : ''}" style="--k:${c.k}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value ${String(c.value).length > 6 ? 'small' : ''}">${esc(c.value)}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join('');
}

function deltaArrow(n, unit) {
  const u = unit || '%';
  if (n === 0) return `steady`;
  const up = n > 0;
  return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(n)}${u}</span>`;
}

// ============================================================
// Range chart — one path per segment, so gaps stay gaps
// ============================================================
function renderTrendChart(s) {
  const wrap = el('trendChart');
  const data = trendSeries;
  el('trendTierChip').textContent = data ? `${data.tier} · ${fmt(data.points.length)} pts` : '';

  if (!data || data.points.length < 2) {
    wrap.innerHTML = `<div class="chart-empty">Not enough samples in this range yet.<br>
      CultWatch only records while it is open.</div>`;
    return;
  }

  const W = Math.max(320, Math.round(wrap.clientWidth) || 900);
  const H = Math.max(200, Math.round(wrap.clientHeight) || 240);
  const padL = 50, padR = 16, padT = 18, padB = 28;
  const pts = data.points;
  const minX = pts[0].t, maxX = pts[pts.length - 1].t;
  const spanX = Math.max(1, maxX - minX);
  const maxY = Math.max(1, ...pts.map((p) => p.v || 0));

  const X = (t) => padL + ((t - minX) / spanX) * (W - padL - padR);
  const Y = (v) => H - padB - ((v || 0) / maxY) * (H - padT - padB);

  // One path per segment — a straight line across a 30-hour hole is a lie.
  const paths = (data.segments || [pts]).filter((seg) => seg.length > 0).map((seg) => {
    if (seg.length === 1) {
      return `<circle cx="${X(seg[0].t).toFixed(1)}" cy="${Y(seg[0].v).toFixed(1)}" r="2" fill="#ff7a1a"/>`;
    }
    const d = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
    const area = `${d} L${X(seg[seg.length - 1].t).toFixed(1)} ${H - padB} L${X(seg[0].t).toFixed(1)} ${H - padB} Z`;
    return `<path d="${area}" fill="url(#trendGrad)"/><path d="${d}" class="line"/>`;
  }).join('');

  const ticks = niceTrendTicks(maxY, 4);
  const grid = ticks.map((t) => {
    const y = Y(t);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="grid"/>` +
      `<text x="${padL - 8}" y="${y + 4}" class="ylab">${fmtCompact(t)}</text>`;
  }).join('');

  const fmtX = (t) => {
    const d = new Date(t);
    return spanX > 2 * 86400000
      ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const xlabels = [minX, minX + spanX / 2, maxX].map((t) =>
    `<text x="${X(t)}" y="${H - 8}" class="xlab" text-anchor="middle">${fmtX(t)}</text>`).join('');

  // Event markers — the curve annotates itself.
  const marks = (s.events || [])
    .filter((e) => e.t >= minX && e.t <= maxX && EVENT_MARKS[e.type])
    .slice(-40)
    .map((e) => {
      const m = EVENT_MARKS[e.type];
      const x = X(e.t).toFixed(1);
      return `<g class="evmark"><line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="${m.color}" stroke-opacity="0.28" stroke-dasharray="3 3"/>` +
        `<text x="${x}" y="${padT - 4}" text-anchor="middle" font-size="10">${m.glyph}<title>${esc(e.title)}</title></text></g>`;
    }).join('');

  const gapCount = Math.max(0, (data.segments || []).length - 1);

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff7a1a" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#ff7a1a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <style>
        .grid { stroke: rgba(255,255,255,0.05); stroke-width: 1; }
        .ylab { fill: #7d879c; font: 11px var(--mono, monospace); text-anchor: end; }
        .xlab { fill: #7d879c; font: 11px var(--mono, monospace); }
        .line { fill: none; stroke: #ff7a1a; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
      </style>
      ${grid}${xlabels}${paths}${marks}
    </svg>
    ${gapCount ? `<div class="gap-note">${gapCount} gap${gapCount > 1 ? 's' : ''} — app was closed</div>` : ''}`;
}

function niceTrendTicks(max, count) {
  const raw = max / count;
  const exp = Math.floor(Math.log10(raw || 1));
  const f = raw / Math.pow(10, exp);
  const nice = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * Math.pow(10, exp);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += nice) out.push(Math.round(v));
  return out;
}

// ============================================================
// Peak by day
// ============================================================
function renderDayBars(s) {
  const box = el('dayBars');
  const days = (s.trends && s.trends.days) || [];
  const r = (s.trends && s.trends.retention) || null;

  el('retentionChip').textContent = r && r.pct != null
    ? `${r.pct}% of ${r.referenceLabel}`
    : 'no reference yet';

  if (!days.length) {
    box.innerHTML = `<div class="feed-empty">No daily rollups yet.<br>The first one lands as soon as samples accumulate.</div>`;
    return;
  }

  const max = Math.max(...days.map((d) => d.peak || 0), 1);
  box.innerHTML = days.slice(-30).map((d) => {
    const h = Math.max(2, Math.round(((d.peak || 0) / max) * 100));
    const cov = Math.round((d.coverage || 0) * 100);
    const isRef = r && d.d === r.referenceDay;
    const title = `${d.d}${d.dayNumber != null ? ` · day ${d.dayNumber}` : ''}\n` +
      `peak ${fmt(d.peak)} · avg ${fmt(d.avg)} · low ${fmt(d.min)}\n` +
      `${d.n} samples · ${cov}% coverage${d.partial ? ' (partial — app was closed for part of the day)' : ''}`;
    return `<div class="day-col" title="${esc(title)}">
      <div class="day-bar-wrap">
        <div class="day-bar ${d.partial ? 'hatched' : ''} ${isRef ? 'ref' : ''}" style="height:${h}%"></div>
      </div>
      <div class="day-val">${fmtCompact(d.peak)}</div>
      <div class="day-lbl">${d.dayNumber != null ? 'd' + d.dayNumber : esc(d.d.slice(5))}</div>
    </div>`;
  }).join('');
}

// ============================================================
// Complaints
// ============================================================
function renderComplaints(s) {
  const box = el('complaints');
  const ri = s.reviewIntel || {};
  const themes = ri.themes || [];
  const cov = ri.coverage || {};

  const pct = cov.total ? Math.round((cov.english / cov.total) * 100) : 0;
  el('complaintChip').textContent = cov.total ? `${fmt(cov.english)}/${fmt(cov.total)} readable` : '—';

  if (!themes.length) {
    box.innerHTML = `<div class="feed-empty">No complaint themes yet.<br>
      ${cov.total ? `${fmt(cov.total)} reviews stored — none matched a theme.` : 'Reviews are still being collected.'}</div>`;
    return;
  }

  const max = Math.max(...themes.map((t) => t.count), 1);
  box.innerHTML = `<div class="complaint-list">` + themes.slice(0, 8).map((t) => {
    // Trend arrow only above the noise floor — three reviews can't make a "4x surge".
    const showTrend = t.recent48 >= 3 && t.trend !== 1;
    const up = t.trend === null || t.trend > 1.2;
    const down = t.trend !== null && t.trend < 0.8;
    const arrow = showTrend && (up || down)
      ? `<span class="delta ${up ? 'down' : 'up'}">${up ? '▲' : '▼'} ${t.trend === null ? 'new' : t.trend + '×'}</span>`
      : '';
    return `<div class="complaint-row">
      <div class="cr-top">
        <span class="cr-label">${esc(t.label)}</span>
        <span class="cr-count">${fmt(t.count)} ${arrow}</span>
      </div>
      <div class="cr-bar"><div style="width:${Math.round((t.count / max) * 100)}%"></div></div>
      <div class="cr-sub">${t.last24} in 24h · ${t.recent48} in 48h</div>
    </div>`;
  }).join('') + `</div>
    <div class="cov-note">
      Clustering ${fmt(cov.english)} of ${fmt(cov.total)} stored reviews (${pct}%).
      ${cov.nonEnglish ? `${fmt(cov.nonEnglish)} non-English review${cov.nonEnglish > 1 ? 's' : ''} cannot be keyword-matched` : ''}${cov.untagged ? ` · ${fmt(cov.untagged)} English negative${cov.untagged > 1 ? 's' : ''} matched no theme` : ''}.
    </div>`;
}

// ============================================================
// Velocity & sentiment
// ============================================================
function renderVelocity(s) {
  const ri = s.reviewIntel || {};
  const v = ri.velocity || {};
  const r = ri.rolling || {};
  const box = el('velocityPanel');

  if (!ri.coverage || !ri.coverage.total) {
    box.innerHTML = `<div class="feed-empty">No stored reviews yet.</div>`;
    return;
  }

  const deltaCls = r.delta == null ? '' : r.delta < 0 ? 'down' : 'up';
  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="st-val">${v.perHour24 != null ? v.perHour24 : '—'}</div><div class="st-lbl">reviews / hour (24h)</div></div>
      <div class="stat"><div class="st-val">${fmt(v.count24)}</div><div class="st-lbl">in the last 24h</div></div>
      <div class="stat"><div class="st-val">${fmt(v.last1h)}</div><div class="st-lbl">in the last hour</div></div>
      <div class="stat"><div class="st-val">${v.trendPct != null ? (v.trendPct > 0 ? '+' : '') + v.trendPct + '%' : '—'}</div><div class="st-lbl">vs previous 24h</div></div>
    </div>
    <div class="sentiment">
      <div class="sent-row">
        <span class="sent-lbl">Last 7 days</span>
        <div class="sent-bar"><div class="pos" style="width:${r.pct7d || 0}%"></div></div>
        <span class="sent-val">${r.pct7d != null ? r.pct7d + '%' : '—'}</span>
      </div>
      <div class="sent-row">
        <span class="sent-lbl">All time</span>
        <div class="sent-bar"><div class="pos all" style="width:${r.pctAll || 0}%"></div></div>
        <span class="sent-val">${r.pctAll != null ? r.pctAll + '%' : '—'}</span>
      </div>
      <div class="sent-note ${deltaCls}">
        ${r.delta == null
          ? 'Not enough recent reviews to compare.'
          : r.delta === 0
            ? 'Recent sentiment matches the all-time score.'
            : `Recent sentiment is ${Math.abs(r.delta)} point${Math.abs(r.delta) > 1 ? 's' : ''} ${r.delta < 0 ? 'below' : 'above'} all-time — this is the number buyers see on the store page.`}
      </div>
    </div>`;
}

// ============================================================
// Peers
// ============================================================
function renderPeers(s) {
  const box = el('peerPanel');
  const p = s.peers || {};
  const rows = p.rows || [];

  el('peerChip').textContent = p.ourRank ? `#${p.ourRank} of ${rows.length}` : '—';

  if (!rows.length) {
    box.innerHTML = `<div class="feed-empty">No peer data.<br>Add peer games in ⚙ Settings.</div>`;
    return;
  }

  const max = Math.max(...rows.map((r) => r.count || 0), 1);
  box.innerHTML = `<div class="peer-list">` + rows.map((r) => {
    if (!r.available) {
      return `<div class="peer-row dim">
        <span class="pr-name">${esc(r.name)}</span>
        <div class="pr-bar"></div>
        <span class="pr-val">${r.error ? 'error' : 'no data'}</span>
      </div>`;
    }
    const w = Math.max(1, Math.round((r.count / max) * 100));
    return `<div class="peer-row ${r.us ? 'us' : ''}">
      <span class="pr-name">${esc(r.name)}</span>
      <div class="pr-bar"><div style="width:${w}%"></div></div>
      <span class="pr-val">${fmt(r.count)}</span>
    </div>`;
  }).join('') + `</div>` + peerNote(rows, p);
}

function peerNote(rows, p) {
  const us = rows.find((r) => r.us);
  if (!us || !p.ourRank) return '';
  const above = rows[p.ourRank - 2];
  const below = rows[p.ourRank];
  const bits = [];
  if (above && above.available && above.count) {
    bits.push(`${Math.round((us.count / above.count) * 100)}% of ${esc(above.name)}`);
  }
  if (below && below.available && below.count) {
    bits.push(`${(us.count / below.count).toFixed(1)}× ${esc(below.name)}`);
  }
  if (!bits.length) return '';
  return `<div class="cov-note">${bits.join(' · ')}</div>`;
}

function renderTrendFoot(s) {
  const days = (s.trends && s.trends.days) || [];
  const partial = days.filter((d) => d.partial).length;
  const stored = (s.reviewIntel && s.reviewIntel.coverage) ? s.reviewIntel.coverage.total : 0;
  el('trendFoot').textContent =
    `${days.length} day${days.length === 1 ? '' : 's'} tracked` +
    (partial ? ` · ${partial} partial` : '') +
    ` · ${fmt(stored)} reviews stored`;
}
