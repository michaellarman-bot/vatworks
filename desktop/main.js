// Vatworks desktop (Electron) — main process. Starts the same server the Docker build uses, on a random localhost
// port, and opens it in a native window with a real menu, native open/save dialogs and .stl/.goo file associations.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { start } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const smoke = process.argv.includes('--smoke');
const argOpen = process.argv.find((a) => a.startsWith('--open='))?.slice(7);

let win = null;
let port = 0;
let handle = null;
let rendererReady = false;
const queuedFiles = [];

app.setName('Vatworks');
if (isMac) app.setAboutPanelOptions({ applicationName: 'Vatworks', applicationVersion: app.getVersion(), copyright: 'Resin slicer for the Elegoo Saturn 4 Ultra' });

const MODEL_EXT = ['stl', 'obj', '3mf', 'goo'];

async function readFiles(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ name: path.basename(p), data: await fs.readFile(p) });
    } catch (e) {
      dialog.showErrorBox('Cannot open file', `${p}\n\n${e.message}`);
    }
  }
  return out;
}

function sendFiles(files) {
  if (!files.length) return;
  if (win && rendererReady) win.webContents.send('files-opened', files);
  else queuedFiles.push(...files);
}
ipcMain.on('renderer-ready', () => { rendererReady = true; if (queuedFiles.length) win?.webContents.send('files-opened', queuedFiles.splice(0)); });

async function openModels() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open model',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '3D models and sliced files', extensions: MODEL_EXT }, { name: '3D models', extensions: ['stl', 'obj', '3mf'] }, { name: 'Elegoo GOO', extensions: ['goo'] }],
  });
  if (r.canceled) return [];
  return readFiles(r.filePaths);
}

function buildMenu() {
  const send = (action) => () => win?.webContents.send('menu', action);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Model…', accelerator: 'CmdOrCtrl+O', click: async () => sendFiles(await openModels()) },
        { label: 'Save Sliced File…', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { type: 'separator' },
        { label: 'Slice', accelerator: 'CmdOrCtrl+Return', click: send('slice') },
        { label: 'Send to Printer…', accelerator: 'CmdOrCtrl+P', click: send('send') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Prepare', accelerator: 'CmdOrCtrl+1', click: send('prepare') },
        { label: 'Preview Layers', accelerator: 'CmdOrCtrl+2', click: send('preview') },
        { label: 'Fit to View', accelerator: 'CmdOrCtrl+F', click: send('fit') },
        { label: 'X-ray', accelerator: 'CmdOrCtrl+X', click: send('xray') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Vatworks README', click: () => shell.openPath(path.join(__dirname, '..', 'README.md')) },
        { label: `Local server: http://127.0.0.1:${port}`, click: () => shell.openExternal(`http://127.0.0.1:${port}`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: 'Vatworks',
    show: false,
    backgroundColor: '#e2e4e2',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  if (smoke) win.webContents.on('console-message', (e) => { if (e.level >= 1) console.log('RENDERER', e.message.slice(0, 300)); });
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('open-models', () => openModels());
ipcMain.handle('save-goo', async (_e, { name, data }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save sliced file', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'Elegoo GOO', extensions: ['goo'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return r.filePath;
});
ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); });

// macOS: files double-clicked or dropped on the Dock icon
app.on('open-file', async (e, p) => { e.preventDefault(); sendFiles(await readFiles([p])); });

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('activate', () => { if (!win && port) createWindow(); });
app.on('before-quit', () => { handle?.server.close(); });

app.whenReady().then(async () => {
  handle = await start({ port: 0, host: '127.0.0.1', publicDir: path.join(__dirname, '..', 'public') });
  port = handle.port;
  buildMenu();
  await createWindow();
  // files passed on the command line (Windows/Linux "open with", or --open=… for tests)
  const cli = process.argv.slice(1).filter((a) => !a.startsWith('-') && MODEL_EXT.includes(a.split('.').pop().toLowerCase()));
  if (argOpen) cli.push(argOpen);
  if (cli.length) sendFiles(await readFiles(cli));
  if (smoke) {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/smoke.goo' });
    await new Promise((r) => setTimeout(r, 3000));
    await win.webContents.executeJavaScript('window.vatworks.state.print.layerHeight = 0.1; window.vatworks.slice(); 0');
    for (let i = 0; i < 120 && !(await win.webContents.executeJavaScript('!!window.vatworks.sliced')); i++) await new Promise((r) => setTimeout(r, 500));
    await win.webContents.executeJavaScript('document.querySelector("#btn-download").click(); 0');
    await new Promise((r) => setTimeout(r, 2500));
    const saved = await fs.stat('/tmp/smoke.goo').then((st) => st.size).catch(() => 0);
    console.log('SMOKE saved bytes', saved);
    const ok = await win.webContents.executeJavaScript('({ app: !!window.vatworks, bridge: !!window.vatworksDesktop, objects: window.vatworks ? window.vatworks.objects.length : -1, desktopClass: document.body.classList.contains("desktop"), status: document.querySelector("#status").textContent, toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent) })');
    console.log('SMOKE', JSON.stringify({ port, ...ok }));
    app.quit();
  }
});
