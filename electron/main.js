'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, Notification } = require('electron');
const path = require('path');
const { Store } = require('./config');
const { collect } = require('./poller');
const { evaluate } = require('./alerts');

let win = null;
let store = null;
let pollTimer = null;
let polling = false;
let lastSnapshot = null;
let osMuted = false;

const isDev = process.argv.includes('--dev');

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
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

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

function registerIpc() {
  ipcMain.handle('get-config', () => store.get());

  ipcMain.handle('update-config', (_e, patch) => {
    const next = store.update(patch || {});
    scheduleNext(); // interval may have changed
    // Refresh immediately so credential/keyword changes take effect now.
    runPoll('config-change');
    return next;
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
  runPoll('startup');
  scheduleNext();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
