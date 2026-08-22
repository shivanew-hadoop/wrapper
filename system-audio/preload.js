const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('systemAudioAPI', {
  onStart: (cb) => ipcRenderer.on('capture-start', cb),
  onStop: (cb) => ipcRenderer.on('capture-stop', cb),
  sendChunk: (bytes) => ipcRenderer.send('system-audio-chunk', bytes),
  status: (msg) => ipcRenderer.send('system-audio-status', msg),
  error: (msg) => ipcRenderer.send('system-audio-error', msg),
});
