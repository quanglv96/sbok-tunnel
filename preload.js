'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbok', {
  snapshot: () => ipcRenderer.invoke('sbok:snapshot'),
  recheck: () => ipcRenderer.invoke('sbok:recheck'),
  changeDataDir: () => ipcRenderer.invoke('sbok:change-data-dir'),
  tts: {
    get: () => ipcRenderer.invoke('tts:get'),
    voices: (model) => ipcRenderer.invoke('tts:voices', model),
    save: (input) => ipcRenderer.invoke('tts:save', input),
    preview: (input) => ipcRenderer.invoke('tts:preview', input),
  },
  onState: (cb) => ipcRenderer.on('sbok:state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('sbok:log', (_e, line) => cb(line)),
});
