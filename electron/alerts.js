'use strict';

/**
 * Launch-day alert engine. Pure function: compares the previous snapshot to the
 * new one against persisted alert state, and returns the notifications to fire
 * plus the updated state. No Electron/IO here so it can be unit-tested.
 *
 *   evaluate(prev, next, state, cfg, now) -> { alerts: [...], state: {...} }
 *
 * Each alert: { type, title, body, urgency: 'normal'|'critical', url, ts }.
 */

const { attribute, describeCauses } = require('./attribution');

const DEFAULT_ALERTS = {
  enabled: true,
  sound: true,
  onLaunch: true,
  milestones: true,
  milestoneSteps: [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000],
  newPeak: true,
  peakCooldownMin: 15,
  spikes: true,
  spikePct: 40,
  spikeMinPlayers: 50,
  spikeCooldownMin: 4,
  reviews: true,
  reviewsOnlyNegative: false,
  scoreBandChange: true,
  bigStreams: true,
  bigStreamViewers: 500,
  complaintSurge: true,
  complaintSurgeMin: 5,
  complaintSurgeMult: 3,
  complaintCooldownHr: 6
};

const DEFAULT_STATE = {
  launched: false,
  lastMilestone: 0,
  peakAlerted: 0,
  lastPeakAlertTs: 0,
  lastSpikeTs: 0,
  seenReviewIds: [],
  reviewsInitialized: false,
  lastReviewTotal: null,
  lastScoreDesc: null,
  alertedStreams: [],
  themeAlerts: {}
};

function storePage(next) {
  const id = next && next.config && next.config.appId;
  return id ? `https://store.steampowered.com/app/${id}/` : 'https://store.steampowered.com/';
}

