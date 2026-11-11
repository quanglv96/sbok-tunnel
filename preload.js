'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbok', {
  snapshot: () => ipcRenderer.invoke('sbok:snapshot'),
  onState: (cb) => ipcRenderer.on('sbok:state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('sbok:log', (_e, line) => cb(line)),
});
