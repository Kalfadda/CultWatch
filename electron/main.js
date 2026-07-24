'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, Notification } = require('electron');
const path = require('path');
const { Store } = require('./config');
const { collect } = require('./poller');
const { evaluate } = require('./alerts');
const { segments } = require('./history');
const { backfillReviews, formatTaxonomy, DEFAULT_TAXONOMY } = require('./reviews');
const steam = require('./services/steam');

/**
 * Never let a failed write to stdout/stderr take down the app.
 *
 * If the app is launched with its output piped somewhere that goes away (a
 * wrapper script, a closed console window from CultWatch.bat), the next
 * console.log raises EPIPE. Node turns an unhandled stream 'error' into an
 * uncaught exception, which Electron surfaces as a "JavaScript error occurred
 * in the main process" dialog — a logging failure should never be fatal to a
 * monitoring tool. Attaching a listener keeps it scoped to these two streams
 * and leaves all other error handling exactly as it was.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  });
}

let win = null;
let store = null;
let pollTimer = null;
let polling = false;
let lastSnapshot = null;
let osMuted = false;
let updateTimer = null;
let autoUpdater = null;

const isDev = process.argv.includes('--dev');
// Dev convenience: boot straight into the Trends view instead of clicking to it
// on every reload. `npm run dev:trends`.
const startView = process.argv.includes('--trends') ? 'trends' : 'live';

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0a0d16',
    title: 'CultWatch — Situation Room',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (startView === 'trends') {
    win.webContents.once('did-finish-load', () => {
      // Small delay so the first snapshot has landed and there is data to draw.
      setTimeout(() => win.webContents.executeJavaScript("setView('trends')").catch(() => {}), 1200);
    });
  }
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Surface renderer errors in the terminal — otherwise a broken panel just
    // renders blank and you have to go looking for the devtools window.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
    });
  }

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function runPoll(reason = 'timer') {
  if (polling) return lastSnapshot;
  polling = true;
  const prev = lastSnapshot;
  send('poll-start', { reason, ts: Date.now() });
  try {
    const snapshot = await collect(store);
    lastSnapshot = snapshot;
    // Steam announcements are timeline events too — they explain shapes in the
    // player curve that alerts alone never would.
    if (Array.isArray(snapshot.news)) {
      store.eventLog.add(snapshot.news
        .filter((n) => n.date)
        .map((n) => ({ t: n.date, type: 'news', title: n.title, url: n.url, key: `news:${n.id}` })));
    }
    send('data-update', snapshot);
    fireAlerts(prev, snapshot);
    return snapshot;
  } catch (err) {
    send('poll-error', { message: err.message || String(err) });
    return null;
  } finally {
    polling = false;
  }
}

function scheduleNext() {
  if (pollTimer) clearInterval(pollTimer);
  const sec = Math.max(15, Number(store.get().refreshIntervalSec) || 60);
  pollTimer = setInterval(() => runPoll('timer'), sec * 1000);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- Auto-update (electron-updater + GitHub Releases) ----
function setupUpdater() {
  // Only meaningful in a packaged build; `npm start` has no update feed.
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater not available', err);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const status = (state, info) => send('update-status', { state, info: info || null });
  autoUpdater.on('checking-for-update', () => status('checking'));
  autoUpdater.on('update-available', (info) => status('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => status('none'));
  autoUpdater.on('download-progress', (p) => status('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => status('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => status('error', { message: (err && err.message) || String(err) }));

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err.message));
  setTimeout(check, 8000); // shortly after launch
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000); // every 6h
}

function fireAlerts(prev, snapshot) {
  const cfg = store.get();
  let result;
  try {
    result = evaluate(prev, snapshot, store.getAlertState(), cfg.alerts, Date.now());
  } catch (err) {
    console.error('[alerts] evaluation failed', err);
    return;
  }
  store.setAlertState(result.state);
  if (!result.alerts.length) return;

  // alerts.js is pure — persisting the timeline is the caller's job.
  store.eventLog.add(result.alerts.map((a) => ({
    t: a.ts, type: a.type, title: a.title, url: a.url, key: `${a.type}:${a.ts}`
  })));

  // Always log to the in-app alert center.
  send('alerts', result.alerts);

  // OS toasts respect the master switch + runtime mute, and are capped so a
  // burst can't spam the desktop.
  if (osMuted || !(cfg.alerts && cfg.alerts.enabled) || !Notification.isSupported()) return;
  for (const a of result.alerts.slice(0, 5)) {
    const n = new Notification({ title: a.title, body: a.body, urgency: a.urgency, silent: false });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (a.url) shell.openExternal(a.url);
    });
    n.show();
  }
}

/**
 * One-time historical review backfill. Steam paginates the full corpus in a
 * handful of requests, so the complaint clustering starts with real data
 * instead of only what happens to arrive after this build is installed.
 * Non-fatal: a failure just leaves the store ingesting incrementally.
 */
