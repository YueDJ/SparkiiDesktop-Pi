import { app, BrowserWindow, Menu, nativeImage, net, powerMonitor, shell } from 'electron';
import { mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, type Runtime } from './runtime.js';
import { registerIpc } from './ipc.js';
import { installDocumentParseQuitHook } from './document-parse-quit.js';
import { getDocumentParseSupervisor } from './document-parse-supervisor.js';
import { Logger } from './logger.js';
import { attachRecovery } from './recovery.js';
import { defaultDataDir } from './paths.js';
import { loadSettings, saveSettings } from './settings.js';
import { ensureRuntime, runtimeArchivePath, runtimeToolsPath, verifyRuntime } from './runtime-provision.js';
import { initUpdateService, type UpdateDeps, type UpdateService } from './update/service.js';
import { snapshotDataDir } from './update/installer.js';
import type { AppSettingsLike } from './update/config.js';
import type { LoggerLike } from './update/types.js';
import {
  createShutdownController, createShutdownHooks, createSeqMirror, createUpdateAuditSink,
  createUpdateQuitGuard, resolveUpdateHmacKey, startUpdateScheduling, type SchedulingHandle,
} from './update-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let rt: Runtime;
let win: BrowserWindow | null = null;
/** §7.7 步骤 1：更新退出专用标志。before-quit 钩子据此放行，不再 preventDefault。 */
const isUpdating: { value: boolean } = { value: false };
let updateService: UpdateService | null = null;
let updateScheduling: SchedulingHandle | null = null;

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

/**
 * §7.7 单实例锁：必须在 app.whenReady() 之前申请。
 * 拿不到锁直接 app.exit(0)——不走 before-quit，避免第二实例把首实例的库/进程拖进关机协议。
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 窗口可能已被关掉（应用仍活着）：对已销毁的 BrowserWindow 调 isMinimized/focus 会抛。
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function loggerAdapter(logger: Logger): LoggerLike {
  return {
    info: (m) => { void logger.log({ level: 'info', msg: m }); },
    warn: (m) => { void logger.log({ level: 'warn', msg: m }); },
    error: (m) => { void logger.log({ level: 'error', msg: m }); },
  };
}

/**
 * 装配更新服务（契约 §8 集成收口）。任何前置条件不满足都「不装配」而不是「装配一个降级版」：
 * IPC 层用 hasUpdateService() 兜底为结构化「更新未就绪」，更新链路对外表现为完全关闭。
 */