function evaluate(prev, next, stateIn, cfgIn, now = Date.now()) {
  const cfg = { ...DEFAULT_ALERTS, ...(cfgIn || {}) };
  // structuredClone, not a bare spread: DEFAULT_STATE's arrays and objects
  // would otherwise be shared by reference, and code below push()es into them —
  // which would quietly mutate the module-level defaults for every later call.
  const state = { ...structuredClone(DEFAULT_STATE), ...(stateIn || {}) };
  const alerts = [];
  if (!cfg.enabled || !next) return { alerts, state };

  const push = (type, title, body, opts = {}) => {
    const alert = { type, title, body, urgency: opts.urgency || 'normal', url: opts.url || storePage(next), ts: now };
    if (opts.causes) {
      alert.causes = opts.causes;
      alert.body = `${body} ${describeCauses(opts.causes)}`;
    }
    alerts.push(alert);
  };

  const players = next.players || {};
  const cur = players.available ? players.current : null;
  let milestoneFired = false;

  // --- Game went live (first time we ever see live player data) ---
  if (cfg.onLaunch && players.available && !state.launched) {
    state.launched = true;
    push('launch', '🚀 We are LIVE!', `Steam is now reporting live players for ${gameName(next)}${cur != null ? ` — ${fmt(cur)} online right now.` : '.'}`, { urgency: 'critical' });
  } else if (players.available && !state.launched) {
    state.launched = true; // record without alerting if onLaunch disabled
  }

  // --- Player milestones (fire only the highest step newly crossed) ---
  if (cfg.milestones && cur != null) {
    const steps = (cfg.milestoneSteps || []).slice().sort((a, b) => a - b);
    let crossed = 0;
    for (const s of steps) if (cur >= s && s > state.lastMilestone) crossed = s;
    if (crossed > 0) {
      state.lastMilestone = crossed;
      milestoneFired = true;
      push('milestone', `🎉 ${fmt(crossed)} concurrent players!`, `${gameName(next)} just passed ${fmt(crossed)} players online (now ${fmt(cur)}).`);
    }
  }

  // --- New all-time peak (throttled, and suppressed if a milestone just fired) ---
  if (cfg.newPeak && !milestoneFired && typeof players.peakSession === 'number') {
    const cooldownOk = now - (state.lastPeakAlertTs || 0) > (cfg.peakCooldownMin || 15) * 60000;
    const meaningful = players.peakSession > state.peakAlerted && players.peakSession >= (cfg.spikeMinPlayers || 0);
    if (meaningful && cooldownOk && state.peakAlerted > 0) {
      push('peak', `📈 New peak: ${fmt(players.peakSession)}`, `${gameName(next)} set a new concurrent-player high of ${fmt(players.peakSession)}.`);
      state.lastPeakAlertTs = now;
    }
    if (players.peakSession > state.peakAlerted) state.peakAlerted = players.peakSession;
  } else if (typeof players.peakSession === 'number' && players.peakSession > state.peakAlerted) {
    state.peakAlerted = players.peakSession;
  }

  // --- Sudden spike / drop between the last two samples ---
  if (cfg.spikes) {
    const h = players.history || [];
    if (h.length >= 2) {
      const last = h[h.length - 1];
      const prevPt = h[h.length - 2];
      if (last && prevPt && last.v != null && prevPt.v != null && prevPt.v > 0) {
        const pct = ((last.v - prevPt.v) / prevPt.v) * 100;
        const big = Math.max(last.v, prevPt.v) >= (cfg.spikeMinPlayers || 0);
        const cooldownOk = now - (state.lastSpikeTs || 0) > (cfg.spikeCooldownMin || 4) * 60000;
        if (big && cooldownOk && Math.abs(pct) >= (cfg.spikePct || 40)) {
          state.lastSpikeTs = now;
          // Name the likely driver so the alert answers its own question.
          const causes = attribute({ t: now, direction: pct > 0 ? 'up' : 'down' }, next);
          if (pct > 0) {
            push('spike-up', `⚡ Player surge +${Math.round(pct)}%`,
              `Players jumped from ${fmt(prevPt.v)} to ${fmt(last.v)}.`, { causes });
          } else {
            push('spike-down', `🔻 Player drop ${Math.round(pct)}%`,
              `Players fell from ${fmt(prevPt.v)} to ${fmt(last.v)}.`, { urgency: 'critical', causes });
          }
        }
      }
    }
  }

  // --- Reviews ---
  const reviews = next.reviews;
  if (cfg.reviews && reviews) {
    const recent = reviews.recent || [];
    // First review ever (total 0 -> >0)
    const wasZero = state.lastReviewTotal === 0 || (prev && prev.reviews && prev.reviews.total === 0);
    if (!state.reviewsInitialized) {
      // Seed the "seen" set so we don't alert the whole backlog on first run.
      state.seenReviewIds = recent.map((r) => r.id).filter(Boolean);
      state.reviewsInitialized = true;
    } else {
      for (const r of recent) {
        if (!r.id || state.seenReviewIds.includes(r.id)) continue;
        state.seenReviewIds.push(r.id);
        if (cfg.reviewsOnlyNegative && r.votedUp) continue;
        const kind = r.votedUp ? '👍 Positive' : '👎 Negative';
        push(r.votedUp ? 'review-pos' : 'review-neg',
          `${kind} Steam review`,
          truncate(r.text || '(no text)', 140) + (r.hoursPlayed != null ? `  · ${r.hoursPlayed}h played` : ''),
          { urgency: r.votedUp ? 'normal' : 'critical' });
      }
      // Cap the seen list
      if (state.seenReviewIds.length > 300) state.seenReviewIds = state.seenReviewIds.slice(-300);
    }
    if (wasZero && reviews.total > 0 && state.lastReviewTotal !== reviews.total) {
      push('first-review', '⭐ First review is in!', `${gameName(next)} just received its first Steam review.`, { urgency: 'critical' });
    }

    // Score band change (e.g. "Very Positive" -> "Mostly Positive")
    if (cfg.scoreBandChange && reviews.scoreDesc && reviews.total >= 10) {
      if (state.lastScoreDesc && state.lastScoreDesc !== reviews.scoreDesc) {
        push('score-band', `Review rating changed → ${reviews.scoreDesc}`,
          `Overall Steam rating moved from "${state.lastScoreDesc}" to "${reviews.scoreDesc}" (${reviews.positivePct}% of ${fmt(reviews.total)}).`);
      }
      state.lastScoreDesc = reviews.scoreDesc;
    } else if (reviews.scoreDesc) {
      state.lastScoreDesc = reviews.scoreDesc;
    }
    state.lastReviewTotal = reviews.total;
  }

  // --- Complaint surge: one review theme spiking in the last 24h ---
  // Uses the 24h window (the UI's arrow uses 48h) so a post-patch regression is
  // caught the same day. Both windows come from the same analysis pass, so the
  // panel and the alert can't disagree about what "surging" means.
  if (cfg.complaintSurge && next.reviewIntel && Array.isArray(next.reviewIntel.themes)) {
    const cooldownMs = (cfg.complaintCooldownHr || 6) * 3600000;
    const min = cfg.complaintSurgeMin || 5;
    const mult = cfg.complaintSurgeMult || 3;
    state.themeAlerts = { ...(state.themeAlerts || {}) };
    for (const th of next.reviewIntel.themes) {
      if (!th || !th.key) continue;
      const last24 = th.last24 || 0;
      if (last24 < min || last24 < mult * Math.max(th.prior24 || 0, 1)) continue;
      if (now - (state.themeAlerts[th.key] || 0) < cooldownMs) continue;
      state.themeAlerts[th.key] = now;
      push('complaint-surge', `⚠️ "${th.label}" complaints surging`,
        `${last24} negative reviews mentioning ${String(th.label).toLowerCase()} in the last 24h (was ${th.prior24 || 0} the day before).`,
        { urgency: 'critical' });
    }
  }

  // --- Big Twitch streams picking up the game ---
  if (cfg.bigStreams && next.twitch && next.twitch.enabled) {
    for (const st of next.twitch.live || []) {
      if (st.viewers >= (cfg.bigStreamViewers || 500) && !state.alertedStreams.includes(st.id)) {
        state.alertedStreams.push(st.id);
        push('big-stream', `📺 ${st.user} is streaming (${fmt(st.viewers)} viewers)`, truncate(st.title || '', 120), { url: st.url });
      }
    }
    if (state.alertedStreams.length > 200) state.alertedStreams = state.alertedStreams.slice(-200);
  }

  return { alerts, state };
}

function gameName(s) {
  return (s.game && s.game.name) || (s.config && s.config.gameName) || 'the game';
}
function fmt(n) {
  return n == null ? '—' : new Intl.NumberFormat('en-US').format(n);
}
function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { evaluate, DEFAULT_ALERTS, DEFAULT_STATE };