async function runBackfill() {
  if (store.reviewStore.backfilledAt()) return;
  try {
    const cfg = store.get();
    const res = await backfillReviews(
      store.reviewStore,
      cfg.appId,
      (appId, cursor) => steam.getReviewsPage(appId, cursor)
    );
    console.log(`[backfill] ${res.added} historical reviews in ${res.pages} page(s)`);
    if (res.added) runPoll('backfill');
  } catch (err) {
    console.error('[backfill] failed (non-fatal):', err.message);
  }
}

function registerIpc() {
  // defaultTaxonomyText is computed, not stored — it gives the Settings
  // textarea a placeholder showing the built-in themes to copy and edit.
  ipcMain.handle('get-config', () => ({
    ...store.get(),
    defaultTaxonomyText: formatTaxonomy(DEFAULT_TAXONOMY)
  }));

  // Served on demand rather than pushed with every snapshot — the medium tier
  // is thousands of points and has no business crossing IPC once a minute.
  ipcMain.handle('get-series', (_e, range) => {
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
  });

  ipcMain.handle('update-config', (_e, patch) => {
    const next = store.update(patch || {});
    scheduleNext(); // interval may have changed
    // Refresh immediately so credential/keyword changes take effect now.
    runPoll('config-change');
    // Same shape as get-config, so the renderer's cached config keeps the
    // computed placeholder after a save.
    return { ...next, defaultTaxonomyText: formatTaxonomy(DEFAULT_TAXONOMY) };
  });

  ipcMain.handle('refresh-now', () => runPoll('manual'));
  ipcMain.handle('get-snapshot', () => lastSnapshot);
  ipcMain.handle('clear-history', () => {
    store.clearHistory();
    return runPoll('history-cleared');
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('open-store-page', () => {
    shell.openExternal(`https://store.steampowered.com/app/${store.get().appId}/`);
  });
  ipcMain.handle('set-os-mute', (_e, muted) => { osMuted = !!muted; return osMuted; });
  ipcMain.handle('get-os-mute', () => osMuted);
  ipcMain.handle('check-updates', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Updates apply to the installed build only — you are running from source (npm start).' };
    if (!autoUpdater) return { ok: false, error: 'Updater is unavailable in this build.' };
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('install-update', () => {
    if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch (err) { console.error('[updater] install failed', err); } }
  });
  ipcMain.handle('test-alert', () => {
    const a = { title: '🔔 CultWatch test alert', body: 'Notifications are working. This is what a launch-day alert looks like.', urgency: 'normal', url: `https://store.steampowered.com/app/${store.get().appId}/`, ts: Date.now(), type: 'test' };
    send('alerts', [a]);
    if (!osMuted && Notification.isSupported()) {
      const n = new Notification({ title: a.title, body: a.body });
      n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
      n.show();
    }
    return true;
  });
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  setupUpdater();
  runPoll('startup');
  runBackfill();
  scheduleNext();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
