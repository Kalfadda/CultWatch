'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const { Store } = require('./config');
const { collect } = require('./poller');

let win = null;
let store = null;
let pollTimer = null;
let polling = false;
let lastSnapshot = null;

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
  send('poll-start', { reason, ts: Date.now() });
  try {
    const snapshot = await collect(store);
    lastSnapshot = snapshot;
    send('data-update', snapshot);
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
