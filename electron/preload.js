'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure bridge between the renderer and main process. The renderer never
 * touches Node or the network directly — it only calls these methods.
 */
contextBridge.exposeInMainWorld('cultwatch', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (patch) => ipcRenderer.invoke('update-config', patch),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  getSeries: (range) => ipcRenderer.invoke('get-series', range),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openStorePage: () => ipcRenderer.invoke('open-store-page'),
  setOsMute: (muted) => ipcRenderer.invoke('set-os-mute', muted),
  getOsMute: () => ipcRenderer.invoke('get-os-mute'),
  testAlert: () => ipcRenderer.invoke('test-alert'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  onDataUpdate: (cb) => subscribe('data-update', cb),
  onPollStart: (cb) => subscribe('poll-start', cb),
  onPollError: (cb) => subscribe('poll-error', cb),
  onAlerts: (cb) => subscribe('alerts', cb),
  onUpdateStatus: (cb) => subscribe('update-status', cb)
});

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
