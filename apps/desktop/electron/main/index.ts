import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, type Runtime } from './runtime.js';
import { registerIpc } from './ipc.js';
import { Logger } from './logger.js';
import { attachRecovery } from './recovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let rt: Runtime;
let win: BrowserWindow | null = null;

app.whenReady().then(async () => {
  const dataDir = process.env.SPARKII_DATA_DIR ?? join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  const profileDir = process.env.SPARKII_PROFILE_DIR ?? join(__dirname, '../../../../profiles/contract-review');
  rt = await assemble({ profileDir, dataDir, allowUnsigned: process.env.NODE_ENV !== 'production' });
  const logger = new Logger(join(dataDir, 'logs'));
  attachRecovery(rt, logger);
  win = new BrowserWindow({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.cjs') },
  });
  registerIpc(rt, () => win, logger);
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(__dirname, '../../dist/index.html'));
});
