'use strict';

/* global fmt, esc, el */

/**
 * Publisher cohort view — us against the titles our publisher shipped this year.
 *
 * Two rankings side by side because they disagree, and the disagreement is the
 * story. Like the other views, this one renders finished numbers and computes no
 * analysis of its own.
 */

function renderTinybuild(s) {
  const t = s.tinybuild || null;
  const cfg = s.config || {};
  const label = cfg.tinybuildLabel || 'Publisher';
  const days = cfg.tinybuildWindowDays || 365;

  const head = el('tbHead');
  if (head) {
    head.textContent = t
      ? `${label} · last ${days} days · ${t.cohortSize} title${t.cohortSize === 1 ? '' : 's'}` +
        (t.flagged ? ` · ${t.flagged} outside window` : '')
      : `${label} · cohort unavailable`;
  }

  const chip = el('tbChip');
  if (chip) {
    chip.textContent = t && t.momentum.ourRank
      ? `#${t.momentum.ourRank} of ${t.momentum.ourOf} momentum`
      : '—';
  }

  renderTbKpis(t);
  renderTbPanel('tbMomentum', t && t.momentum, momentumCell);
  renderTbPanel('tbReception', t && t.reception, receptionCell);

  const read = el('tbRead');
  if (read) {
    read.textContent = (t && t.readLine) || '';
    read.classList.toggle('hidden', !(t && t.readLine));
  }
}

function renderTbKpis(t) {
  const box = el('tbKpis');
  if (!box) return;
  const cards = [
    {
      k: 'var(--info)',
      label: 'Momentum',
      value: t && t.momentum.ourRank ? `#${t.momentum.ourRank}` : '—',
      dim: !(t && t.momentum.ourRank),
      sub: t && t.momentum.ourRank ? `of ${t.momentum.ourOf} by live players` : 'no player data'
    },
    {
      k: 'var(--pos)',
      label: 'Reception',
      value: t && t.reception.ourRank ? `#${t.reception.ourRank}` : '—',
      dim: !(t && t.reception.ourRank),
      sub: t && t.reception.ourRank ? `of ${t.reception.ourOf} by positive %` : 'no review data'
    },
    {
      k: 'var(--accent)',
      label: 'Share of cohort',
      value: t && t.shareOfCcu != null ? `${t.shareOfCcu}%` : '—',
      dim: !(t && t.shareOfCcu != null),
      sub: 'of all live players'
    }
  ];
  box.innerHTML = cards.map((c) => `
    <div class="kpi ${c.dim ? 'dim' : ''}" style="--k:${c.k}">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>`).join('');
}

function renderTbPanel(id, axis, cell) {
  const box = el(id);
  if (!box) return;
  if (!axis || !axis.rows.length) {
    box.innerHTML = `<div class="feed-empty">No cohort data.<br>Add titles in ⚙ Settings.</div>`;
    return;
  }
  const max = Math.max(...axis.rows.map((r) => r.value || 0), 1);
  box.innerHTML = `<div class="peer-list">` + axis.rows.map((r) => cell(r, max)).join('') + `</div>`;
}

/** Shared row chrome: rank, name, out-of-window flag. */
function rowHead(r) {
  const rank = r.rank == null ? '·' : r.rank;
  const flag = r.outsideWindow
    ? `<span class="tb-flag" title="Released outside the tracked window — the cohort list needs updating">⚠</span>`
    : '';
  return `<span class="tb-rank">${rank}</span><span class="pr-name">${esc(r.name)}${flag}</span>`;
}

function momentumCell(r, max) {
  if (r.rank == null) {
    return `<div class="peer-row dim">${rowHead(r)}<div class="pr-bar"></div>
      <span class="pr-val">${r.error ? 'error' : 'no data'}</span></div>`;
  }
  const w = Math.max(1, Math.round((r.value / max) * 100));
  return `<div class="peer-row ${r.us ? 'us' : ''}">${rowHead(r)}
    <div class="pr-bar"><div style="width:${w}%"></div></div>
    <span class="pr-val">${fmt(r.value)}</span></div>`;
}

function receptionCell(r, max) {
  if (r.rank == null) {
    return `<div class="peer-row dim">${rowHead(r)}<div class="pr-bar"></div>
      <span class="pr-val">no reviews</span><span class="tb-vol"></span></div>`;
  }
  const w = Math.max(1, Math.round((r.value / max) * 100));
  const total = r.reviews ? fmt(r.reviews.total) : '—';
  return `<div class="peer-row ${r.us ? 'us' : ''}">${rowHead(r)}
    <div class="pr-bar"><div style="width:${w}%"></div></div>
    <span class="pr-val">${r.value}%</span>
    <span class="tb-vol">${total}</span></div>`;
}
