// Runs sandboxed in the renderer before the page; exposes a tiny, explicit desktop API to the web app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vatworksDesktop', {
  platform: process.platform,
  ready: () => ipcRenderer.send('renderer-ready'),
  openModels: () => ipcRenderer.invoke('open-models'),
  saveGoo: (name, data) => ipcRenderer.invoke('save-goo', { name, data }),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  onFilesOpened: (cb) => ipcRenderer.on('files-opened', (_e, files) => cb(files)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
