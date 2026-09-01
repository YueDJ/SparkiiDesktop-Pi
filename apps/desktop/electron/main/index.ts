import { app, BrowserWindow, Menu, nativeImage } from 'electron';
import { mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, type Runtime } from './runtime.js';
import { registerIpc } from './ipc.js';
import { Logger } from './logger.js';
import { attachRecovery } from './recovery.js';
import { defaultDataDir } from './paths.js';
import { loadSettings } from './settings.js';
import { ensureRuntime, runtimeArchivePath, runtimeToolsPath, verifyRuntime } from './runtime-provision.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let rt: Runtime;
let win: BrowserWindow | null = null;

function resolveWindowIcon() {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(__dirname, '../../dist/icon-512.png'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return nativeImage.createFromBuffer(readFileSync(p));
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = process.env.SPARKII_DATA_DIR ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const logger = new Logger(join(dataDir, 'logs'), !app.isPackaged);
  const settings = await loadSettings(dataDir);
  logger.level = settings.logLevel ?? 'info';
  await ensureRuntime({
    archivePath: runtimeArchivePath(process.env, process.resourcesPath),
    toolsDir: runtimeToolsPath(process.env, process.resourcesPath),
  }).catch((e) => {
    void logger.log({ level: 'error', msg: 'runtime ensure failed', ctx: { error: e instanceof Error ? e.message : String(e) } });
  });
  const runtimeCheck = await verifyRuntime(process.env).catch(() => null);
  void logger.log({ level: 'debug', msg: 'runtime verify', ctx: (runtimeCheck ?? { error: 'verify failed' }) as unknown as Record<string, unknown> });
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
  attachRecovery(rt, logger);
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    title: 'Sparkii',
    autoHideMenuBar: true,
    backgroundColor: '#F5F7FB',
    icon: resolveWindowIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.cjs') },
  });
  registerIpc(rt, () => win, logger);
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(__dirname, '../../dist/index.html'));
});
