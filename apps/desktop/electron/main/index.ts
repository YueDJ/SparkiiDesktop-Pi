import { app, BrowserWindow, Menu } from 'electron';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, type Runtime } from './runtime.js';
import { registerIpc } from './ipc.js';
import { Logger } from './logger.js';
import { attachRecovery } from './recovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let rt: Runtime;
let win: BrowserWindow | null = null;

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = process.env.SPARKII_DATA_DIR ?? join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  const single = process.env.SPARKII_PROFILE_DIR;
  const profileRoot = single
    ? dirname(single)
    : (app.isPackaged ? join(process.resourcesPath, 'profiles') : join(__dirname, '../../../../profiles'));
  const profileDirs = single
    ? [{ id: basename(single), dir: single }]
    : readdirSync(profileRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(profileRoot, e.name, 'manifest.yaml')))
        .map((e) => ({ id: e.name, dir: join(profileRoot, e.name) }));
  rt = await assemble({ profiles: profileDirs, dataDir, allowUnsigned: process.env.NODE_ENV !== 'production' });
  const logger = new Logger(join(dataDir, 'logs'));
  attachRecovery(rt, logger);
  win = new BrowserWindow({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.cjs') },
  });
  registerIpc(rt, () => win, logger);
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(__dirname, '../../dist/index.html'));
});