async function setupUpdateService(dataDir: string, logger: Logger): Promise<void> {
  const log = loggerAdapter(logger);
  let hmacSecret: Buffer;
  try {
    hmacSecret = await resolveUpdateHmacKey(rt.keyring);
  } catch (e) {
    log.error(`update service disabled (HMAC key unavailable): ${String(e)}`);
    return; // fail closed：宁可没有更新，也不带一个可篡改的防降级状态运行
  }

  // §7.7 步骤 2–5 + §7.8 快照：句柄接线在 update-bootstrap 里（可单测），这里只提供真实对象。
  const controller = createShutdownController(
    createShutdownHooks({
      pool: rt.pool,
      audit: rt.audit,
      chatSessions: rt.chatSessions,
      errors: rt.errors,
      gate: rt.gate,
      reviewer: { dispose: async () => { await rt.security?.reviewer.dispose(); } },
      documentParseSupervisor: { beginQuit: async () => { await getDocumentParseSupervisor().beginQuit(); } },
    }, dataDir, {
      audit: rt.audit,
      logger: log,
      snapshot: snapshotDataDir,
    }),
    { onError: (e) => log.error(`update shutdown sequence failed: ${String(e)}`) },
  );

  const deps: UpdateDeps = {
    dataDir,
    currentVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
    logger: log,
    // §7.9：update.* 只写 AuditStore，但 verify-failed 额外镜像一份到 errors 供只读展示（装配层完成）。
    audit: createUpdateAuditSink(rt.audit, rt.errors) as unknown as UpdateDeps['audit'],
    sendEvent: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    loadSettings: async () => (await loadSettings(dataDir)) as unknown as AppSettingsLike,
    saveSettings: async (patch) => {
      // 保留既有 merge 语义（§7.4）：先读全量，再浅合并补丁落盘。
      const current = await loadSettings(dataDir);
      await saveSettings(dataDir, { ...current, ...(patch as Record<string, unknown>) });
    },
    keyringSecret: async () => hmacSecret,
    // §6.3 第 4 条的下限判别锚：区分「首次装机」与「状态文件被删」。
    seqMirror: createSeqMirror(rt.keyring),
    rt: {
      pool: rt.pool,
      auditStore: rt.audit,
      chatSessions: rt.chatSessions,
      errors: rt.errors,
      gate: rt.gate,
      reviewer: { dispose: async () => { await rt.security?.reviewer.dispose(); } },
      documentParseSupervisor: { beginQuit: async () => { await getDocumentParseSupervisor().beginQuit(); } },
    },
    isUpdatingRef: isUpdating,
    shutdownController: controller,
    // §7.10 闸门输入：活跃任务 = Pi 池有会话或有待审批提案；离线取 Electron net.online。
    hasActiveWork: () => rt.pool.activeCount() > 0 || rt.gate.listPending().length > 0,
    isNetworkOffline: () => net.online === false,
    // §7.7 步骤 7.2：先 quit()，3s 内没退掉再 exit(0) 兜底（仅由安装事务调用）。
    quitApp: () => {
      app.quit();
      const timer = setTimeout(() => app.exit(0), 3000);
      timer.unref?.();
    },
    now: () => Date.now(),
  };

  updateService = initUpdateService(deps);
  app.on('before-quit', createUpdateQuitGuard({
    service: updateService,
    controller,
    app,
    isUpdatingRef: isUpdating,
    logger: log,
  }));

  // 状态①：本地扫描 pending/（零网络、不受闸门约束），让「可安装」立刻可见。
  await updateService.startupScan();

  updateScheduling = startUpdateScheduling({
    service: updateService,
    settings: async () => (await loadSettings(dataDir)) as unknown as AppSettingsLike,
    logger: log,
    now: () => Date.now(),
    hasActiveWork: deps.hasActiveWork,
    net,
    powerMonitor,
    // 抖动种子只用本地目录 + 版本，永不出网（§6.6）。
    jitterSeed: `${dataDir}|${app.getVersion()}`,
  });
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
    resourcesPath: process.resourcesPath,
    env: process.env,
  }).catch((e) => {
    void logger.log({ level: 'error', msg: 'runtime ensure failed', ctx: { error: e instanceof Error ? e.message : String(e) } });
  });
  const runtimeCheck = await verifyRuntime(process.env).catch(() => null);
  void logger.log({ level: 'debug', msg: 'runtime verify', ctx: (runtimeCheck ?? { error: 'verify failed' }) as unknown as Record<string, unknown> });
  const single = process.env.SPARKII_PROFILE_DIR;
  const profileRoot = single
    ? dirname(single)
    : (app.isPackaged ? join(process.resourcesPath, 'agents') : join(__dirname, '../../agents'));
  const profileDirs = single
    ? [{ id: basename(single), dir: single }]
    : readdirSync(profileRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(profileRoot, e.name, 'manifest.yaml')))
        .map((e) => ({ id: e.name, dir: join(profileRoot, e.name) }));
  rt = await assemble({ profiles: profileDirs, dataDir, allowUnsigned: process.env.NODE_ENV !== 'production', logger });
  // The hidden reviewer worker must not outlive the app. Idempotent, and it
  // never touches normal Agent sessions.
  app.on('before-quit', () => {
    void rt.security?.reviewer.dispose().catch(() => {});
  });
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
  // isUpdating 时该钩子直接放行（不 preventDefault、不二次 quit），避免与更新关机协议抢退出（§7.7 步骤 1）。
  installDocumentParseQuitHook(app, undefined, () => isUpdating.value);
  app.on('before-quit', () => {
    // 任何退出路径都先停掉调度与下载：绝不在关机途中再发一次网络检查。
    updateScheduling?.stop();
    updateScheduling = null;
    void updateService?.shutdown().catch(() => {});
  });
  await setupUpdateService(dataDir, logger).catch((e) => {
    // 装配失败只影响更新能力本身：IPC 侧退化为「更新未就绪」，主流程照常启动。
    void logger.log({ level: 'error', msg: 'update service setup failed', ctx: { error: e instanceof Error ? e.message : String(e) } });
  });

  // 导航守卫：Sparkii 是本地页面应用，任何外链（聊天里点链接等）都必须交给系统浏览器打开，
  // 绝不允许主窗口离开应用页面——否则窗口会去加载外网并可能白屏/丢失整个 UI。
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const appIndexUrl = devServerUrl ?? pathToFileURL(join(__dirname, '../../dist/index.html')).toString();
  const isAppUrl = (url: string) => url === appIndexUrl || url.startsWith(appIndexUrl);
  const openExternalIfWeb = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalIfWeb(url);
  });

  if (devServerUrl) await win.loadURL(devServerUrl);
  else await win.loadFile(join(__dirname, '../../dist/index.html'));
});
