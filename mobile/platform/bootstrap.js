'use strict';

/* global CultWatchCore, Capacitor */

/**
 * Mobile replacement for electron/main.js + preload.js.
 *
 * On the desktop the poll loop lives in the main process and reaches the UI over
 * IPC. Here there is only one context, so the loop runs in the page and
 * `window.cultwatch` calls it directly — but it exposes the *same* method and
 * event names the renderer already expects, so app.js, trends.js and tinybuild.js
 * are copied across untouched.
 *
 * EVERYTHING lives inside this IIFE, and the single global it creates is
 * `window.cultwatch`. That is not stylistic. Classic scripts all share one global
 * lexical scope, so a top-level `let` here that happens to match a top-level
 * `let` in app.js is a SyntaxError — and the *entire* later script silently fails
 * to execute. That shipped once: both files declared `snapshot`, so app.js never
 * ran, the UI hung on its loading state and no button responded, while the data
 * layer underneath polled and persisted perfectly. Declaring nothing out here
 * removes the whole class of failure instead of the one instance.
 * scripts/test-mobile.js enforces it.
 *
 * Methods with no meaningful phone equivalent (auto-update, OS mute) resolve to
 * an honest "unsupported" rather than throwing, because the renderer calls them
 * unconditionally and a rejected promise there would break the settings drawer.
 */

(function () {
  const core = CultWatchCore.require;
  const { Store } = core('./config');
  const { collect } = core('./poller');
  const { evaluate } = core('./alerts');
  const { segments } = core('./history');

  const store = new Store('cultwatch');
  const listeners = {};
  let snapshot = null;
  let timer = null;
  let polling = false;
  let muted = false;

  function emit(channel, payload) {
    (listeners[channel] || []).forEach((cb) => {
      try { cb(payload); } catch (err) { console.error(`[bootstrap] ${channel} listener threw:`, err); }
    });
  }

  function subscribe(channel, cb) {
    (listeners[channel] = listeners[channel] || []).push(cb);
    return () => {
      listeners[channel] = (listeners[channel] || []).filter((f) => f !== cb);
    };
  }

  async function runPoll(reason) {
    if (polling) return snapshot;
    polling = true;
    emit('poll-start', { reason });
    try {
      const next = await collect(store);

      // Alerts are evaluated exactly as on the desktop; only delivery differs.
      // alerts.js is pure, so persisting the state and the event timeline is the
      // caller's job here just as it is in main.js.
      try {
        const cfg = store.get();
        const result = evaluate(snapshot, next, store.getAlertState(), cfg.alerts, Date.now());
        store.setAlertState(result.state);
        if (result.alerts.length) {
          store.eventLog.add(result.alerts.map((a) => ({
            t: a.ts, type: a.type, title: a.title, url: a.url, key: `${a.type}:${a.ts}`
          })));
          emit('alerts', result.alerts);
          if (cfg.alerts && cfg.alerts.enabled) notify(result.alerts);
        }
      } catch (err) {
        console.error('[bootstrap] alert evaluation failed:', err);
      }

      snapshot = next;
      emit('data-update', next);
      return next;
    } catch (err) {
      console.error('[bootstrap] poll failed:', err);
      emit('poll-error', { message: err.message || String(err) });
      return snapshot;
    } finally {
      polling = false;
    }
  }

  /** Local notifications if the plugin is present; otherwise the in-app Alert
   *  Center still shows everything, so this degrades quietly. */
  async function notify(alerts) {
    const plugin = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications;
    if (!plugin || muted) return;
    try {
      const perm = await plugin.checkPermissions();
      if (perm.display !== 'granted') {
        const asked = await plugin.requestPermissions();
        if (asked.display !== 'granted') return;
      }
      await plugin.schedule({
        notifications: alerts.slice(0, 3).map((a, i) => ({
          id: Date.now() % 100000 + i,
          title: a.title || 'CultWatch',
          body: a.body || a.message || ''
        }))
      });
    } catch (err) {
      console.error('[bootstrap] notification failed:', err);
    }
  }

  // ============================================================
  // Updates
  // ============================================================
  // A sideloaded APK gets none of Play's update machinery, so the app checks
  // GitHub Releases itself. It deliberately stops at *offering* the download:
  // installing silently would need REQUEST_INSTALL_PACKAGES and a FileProvider,
  // i.e. the app claiming the right to install packages in the background. Handing
  // the APK to Android's own package installer keeps the user in the loop and the
  // permission surface small.
  const RELEASES_API = 'https://api.github.com/repos/Kalfadda/CultWatch/releases/latest';
  const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
  let pendingApkUrl = null;
  let pendingApkName = null;
  let pendingVersion = null;
  let downloadPoll = null;
  let downloadReady = false;

  /** -1, 0 or 1. Compares dotted numeric versions; missing parts count as 0. */
  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  async function checkUpdates() {
    const current = window.CULTWATCH_VERSION || '0.0.0';
    emit('update-status', { state: 'checking', info: null });
    try {
      const { getJson } = core('./services/http');
      const rel = await getJson(RELEASES_API);
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      const apk = (rel.assets || []).find((a) => String(a.name || '').endsWith('.apk'));

      if (!latest || compareVersions(latest, current) <= 0) {
        emit('update-status', { state: 'none', info: { version: current } });
        return { ok: true, upToDate: true, version: current };
      }
      if (!apk) {
        // A newer release exists but ships no APK — say so rather than offering
        // a button that cannot do anything.
        emit('update-status', { state: 'error', info: { message: `v${latest} has no Android build yet` } });
        return { ok: true, upToDate: false, version: latest, apk: false };
      }

      pendingApkUrl = apk.browser_download_url;
      pendingApkName = apk.name || `CultWatch-${latest}.apk`;
      pendingVersion = latest;

      // A periodic re-check must not clobber an in-flight or finished download
      // by resetting the pill back to "Download APK".
      if (downloadPoll || downloadReady) return { ok: true, upToDate: false, version: latest };
      // Reuse the 'downloaded' state so the existing pill appears, but relabel
      // the action: nothing has been downloaded, and "Restart" would be a lie.
      emit('update-status', {
        state: 'downloaded',
        info: { version: latest, actionLabel: 'Download APK' }
      });
      return { ok: true, upToDate: false, version: latest };
    } catch (err) {
      const message = err.message || String(err);
      emit('update-status', { state: 'error', info: { message } });
      return { ok: false, error: message };
    }
  }

  /**
   * Polls DownloadManager so the pill shows progress that actually terminates.
   * A download with no progress source is indistinguishable from a stuck one —
   * which is exactly how the previous version looked, and was, broken.
   */
  function trackDownload(dl, id) {
    if (downloadPoll) clearInterval(downloadPoll);
    downloadPoll = setInterval(async () => {
      let s;
      try {
        s = await dl.status({ id: String(id) });
      } catch (err) {
        clearInterval(downloadPoll);
        downloadPoll = null;
        emit('update-status', { state: 'error', info: { message: err.message || String(err) } });
        return;
      }

      if (s.state === 'running' || s.state === 'pending') {
        emit('update-status', { state: 'downloading', info: { percent: s.percent || 0 } });
        return;
      }

      clearInterval(downloadPoll);
      downloadPoll = null;

      if (s.state === 'success') {
        downloadReady = true;
        // Tapping the pill now opens the system Downloads list, where the APK
        // hands off to Android's package installer.
        emit('update-status', {
          state: 'downloaded',
          info: { version: pendingVersion, actionLabel: 'Install' }
        });
      } else if (s.state === 'gone') {
        emit('update-status', { state: 'downloaded', info: { version: pendingVersion, actionLabel: 'Install' } });
      } else {
        emit('update-status', {
          state: 'error',
          info: { message: `download ${s.state}${s.reason ? ' (reason ' + s.reason + ')' : ''}` }
        });
      }
    }, 1000);
  }

  async function installUpdate() {
    // Second tap, once the file is on disk: hand off to the system installer.
    if (downloadReady) {
      const dl = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ApkDownload;
      if (dl) { await dl.openDownloads(); return { ok: true, via: 'downloads' }; }
    }
    if (!pendingApkUrl) return { ok: false, error: 'no update pending' };

    // Must NOT go through Browser.open(): a Custom Tab download is owned by a
    // session that dies with the tab, leaving the file flagged MediaStore
    // IS_PENDING — fully downloaded, invisible to the installer, and stuck on
    // "Download pending…" forever. DownloadManager owns the transfer at system
    // level and publishes it properly.
    const dl = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ApkDownload;
    if (dl) {
      try {
        const { id } = await dl.download({ url: pendingApkUrl, fileName: pendingApkName || 'CultWatch-update.apk' });
        emit('update-status', { state: 'downloading', info: { percent: 0 } });
        trackDownload(dl, id);
        return { ok: true, via: 'DownloadManager' };
      } catch (err) {
        console.error('[bootstrap] DownloadManager failed, falling back to browser:', err);
      }
    }

    // Fallback for a WebView without the plugin (e.g. `npm run mobile:serve`).
    await window.cultwatch.openExternal(pendingApkUrl);
    return { ok: true, via: 'browser' };
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    const sec = Math.max(15, Number(store.get().refreshIntervalSec) || 60);
    timer = setTimeout(async () => {
      await runPoll('interval');
      scheduleNext();
    }, sec * 1000);
  }

  window.cultwatch = {
    getConfig: async () => store.get(),
    updateConfig: async (patch) => {
      const next = store.update(patch || {});
      scheduleNext();
      runPoll('config-change');
      return next;
    },

    refreshNow: () => runPoll('manual'),
    getSnapshot: async () => snapshot,

    // Mirrors the desktop handler exactly, including `segments` — that is what
    // makes stretches where the app was closed render as gaps instead of a
    // confident straight line across missing hours.
    getSeries: async (range) => {
      const cfg = store.get();
      const pollMs = Math.max(15, Number(cfg.refreshIntervalSec) || 60) * 1000;
      const now = Date.now();
      let points, tier, maxGapMs;
      if (range === '7d' || range === 'all') {
        tier = 'medium';
        maxGapMs = 3 * 5 * 60 * 1000;
        const rows = store.series.getMedium();
        const cutoff = range === '7d' ? now - 7 * 86400000 : -Infinity;
        points = rows.filter((r) => r.t >= cutoff).map((r) => ({ t: r.t, v: r.max }));
      } else {
        tier = 'fine';
        maxGapMs = 3 * pollMs;
        points = store.series.getFine();
      }
      return { tier, range: range || '24h', points, segments: segments(points, maxGapMs), maxGapMs };
    },

    clearHistory: async () => {
      store.clearHistory();
      return runPoll('cleared');
    },
    openExternal: async (url) => {
      const browser = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Browser;
      if (browser) return browser.open({ url });
      window.open(url, '_blank');
    },
    openStorePage: async () => {
      const url = `https://store.steampowered.com/app/${store.get().appId}/`;
      return window.cultwatch.openExternal(url);
    },
    setOsMute: async (m) => { muted = !!m; return muted; },
    getOsMute: async () => muted,
    testAlert: async () => {
      const a = [{ title: 'CultWatch', body: 'Test notification — alerts are working.' }];
      emit('alerts', a);
      await notify(a);
      return true;
    },
    checkUpdates,
    installUpdate,

    onDataUpdate: (cb) => subscribe('data-update', cb),
    onPollStart: (cb) => subscribe('poll-start', cb),
    onPollError: (cb) => subscribe('poll-error', cb),
    onAlerts: (cb) => subscribe('alerts', cb),
    onUpdateStatus: (cb) => subscribe('update-status', cb)
  };

  // Pause polling in the background: an Android WebView keeps timers alive but
  // the radio work is wasted, and resuming should feel instant rather than up to
  // a minute stale.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else {
      runPoll('resume');
      scheduleNext();
    }
  });

  runPoll('startup').then(scheduleNext);

  // Same cadence as the desktop updater: shortly after launch, then every 6h.
  setTimeout(() => { checkUpdates().catch(() => { /* reported via update-status */ }); }, 8000);
  setInterval(() => { checkUpdates().catch(() => { /* reported via update-status */ }); }, UPDATE_EVERY_MS);
})();
