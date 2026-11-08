// UpdateService 门面（契约 §4）。main/ipc.ts (G5) 只经本门面访问；main/index.ts 只调
// initUpdateService / getUpdateService / shutdown。
// B 关已接管：installUpdate 走 installer.ts 的真实事务，onBeforeQuit 由关机控制器判幂等。
//
// 硬约束（不得削弱）：
//  - autoDownload 恒 false（AUTO_DOWNLOAD 常量 + getSettings 断言 + createUpdater 三开关）；
//  - downloadUpdate / installUpdate 各自先跑验签门禁（fetchAndVerify / verifyCompanion）；
//  - 事件用完整 channel 名，进度 ≥200ms 节流；
//  - startupScan 零网络。

import { join } from 'node:path';
import { normalizeBaseUrl, resolveUpdateSettings, type AppSettingsLike } from './config.js';
import { logUpdateEvent } from './audit.js';
// R16 · Minor-3：版本高低比较**只此一处权威**（decision.ts）。service 里原先另有一条 `compareSimple`，
// 它不剥前导 `v`、也不看预发布段，于是 `0.3.0` 与 `0.3.0+build.2` 判等 ⇒ "显示哪一包"取决于 readdir 顺序。
import { compareVersions, decide } from './decision.js';
import { pendingVersionDir, isSafeVersionSegment } from './dirs.js';
import { cancelDownload as cancelDownloadFiles, finalizeDownload, planDownload } from './downloader.js';
import {
  runInstallTransaction, verifyAuditChain, verifyStartupWith, appendClientAuditChain,
} from './installer.js';
import { clearPending, scanPending, verifyCompanion, type ScanOptions } from './local-artifacts.js';
import { shouldCheck, jitterDelay } from './scheduler.js';
import { TamperedStateWriteError, UpdateStateStore } from './state-store.js';
import {
  UPDATE_EVENT_PROGRESS, UPDATE_EVENT_STATE,
} from './types.js';
import type {
  AuditLike, LocalUpdateInfo, LoggerLike, PublicKeyMap, RemoteUpdateInfo,
  UpdateActionResult, UpdatePhase, UpdateProgress, UpdateSettingsPatch,
  UpdateSettingsPublic, UpdateState,
} from './types.js';
import {
  createUpdater, crossCheckUpdateInfo, isUpdaterUnavailable, writeDerivedFeed,
  type NsisUpdaterLike,
} from './updater-adapter.js';
import { deriveLatestYml, fetchAndVerify, type VerifyOptions } from './verifier.js';

export type { AppSettingsLike } from './config.js';

/** autoDownload 恒 false 的显式常量（不接受任何配置项覆盖）。 */
export const AUTO_DOWNLOAD = false as const;

/** IPC 边界上的 version 形态：与 `dirs.ts` 的 choke point 同一判据（旧宽正则允许 `..`）。 */
const isSafeVersion = isSafeVersionSegment;

/**
 * 结构化 CancellationToken（electron-updater 只读 `cancelled` / 调 `onCancelled` / `cancel`）。
 * 生产用同一形态即可贯穿 AppUpdater.downloadUpdate() → httpExecutor.download()；
 * 单测可直接传入同一对象。
 */
export interface SimpleCancelToken {
  cancelled: boolean;
  cancel(): void;
  onCancelled(cb: () => void): void;
}

export function makeCancellationToken(): SimpleCancelToken {
  let cancelled = false;
  const callbacks: Array<() => void> = [];
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const cb of callbacks) { try { cb(); } catch { /* 忽略回调内异常 */ } }
    },
    onCancelled(cb: () => void) { callbacks.push(cb); },
  };
}

/**
 * §7.7 关机协议控制器：幂等。runOnce() 保证同一次进程生命周期内只跑一遍严格顺序，
 * hasRun() 供 before-quit 兜底判断「安装事务已经跑过关机序列，无需再 preventDefault」。
 */
export interface UpdateShutdownController {
  runOnce(): Promise<unknown[]>;
  hasRun(): boolean;
  /**
   * **已进入**（未必完成）的步骤名。两个消费点都靠它判「现场是否已被拆过」：
   * `installer.ts` 的 blocked()（不可逆 ⇒ 保持退出意图）与 before-quit 守卫
   * （R3 · Blocker-2：已进入过就不允许二次 runOnce，否则 closeStores 与整盘快照会被跑两遍）。
   */
  progress?(): string[];
  /**
   * 现场是否已被拆过（已进入过 `stopPool` 及其之后的任一步）。契约 I-40：
   * `runOnce()` 自身在拆过之后会抛错拒绝，调用方因此不可能把 §7.7 序列跑第二遍。
   */
  dismantled?(): boolean;
  /** 是否有一次序列正在进行（R4 · Major-1：守卫据此决定等待而不是放行）。 */
  running?(): boolean;
}

/** AppUpdater.downloadUpdate() 解析为「已下载文件路径数组」；兼容单字符串返回。 */
export function firstDownloadedPath(result: unknown): string | null {
  if (typeof result === 'string') return result || null;
  if (Array.isArray(result)) {
    const first = result.find((x) => typeof x === 'string' && x.length > 0);
    return typeof first === 'string' ? first : null;
  }
  const single = (result as { downloadedFile?: unknown } | null)?.downloadedFile;
  return typeof single === 'string' && single ? single : null;
}

export interface UpdateDeps {
  dataDir: string;
  currentVersion: string;                 // app.getVersion()
  resourcesPath: string;                  // process.resourcesPath（app-update.yml 所在）
  logger: LoggerLike;
  audit: AuditLike;
  /** channel 是完整事件名：UPDATE_EVENT_STATE / UPDATE_EVENT_PROGRESS。 */
  sendEvent(channel: string, payload: unknown): void;
  loadSettings(): Promise<AppSettingsLike>;
  saveSettings(patch: Partial<AppSettingsLike>): Promise<void>;
  keyringSecret(): Promise<Buffer>;       // HMAC 密钥（DPAPI）
  rt?: {
    pool: { stopAll(): Promise<void>; activeCount?(): number };
    auditStore: { close(): void };
    chatSessions: { close(): void };
    errors: { close(): void };
    gate: { abortPendingForQuit(reason: string): Promise<number>; listPending?(): unknown[] };
    reviewer: { dispose(): Promise<void> };
    documentParseSupervisor: { beginQuit(): Promise<void> };
  };
  isUpdatingRef?: { value: boolean };
  /** §7.10 闸门输入：有活跃任务 / 离线。缺省按「无活跃任务、在线」处理。 */
  hasActiveWork?(): boolean;
  isNetworkOffline?(): boolean;
  /**
   * §7.10「启动后 90s + 抖动」的基准时刻 = **本进程启动时刻**（可注入以便单测）。
   * 缺省用 `now() - process.uptime()`。绝不能拿 `lastCheckedAt ?? now()` 当基准：
   * 全新安装（从未检查过）时那等于「此刻刚启动」，首次自动检查会被永久推迟（见 I-24）。
   */
  processStartedAt?(): number;
  /**
   * DPAPI 侧的序号下限镜像（§6.3 第 4 条，R2 · B1 的修复面）。
   * 作用只有一个：把「状态文件从未存在」与「用过之后被删掉」区分开——
   * 前者是首装（允许），后者是重放攻击的必要条件（fail closed）。
   * 镜像本身不提供额外信任：它与 update-state.json 的 HMAC 密钥同源于 keyring。
   *
   * ⚠ m2（审核报告 §4）订正：**两个锚点被同时抹掉时，本机无法区分「真首装」与「双删」**，
   * 会按首装放行（`update-bootstrap.ts` 的 raw==null ⇒ null ⇒ 允许），**不会**显式报错。
   * 这是 mirror 机制的固有局限，不是实现缺陷；抗删需要第三个机器级锚点（如服务端
   * per-install 序号下限），作为独立安全加固议题另拍。局限登记见设计 §6.3.4。
   * 重放仍需有效签名 + 未过期的 expiresAt（verifier 侧），且需同用户删两处，边界低。
   */
  seqMirror?: {
    read(): Promise<{ sequence: number; nonce: string; version?: string } | null>;
    write(rec: { sequence: number; nonce: string; version?: string }): Promise<void>;
  };
  /**
   * 「删除已下载的包」的注入缝（R13 · Major-1）。缺省就是 `clearPending`。
   * 之所以做成可注入：本机测不出"rm 真失败"的现场（R13 独立复核也承认持读句柄与 `icacls /deny`
   * 两种方式都没能让删除失败），于是"删不掉却报已清理"这一格若无此缝就无人可钉。
   * 生产路径不传 ⇒ 行为与直接调用 `clearPending` 完全一致。
   */
  removePackage?: (dataDir: string, version: string) => Promise<boolean>;
  quitApp?(): void;
  /**
   * §7.7 关机协议控制器（幂等，由 main/index.ts 构造，见 electron/main/update-bootstrap.ts）。
   * B 关 runInstallTransaction 必须在写哨兵 / 拉起 watchdog 之前 await runOnce()，
   * 以保证「先关库、再快照、再交安装器」的既定顺序（§7.8）。
   */
  shutdownController?: UpdateShutdownController;
  now(): number;                           // 可注入时钟
  // ---- A 关单测 / 装配用的可选注入（不破坏契约 §4 形态） ----
  keys?: PublicKeyMap;                    // 注入离线测试公钥；缺省用编译期 RELEASE_PUBLIC_KEYS
  fetchFn?: typeof fetch;
  updater?: NsisUpdaterLike;              // 注入 updater（单测用 fake，省去真实 electron-updater）
  osBuild?: string;
  freeDiskBytes?: number;
}

export interface UpdateService {
  getAppVersion(): Promise<string>;
  getState(): Promise<UpdateState>;
  checkForUpdate(
    force?: boolean,
    trigger?: 'network' | 'system' | null,
  ): Promise<UpdateActionResult>;
  downloadUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  cancelDownload(): Promise<UpdateActionResult>;
  installUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  clearDownloaded(opts: { version: string }): Promise<UpdateActionResult>;
  deferUpdate(): Promise<UpdateActionResult>;
  skipUpdate(opts: { version: string }): Promise<UpdateActionResult>;
  getSettings(): Promise<UpdateSettingsPublic>;
  saveSettings(partial: UpdateSettingsPatch): Promise<UpdateActionResult>;
  /** §6.6 设置页三入口之一：重置本地 installId（只影响本机抖动/分桶散布，永不出网）。 */
  resetInstallId(): Promise<UpdateActionResult>;
  /** 启动时本地扫描 pending/ + 自检安装结果；零网络。 */
  startupScan(): Promise<void>;
  /** 关机协议（B 关）：A 关恒返回 true（不阻止退出）。 */
  onBeforeQuit(): boolean;
  shutdown(): Promise<void>;
}

let singleton: UpdateService | null = null;

export function hasUpdateService(): boolean {
  return singleton !== null;
}
export function getUpdateService(): UpdateService {
  if (!singleton) throw new Error('UpdateService not initialized');
  return singleton;
}

const ok = (message?: string): UpdateActionResult => ({ ok: true, message });
const bad = (reason: string, message?: string): UpdateActionResult => ({ ok: false, reason, message });

/**
 * `STATE_WRITE_FAILED` 的现场标签（R14 · Major-2）。
 * ⚠ 完整 subreason 必须 ≤32 字符：`audit.ts` 的限流键只接受 `^[A-Z][A-Z0-9_]{0,31}$`，
 * 超长的标签会**退化成空串**，于是两条不同现场共用一把键、后到的那条被静默压掉——
 * 原先用方法名直接拼就踩过这个坑（`..._CHECKFORUPDATE` / `..._RESETINSTALLID` 都是 33 字符）。
 * 标签是有限枚举、只来自本文件，攻击者无法用它构造"每来一次换个键"的刷库通道。
 */
const WRITE_FAILURE_LABELS: Record<string, string> = {
  deferUpdate: 'DEFERUPDATE',
  skipUpdate: 'SKIPUPDATE',
  resetInstallId: 'RESET_ID',
  checkForUpdate: 'CHECK',
  markSuccess: 'MARKSUCCESS',
  markCheck: 'MARKCHECK',
  // 非状态文件的本地 IO 现场（R13 · Major-1）：下载前目录预检、设置落盘、清理已下载的包。
  planDownload: 'PLAN',
  saveSettings: 'SETTINGS',
  clearPending: 'CLEAR',
};

function subreasonWith(prefix: string, method: string): string {
  // R16 · Minor-1：未知方法**不能**统一落到 `_OTHER`。那等于给"新增一个写入口却忘了登记标签"
  // 开一条现成的再入通道——N 条现场共用同一把限流键、后 N-1 条当天被静默压掉，
  // 而这正是 I-66 刚修掉的那件事（我原来的注释还说"测试会拦住"，其实测试遍历的就是这张表，永远拦不住）。
  // 现在：没有登记标签就把方法名本身规范成标签（大写、去非 `[A-Z0-9_]`、按预算截断），
  // 于是每个未登记的入口仍然各占一把键；表的作用退化为"给已知现场一个稳定、可读的短名"。
  const budget = 32 - prefix.length - 1;
  const label = (WRITE_FAILURE_LABELS[method]
    ?? method.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, Math.max(0, budget))).slice(0, Math.max(0, budget));
  if (!label) return prefix;                 // 方法名规范化后为空 ⇒ 退回不带标签，至少不冒充别的现场
  const sub = `${prefix}_${label}`;
  return sub.length <= 32 ? sub : prefix;
}

export function writeFailureSubreason(method: string): string {
  return subreasonWith('STATE_WRITE_FAILED', method);
}

/**
 * 导出的原因：审计限流键只接受 `^[A-Z][A-Z0-9_]{0,31}$`（audit.ts:62），
 * 而 subreason 是这里**现拼**出来的——长度与字符集是两侧耦合，必须能被测试直接钉住（R14 · Major-2）。
 */
export const subreasonForMethod = subreasonWith;
/**
 * 已知现场的稳定短名表（R14 · Major-2）。⚠ I-72① 之后，未登记入口**不再**统一落到 `_OTHER`：
 * `subreasonWith()` 会把方法名规范成受限标签，每个入口各占一把键。此表只给已知现场一个可读短名，
 * 不再是「漏登记就会被测试发现」的守卫（原先那句注释在 I-72① 之后已过时，R15b 复算抓到）。
 */
export const WRITE_FAILURE_METHODS: string[] = Object.keys(WRITE_FAILURE_LABELS);

/** 从已验签 release 构造 RemoteUpdateInfo（summary/highlights 取自 releaseNotes，不用 UpdateInfo）。 */
function remoteFrom(release: import('./types.js').ReleaseJson): RemoteUpdateInfo {
  return {
    version: release.version,
    sequence: release.sequence,
    nonce: release.nonce,
    publishedAt: release.publishedAt,
    expiresAt: release.expiresAt,
    summary: release.releaseNotes?.summary ?? '',
    highlights: [...(release.releaseNotes?.highlights ?? [])],
    bytes: release.artifact.bytes,
    minSupportedVersion: release.minSupportedVersion,
    allowDowngrade: release.allowDowngrade === true,
  };
}

export function initUpdateService(deps: UpdateDeps): UpdateService {
  // 硬断言：autoDownload 恒 false，绝不退化。
  if (AUTO_DOWNLOAD !== false) throw new Error('autoDownload must stay false');

  let storePromise: Promise<UpdateStateStore> | null = null;
  const store = (): Promise<UpdateStateStore> => {
    if (!storePromise) {
      storePromise = deps.keyringSecret().then(
        (secret) => new UpdateStateStore({ dataDir: deps.dataDir, secret, now: () => deps.now() }),
      );
    }
    return storePromise;
  };

  const state: UpdateState = {
    phase: 'idle',
    currentVersion: deps.currentVersion,
    baseUrl: null,
    autoCheck: true,
    lastCheckedAt: null,
    lastSuccessAt: null,
    remote: null,
    local: null,
    progress: null,
    choiceRequired: false,
    errorCode: null,
    stateTampered: false,
    httpWarning: false,
    pendingApprovals: 0,
    activeSessions: 0,
  };

  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  /** §7.10 启动延迟基准：进程启动时刻，装配时算一次，整个生命周期内保持稳定。 */
  const startupBase = (() => {
    if (deps.processStartedAt) return deps.processStartedAt();
    const uptime = (globalThis as { process?: { uptime?(): number } }).process?.uptime?.();
    return deps.now() - (Number.isFinite(uptime) ? Math.floor((uptime as number) * 1000) : 0);
  })();
  let boundUpdater: NsisUpdaterLike | null = null;
  let boundUpdaterKey: string | null = null;   // 'baseUrl|version'，换清单即重建
  const updaterListeners: Array<{ updater: NsisUpdaterLike; event: string; fn: (...a: unknown[]) => void }> = [];
  let lastProgressEmit = 0;
  let activeVersion: string | null = null;
  let activeToken: SimpleCancelToken | null = null;
  /**
   * §6.3 第 4 条：「本次运行拒绝自动更新」是只抬不降的闩锁。
   * 状态文件按镜像重建后 `isTampered()` 会变回 false，若每次都从它重算，
   * Renderer 下一次 getState 就会把告警抹掉并重新放行——正是删档重放想要的效果。
   */
  let tamperLatched = false;

  const emitState = (): void => {
    refreshActivity();
    deps.sendEvent(UPDATE_EVENT_STATE, { ...state });
  };
  /**
   * §7.5「点安装 · 有活跃进程 ⇒ 居中确认」的判定源：待审批提案数与 Pi 池活跃会话数
   * 都在 Main 侧统计（Renderer 只有结构化数据，不参与判定）。
   */
  function refreshActivity(): void {
    state.pendingApprovals = deps.rt?.gate.listPending?.().length ?? 0;
    state.activeSessions = deps.rt?.pool.activeCount?.() ?? 0;
  }
  const setPhase = (phase: UpdatePhase, errorCode: string | null = null): void => {
    state.phase = phase;
    state.errorCode = errorCode;
    emitState();
  };
  const emitProgress = (p: UpdateProgress): void => {
    state.progress = { ...p };
    const now = deps.now();
    if (now - lastProgressEmit >= 200 || p.percent >= 100) {
      lastProgressEmit = now;
      deps.sendEvent(UPDATE_EVENT_PROGRESS, { ...p });
    }
  };

  const auditLike = deps.audit as AuditLike;
  const loggerLike = deps.logger as LoggerLike;

  const settings = async () => resolveUpdateSettings(await deps.loadSettings());

  const scanOpts = (st: UpdateStateStore): ScanOptions => ({
    currentVersion: deps.currentVersion,
    keys: deps.keys,
    lastSeenSequence: st.isTampered() ? Number.MAX_SAFE_INTEGER : st.lastSeenSequence(),
    nonceFor: (seq) => st.nonceFor(seq),
    now: () => deps.now(),
    audit: auditLike,
    logger: loggerLike,
  });

  const verifyOpts = async (): Promise<VerifyOptions> => {
    const s = await settings();
    const st = await store();
    return {
      baseUrl: s.baseUrl,
      now: () => deps.now(),
      currentVersion: deps.currentVersion,
      lastSeenSequence: st.isTampered() ? Number.MAX_SAFE_INTEGER : st.lastSeenSequence(),
      nonceFor: (seq) => st.nonceFor(seq),
      keys: deps.keys,
      fetchFn: deps.fetchFn,
      audit: auditLike,
      logger: loggerLike,
      requestTimeoutMs: s.requestTimeoutMs,
      osBuild: deps.osBuild,
      freeDiskBytes: deps.freeDiskBytes,
    };
  };

  /**
   * §6.3 第 4 条的「缺失即 fail closed」实现处（R2 · B1）。
   * 返回 true 表示本次运行必须拒绝一切自动更新：
   *  - 状态文件不存在，但 DPAPI 镜像里有序号 ⇒ 不是首装，是「下限被抹掉」；
   *    立即按镜像重建文件（好让下次启动恢复正常），但**当前这次运行仍然拒绝**——
   *    被删档之后静默继续更新，正是 §6.3.4 禁止的「回退到默认状态」。
   *  - 状态文件 MAC 合法但序号低于镜像 ⇒ 旧文件被恢复 ⇒ 用镜像强制抬高下限，不拒绝。
   */
  const mirrorSaysStateWasDestroyed = async (st: UpdateStateStore): Promise<boolean> => {
    if (!deps.seqMirror) return false;
    const m = await deps.seqMirror.read();
    if (!m || typeof m.sequence !== 'number' || m.sequence < 0) return false;
    const status = st.fileStatus();
    if (status === 'absent') {
      // 重建：把镜像当作下限写回，并记录一条安全事件（不谎称已放行）。
      // R4 · Minor-3：重建本身是写盘，写失败（只读目录 / EACCES / 磁盘满）绝不能把异常抛出调用方——
      // 那会让 startupScan 整体抛错、装配被打断。写不回去就等于锚点不可信 ⇒ 同样按拒绝处置。
      try {
        await st.enforceFloorFromMirror(m);
      } catch (err) {
        await logUpdateEvent(auditLike, 'update.verify-failed', {
          reason: 'STATE_TAMPERED', subreason: 'STATE_REBUILD_FAILED', detail: `state rebuild failed: ${String(err)}`,
        }, loggerLike);
        return true;
      }
      tamperLatched = true;
      await logUpdateEvent(auditLike, 'update.verify-failed', {
        reason: 'STATE_TAMPERED', subreason: 'STATE_FILE_DELETED', detail: 'state file absent but DPAPI sequence mirror exists',
      }, loggerLike);
      return true;
    }
    if (status === 'ok') {
      try {
        await st.enforceFloorFromMirror(m);
      } catch (err) {
        // 抬不动下限就无从挡住旧清单 ⇒ 本次运行拒绝，而不是带着旧下限继续。
        await logUpdateEvent(auditLike, 'update.verify-failed', {
          reason: 'STATE_TAMPERED', subreason: 'FLOOR_RAISE_FAILED', detail: `floor raise failed: ${String(err)}`,
        }, loggerLike);
        return true;
      }
    }
    return false;
  };

  /**
   * 「本地状态不可信」现场的审计（R8 · Minor-2）：MAC 破坏这条原先在现场被检出时零落痕，
   * 运维手册里的 subreason 枚举因此少一种——事故回溯时无法区分「删档」与「改字节」。
   * 限流由 logUpdateEvent 按「类型 + 天 + reason + subreason」负责，这里不必自带去重。
   */
  const logTamperSite = async (subreason: string, detail: string): Promise<void> => {
    await logUpdateEvent(auditLike, 'update.verify-failed', {
      reason: 'STATE_TAMPERED', subreason, detail,
    }, loggerLike);
  };

  /**
   * 「本次运行拒绝自动更新」的统一出口（§6.3 第 4 条）：抬闩锁 + 错误态 + 结构化拒绝。
   * 审计由各调用点自己写（两条现场的 detail 不同），这里不重复记录。
   */
  const tamperRefusal = (message: string): UpdateActionResult => {
    tamperLatched = true;
    state.stateTampered = true;
    setPhase('error', 'STATE_TAMPERED');
    return bad('STATE_TAMPERED', message);
  };

  /**
   * 状态文件写不回时的统一出口（R7 · N-2）：`EPERM: rename …` 这类原文绝不能原样抛给 IPC
   * ——那会让 UI 直接显示操作系统错误串，且不留审计。
   */
  /**
   * 本地哈希链追加（§7.9 B 关那条"抹痕迹必须同时改这份纯追加文件"）。
   * 与 AuditStore 的分工要说清：**库 = 按类型 + 天限流的摘要视图**（§7.9 防刷库），
   * **链 = 逐次的本地历史**（不受限流影响）。R19 实测"同一天两次真下载库里只有一条"就是这条分工的现场，
   * 所以用户动作产生的生命周期事件（下载开始 / 完成 / 丢弃已下载的包）两边都写。
   * 链写失败绝不改变任何判定（只读盘 / 权限问题时安装与下载仍按原语义走）。
   */
  const chainQuiet = async (event: Record<string, unknown>): Promise<void> => {
    try {
      await appendClientAuditChain(deps.dataDir, event);
    } catch { /* 链不可写不改变任何判定 */ }
  };

  /**
   * 第三态（状态文件位置读不动）的**唯一**结构化出口（R20 · Major / I-81）。
   * 判据只认 `unreadableCode()`，处置恒定：不出网、不写、不删包，报 STATE_WRITE_FAILED（磁盘 / 权限口径），
   * 不抬闩锁。原先只有 `checkForUpdate` / `startupScan` 两处早退，`downloadUpdate` 仍会出网、
   * `installUpdate` 仍会进事务——同一件「已修」的事在其它入口没修，正是本仓反复出现的同型失误，
   * 所以收敛成一处函数，四个入口共用同一判据与同一份留痕字段。
   */
  const refuseUnreadableState = async (method: string, code: string): Promise<UpdateActionResult> => {
    setPhase('error', 'STATE_WRITE_FAILED');
    await logUpdateEvent(auditLike, 'update.failed', {
      reason: 'STATE_WRITE_FAILED', subreason: writeFailureSubreason('unreadable'),
      method, detail: `state path not readable: ${code}`,
    }, loggerLike);
    return bad('STATE_WRITE_FAILED', '本地状态文件现在读不出来（磁盘、权限或被占用），本次动作没有执行；排除故障后会自动恢复');
  };

  const refusalOnWriteFailure = async (method: string, err: unknown): Promise<UpdateActionResult> => {
    // R13 · Major-2：锚点不可信时状态文件是**拒绝被写**（state-store 抛 TamperedStateWriteError），
    // 这与"磁盘/权限导致写不进去"是两件事，必须映射成 STATE_TAMPERED（并抬闩锁），
    // 绝不能与 IO 故障混成同一类 reason——那会让运维把一次人为改动读成一次偶发失败。
    // R18 · Minor-4 / R19 差异 (a)：闩锁已经立着时（本次运行此前真检出过锚点异常）**一律以 STATE_TAMPERED 说话**，
    // 不让一次偶发 IO 失败把界面上的安全定性换成"写失败重试即可"。
    if (err instanceof TamperedStateWriteError || tamperLatched) {
      setPhase('error', 'STATE_TAMPERED');
      tamperLatched = true;
      state.stateTampered = true;
      await logUpdateEvent(auditLike, 'update.verify-failed', {
        reason: 'STATE_TAMPERED', subreason: 'STATE_TAMPERED_WRITE_REFUSED',
        method, detail: String(err),
      }, loggerLike);
      return bad('STATE_TAMPERED', '本地状态不可信，本次操作没有生效；自动更新已停用，重启后按镜像恢复');
    }
    // 状态写不回去时 phase 绝不能停在 checking / available：界面必须看见异常（R8 · Major-1 的伴生现象）。
    setPhase('error', 'STATE_WRITE_FAILED');
    const subreason = writeFailureSubreason(method);
    await logUpdateEvent(auditLike, 'update.failed', {
      reason: 'STATE_WRITE_FAILED', subreason,
      // method 保留原文（只进 payload，不进限流键）⇒ 运维能读出是哪个入口。
      method, detail: String(err),
    }, loggerLike);
    return bad('STATE_WRITE_FAILED', '本地状态写入失败，本次操作没有生效，请稍后重试');
  };

  /**
   * **非状态文件**的本地 IO 失败（R13 · Major-1）：`planDownload` 的目录预检 / `saveSettings` 的落盘
   * 原先是裸 await，`ENOTDIR` / `EPERM` 原文会一路抛穿 IPC 显示到设置面板上（还带绝对路径）。
   * 与 `refusalOnWriteFailure` 分两个 reason：那一条说的是"防降级锚点没写进去"，这一条说的是
   * "本地存储本身不可用"，运维处置动作不同（前者要查有没有人动过 data，后者多半是磁盘 / 权限）。
   */
  const refusalOnIoFailure = async (method: string, err: unknown): Promise<UpdateActionResult> => {
    if (err instanceof TamperedStateWriteError) return await refusalOnWriteFailure(method, err);
    // R18 · Minor-4：同 refusalOnWriteFailure——锚点异常正在被拒的这次运行里，
    // 一次本地 IO 失败不能把界面上的 STATE_TAMPERED 降级成"稍后重试"。
    if (tamperLatched) return await refusalOnWriteFailure(method, err);
    setPhase('error', 'LOCAL_STORAGE_FAILED');
    await logUpdateEvent(auditLike, 'update.failed', {
      reason: 'LOCAL_STORAGE_FAILED', subreason: subreasonWith('LOCAL_STORAGE_FAILED', method),
      method, detail: String(err),
    }, loggerLike);
    return bad('LOCAL_STORAGE_FAILED', '本地存储不可用（目录不可写或被占用），本次操作没有生效');
  };

  /**
   * 检查失败支路上的 markCheck（R8 · Major-1）：写不回时**不能**把 EPERM 抛给调用方——那会让
   * 界面显示操作系统错误串并泄漏路径，也会让调度器把它误记成 NETWORK 计入降级；但也不能静默：
   * 这里留一条审计并把 phase 拨成可见异常，同时原样返回本次检查真正的失败原因。
   *
   * 返回值 = 「这次是锚点不可信导致的拒绝写」（true）还是单纯磁盘 IO 写不回（false）。
   * ⚠ R18 · Major-1 / R19 · Major-1：原先这里**无条件**抬 `tamperLatched`，于是
   * 「磁盘满 / 杀软占用 update-state.json + 更新源不可达」这种纯运维现场会被报成
   * `STATE_TAMPERED`（"本地状态不可信"），并让整次运行停止自愈——而同样的 IO 失败在成功支路上
   * 走 `refusalOnWriteFailure` 时**不抬闩锁**。两条支路对同一事件给了两种安全定性，
   * 我原来给这条差异编的理由（"连失败计数都存不了就说明锚点不可信"）站不住：计数存不了只说明磁盘不可用。
   */
  const markCheckLogged = async (st: UpdateStateStore): Promise<boolean> => {
    try {
      await st.markCheck(deps.now());
      return false;
    } catch (err) {
      // 同一区分原则：锚点不可信 ⇒ verify-failed / STATE_TAMPERED（并抬闩锁）；
      // 单纯写不进去 ⇒ failed / STATE_WRITE_FAILED（**不抬闩锁**，故障消失后同实例即可恢复）。
      const tampered = err instanceof TamperedStateWriteError;
      await logUpdateEvent(auditLike, tampered ? 'update.verify-failed' : 'update.failed', {
        reason: tampered ? 'STATE_TAMPERED' : 'STATE_WRITE_FAILED',
        subreason: tampered ? 'STATE_TAMPERED_WRITE_REFUSED' : writeFailureSubreason('markCheck'),
        method: 'checkForUpdate.markCheck', detail: String(err),
      }, loggerLike);
      if (tampered) {
        tamperLatched = true;
        state.stateTampered = true;
      }
      return tampered;
    }
  };

  /**
   * 「不可信」现场分两类留痕（R19 · 差异 (c)）：
   * 字节被改（MAC / 形态不符）⇒ `STATE_MAC_BROKEN`；位置根本读不动（`EISDIR` / `EPERM` / `ENOTDIR`）
   * ⇒ `STATE_UNREADABLE`。运维处置动作不同：前者按"被人动过"查，后者按"磁盘 / 权限 / 占用"查。
   */
  const tamperSubreasonOf = (st: UpdateStateStore): string =>
    st.unreadableCode() ? 'STATE_UNREADABLE' : 'STATE_MAC_BROKEN';

  const refreshTiming = async (st: UpdateStateStore): Promise<void> => {
    const p = await st.read();
    state.lastCheckedAt = p.lastCheckedAt;
    state.lastSuccessAt = p.lastSuccessAt;
    if (st.isTampered()) tamperLatched = true;
    state.stateTampered = tamperLatched;
  };

  /**
   * §5.2 定案 A 的 updater 建立 / 复用：
   * 写本地派生 feed → createUpdater（先注入 httpExecutor 再 setFeedURL）→ checkForUpdates()
   * → 逐字段二次比对（§6.5）。同一 baseUrl + 版本 + sequence 复用同一实例，
   * 因为 AppUpdater.downloadUpdate() 依赖上一次 checkForUpdates() 留下的 updateInfoAndProvider。
   */
  const checkedUpdater = async (
    baseUrl: string,
    release: import('./types.js').ReleaseJson,
    yml: string,
  ): Promise<NsisUpdaterLike> => {
    const key = `${baseUrl}|${release.version}|${release.sequence}`;
    if (boundUpdater && boundUpdaterKey === key) return boundUpdater;

    const feedUrl = await writeDerivedFeed(deps.dataDir, yml);
    const { updater } = createUpdater({
      dataDir: deps.dataDir,
      feedUrl,
      baseUrl,
      release,
      updater: deps.updater,
      fetchFn: deps.fetchFn,
      audit: auditLike,
      logger: loggerLike,
      now: () => deps.now(),
      requestTimeoutMs: (await settings()).requestTimeoutMs,
    });

    const onAvailable = (info: unknown): void => {
      const cross = crossCheckUpdateInfo(info, release);
      if (!cross.ok) deps.logger.warn(`update-available crossCheck failed: ${cross.reason}`);
    };
    const onProgressEvent = (info: unknown): void => {
      // 兼容两套字段名：executor 直接给的 UpdateProgress，与 updater 转发的 ProgressInfo。
      const p = info as {
        percent?: number; transferred?: number; total?: number;
        bytesDownloaded?: number; bytesTotal?: number;
      };
      const bytesDownloaded = Number(p.transferred ?? p.bytesDownloaded ?? 0);
      const bytesTotal = Number(p.total ?? p.bytesTotal ?? release.artifact.bytes);
      const percent = Number.isFinite(Number(p.percent))
        ? Math.max(0, Math.min(100, Math.floor(Number(p.percent))))
        : (bytesTotal > 0 ? Math.min(100, Math.floor((bytesDownloaded / bytesTotal) * 100)) : 0);
      emitProgress({
        percent,
        bytesDownloaded,
        bytesTotal,
        savePath: state.progress?.savePath ?? null,
      });
    };
    updater.on('update-available', onAvailable as (...a: unknown[]) => void);
    updater.on('download-progress', onProgressEvent as (...a: unknown[]) => void);
    updaterListeners.push(
      { updater, event: 'update-available', fn: onAvailable as (...a: unknown[]) => void },
      { updater, event: 'download-progress', fn: onProgressEvent as (...a: unknown[]) => void },
    );

    // 换实例时解除旧实例监听，避免重复回调与泄漏。
    if (boundUpdater && boundUpdater !== updater) {
      const stale = updaterListeners.filter((l) => l.updater === boundUpdater);
      for (const l of stale) boundUpdater?.removeListener?.(l.event, l.fn);
    }
    boundUpdater = updater;
    boundUpdaterKey = key;

    const checked = await updater.checkForUpdates() as { updateInfo?: unknown } | null;
    const cross = crossCheckUpdateInfo(checked?.updateInfo ?? checked, release);
    if (!cross.ok) {
      deps.logger.warn(`checkForUpdate crossCheck failed: ${cross.reason}`);
      throw new Error(`updateInfo crossCheck failed: ${cross.reason}`);
    }
    return updater;
  };

  const service: UpdateService = {
    async getAppVersion() {
      return deps.currentVersion;
    },

    async getState() {
      const s = await settings();
      const st = await store();
      await refreshTiming(st);
      refreshActivity();
      state.currentVersion = deps.currentVersion;
      state.baseUrl = s.baseUrl || null;
      state.autoCheck = s.autoCheck;
      state.httpWarning = s.isHttp;
      return { ...state };
    },

    async getSettings() {
      const s = await settings();
      // autoDownload 恒 false 的显式断言。
      if (s.autoDownload !== false) throw new Error('autoDownload must stay false');
      return {
        baseUrl: s.baseUrl,
        autoCheck: s.autoCheck,
        checkIntervalHours: s.checkIntervalHours,
        checkOnStartup: s.checkOnStartup,
        startupDelaySeconds: s.startupDelaySeconds,
        checkOnNetworkResume: s.checkOnNetworkResume,
        checkOnSystemResume: s.checkOnSystemResume,
        remindIntervalHours: s.remindIntervalHours,
        requestTimeoutMs: s.requestTimeoutMs,
        autoDownload: AUTO_DOWNLOAD,
        isHttp: s.isHttp,
      } satisfies UpdateSettingsPublic;
    },

    async saveSettings(partial) {
      const current = await deps.loadSettings();
      const existing = (current.update ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...existing };
      // 待落盘成功后才写的 baseUrl 留痕（R19 · Major-3）
      let pendingBaseUrlAudit: { isHttp: boolean } | null = null;
      const KNOWN: Array<keyof UpdateSettingsPatch> = [
        'autoCheck', 'checkIntervalHours', 'checkOnStartup', 'startupDelaySeconds',
        'checkOnNetworkResume', 'checkOnSystemResume', 'remindIntervalHours', 'requestTimeoutMs',
      ];
      for (const k of KNOWN) {
        if (partial[k] !== undefined) next[k] = partial[k];
      }
      if (partial.baseUrl !== undefined) {
        let normalized: string;
        if (partial.baseUrl === '') {
          normalized = ''; // 留空 = 关闭自动检查
        } else {
          const n = normalizeBaseUrl(partial.baseUrl);
          if (!n.ok) return bad('INVALID_BASE_URL', '更新源地址非法');
          normalized = n.url;
        }
        const changed = normalized !== (typeof existing.baseUrl === 'string' ? existing.baseUrl : '');
        next.baseUrl = normalized;
        // 留痕**延后到落盘成功之后**（R19 · Major-3）：原先在这里就写 `BASE_URL_CHANGED`，
        // 于是 `settings.json` 写失败时审计声称"源已变更"而盘上还是旧源 ⇒ 审计比事实多说话。
        // 二次确认仍由 UI 层 G5 负责，服务端只做严格校验 + 如实留痕。
        if (changed) pendingBaseUrlAudit = { isHttp: normalized.startsWith('http://') };
      }
      // 设置落盘同样是裸 await（R13 · Major-1）：`settings.json` 所在目录只读 / 被占用时
      // EPERM 原文会经 IPC 直接渲染到设置面板。这里换成结构化拒绝，UI 至少能看懂"没保存成功"。
      try {
        await deps.saveSettings({ ...current, update: next });
      } catch (err) {
        return await refusalOnIoFailure('saveSettings', err);
      }
      // ⚠ 必须走 logUpdateEvent，不能裸调 deps.audit.append（R16 · Major-1：后者绕开 try/catch，
      // 盘满 / audit.db 被占用时把 EPERM 原文抛穿 IPC，还带绝对路径）。
      // subreason 不能省：这两类留痕的 `reason` 都是空 ⇒ 不分开就会共用同一把限流键，
      // 同一天"改了源"与"重置了检查标识"只剩一条（I-66 那一课的第三次发生，这次是我自己刚写下的）。
      if (pendingBaseUrlAudit) {
        await logUpdateEvent(auditLike, 'update.settings-changed', {
          reason: 'SETTINGS_CHANGED', subreason: 'BASE_URL_CHANGED',
          isHttp: pendingBaseUrlAudit.isHttp,
        }, loggerLike);
      }
      const s = await settings();
      state.baseUrl = s.baseUrl || null;
      state.autoCheck = s.autoCheck;
      state.httpWarning = s.isHttp;
      emitState();
      return ok();
    },

    async resetInstallId() {
      const st = await store();
      if (st.isTampered()) return bad('STATE_TAMPERED', '本地状态损坏，自动更新已停用');
      let next: string;
      try {
        next = await st.regenerateInstallId();
      } catch (err) { return await refusalOnWriteFailure('resetInstallId', err); }
      // §6.6：重置必须留痕，并说明它会影响分桶（installId 本身永不出网）。
      // ⚠ R16 · Major-1b：这里原先也是裸 `deps.audit.append`。除了原文抛穿之外还有一个更细的问题——
      // `regenerateInstallId()` 此刻**已经落盘**，审计写失败不回滚它，于是现场是"真的换了 id、只是没留痕"。
      // 不假装它是原子操作（那需要两阶段写），改为走 logUpdateEvent 吞异常 + 镜像日志，
      // 并让返回文案如实说明"已生效"；缺留痕这件事由 logger 那一行负责被发现。
      await logUpdateEvent(auditLike, 'update.settings-changed', {
        reason: 'SETTINGS_CHANGED', subreason: 'INSTALL_ID_RESET',
        installIdReset: true, affectsBucketing: true,
      }, loggerLike);
      await logUpdateEvent(auditLike, 'update.cleanup', { reason: 'INSTALL_ID_RESET' }, loggerLike);
      return ok(`已重置本地检查标识（仅影响本机检查时间的散布，不改变版本判定）：${next.slice(0, 8)}…`);
    },

    async checkForUpdate(force, trigger) {
      // R7 · N-3：闩锁一旦立起，本次运行的**检查**本身也不得出网、也不得再报「发现新版本」。
      // 缺这一条时，删档被检出并按镜像重建之后，同一次运行里的调度器补检 / 用户手动检查会恢复出网，
      // 与 §6.3.4「本次运行一律拒绝自动更新」自相矛盾（download / install 在 I-46 已经拒）。
      if (tamperLatched) return tamperRefusal('本次运行此前已检出本地状态异常，自动更新保持停用；重启后按镜像恢复');
      const st = await store();
      if (st.isTampered()) {
        await logTamperSite(tamperSubreasonOf(st), st.unreadableCode()
          ? `state path is not a readable file: ${st.unreadableCode()}`
          : 'state file exists but fails MAC / shape check');
        return tamperRefusal('本地状态损坏，自动更新已停用');
      }
      // R19 · 差异 (c) + R18 · Major-1 的折中：位置读不动（`EISDIR` / `EPERM` / `ENOTDIR`）是**第三态**。
      // 既不能当成 absent（否则"占住路径"就等于"删档"，删档重放防护当场失效），
      // 也不能当成 tampered（那是把磁盘 / 权限故障报成"被人动过"）。
      // 处置统一走 `refuseUnreadableState()`（I-81）：不出网、不写、不删包、不抬闩锁；
      // I-80 之后 store 会在第三态重读，故障消失后同实例即可恢复。
      if (st.unreadableCode()) return refuseUnreadableState('checkForUpdate', st.unreadableCode()!);
      // §6.3 第 4 条：状态文件被抹掉（DPAPI 镜像仍在）同样按「损坏」处置，
      // 绝不回退到「无下限」的默认状态——那会让 sequence 回退与同 sequence 换 nonce 失效。
      if (await mirrorSaysStateWasDestroyed(st)) {
        return tamperRefusal('本地状态记录缺失，本次运行已停用自动更新；重启后按镜像恢复');
      }
      const s = await settings();
      const p = await st.read();
      if (!force) {
        const gate = shouldCheck({
          autoCheck: s.autoCheck,
          baseUrl: s.baseUrl,
          now: deps.now(),
          lastCheckedAt: p.lastCheckedAt,
          lastSuccessAt: p.lastSuccessAt,
          failureCount: p.failureCount,
          deferredUntil: p.deferredUntil,
          startupAt: startupBase,
          startupDelaySeconds: s.startupDelaySeconds,
          checkIntervalHours: s.checkIntervalHours,
          // 抖动由本地 installId 派生（永不出网），幅度限制在 ±9s 的小窗口。
          jitterSeconds: jitterDelay(p.installId || deps.currentVersion, 60) - 60,
          // §7.10 第三类触发源：网络 / 系统恢复补检（闸门内仍要求距上次 >1h）。
          resumeTrigger: trigger ?? null,
          // §7.10 闸门①「活跃任务推迟 15min」与末条「网络离线不发请求」。
          activeWork: deps.hasActiveWork?.() === true,
          networkOffline: deps.isNetworkOffline?.() === true,
        });
        if (!gate.ok) return bad(gate.reason);
      }
      if (!s.baseUrl) return bad('NO_BASE_URL', '未配置更新源');

      setPhase('checking');
      const vo = await fetchAndVerify(await verifyOpts());
      if (!vo.ok) {
        // R18 · Major-1：只有"锚点不可信导致 store 拒写"才升级为 STATE_TAMPERED；
        // 磁盘满 / 占用这类写不回仍是原本的验证原因 + STATE_WRITE_FAILED 审计，不抬闩锁、下次仍能自愈。
        if (await markCheckLogged(st)) {
          await refreshTiming(st);
          return tamperRefusal('本地状态不可信，本次运行已停用自动更新；重启后按镜像恢复');
        }
        await refreshTiming(st);
        setPhase('error', vo.reason);
        await logUpdateEvent(auditLike, 'update.check-failed', { reason: vo.reason }, loggerLike);
        return bad(vo.reason);
      }
      const derived = deriveLatestYml(vo.release, s.baseUrl);
      if (!derived.ok) {
        if (await markCheckLogged(st)) {
          await refreshTiming(st);
          return tamperRefusal('本地状态不可信，本次运行已停用自动更新；重启后按镜像恢复');
        }
        await refreshTiming(st);
        setPhase('error', derived.reason);
        return bad(derived.reason);
      }

      // §5.2 定案 A：写本地派生 feed → 注入自定义 executor（先于 setFeedURL）→ updater.checkForUpdates()。
      // updater 链路是 §6.5 的「二次保险」：它读的元数据就是本地派生 feed，比对不等即 fail closed，
      // 绝不带着不一致的元数据进入下载。
      try {
        await checkedUpdater(s.baseUrl, vo.release, derived.yml);
      } catch (err) {
        if (await markCheckLogged(st)) {
          await refreshTiming(st);
          return tamperRefusal('本地状态不可信，本次运行已停用自动更新；重启后按镜像恢复');
        }
        await refreshTiming(st);
        if (isUpdaterUnavailable(err)) {
          // 环境缺件（如打包未带上 electron-updater）：如实报「未就绪」，不伪装成投毒信号。
          deps.logger.warn(String(err));
          setPhase('error', 'NOT_READY');
          return bad('NOT_READY', '更新组件不可用，请检查安装完整性');
        }
        setPhase('error', 'ARTIFACT_INVALID');
        await logUpdateEvent(auditLike, 'update.verify-failed', {
          reason: 'UPDATER_CHANNEL_FAILED', detail: String(err),
        }, loggerLike);
        return bad('ARTIFACT_INVALID', '更新元数据二次比对失败');
      }

      // 成功路径上的三连写（下限 / 镜像 / 成功时间）任何一处抛错都必须走结构化拒绝：
      // 只读目录、磁盘满、杀软占用、同用户改 ACL 都会让 rename 抛 EPERM（R8 · Major-1）。
      // 三段处理不同，因为现场含义不同：镜像写失败 = 锚点不可信 ⇒ 拒绝本次运行（I-44）；
      // 下限或成功时间写不回 = 本地状态没落盘 ⇒ 结构化拒绝 + 审计，绝不把 IO 原文抛穿 IPC。
      try {
        await st.recordSeen(vo.release.sequence, vo.release.nonce, vo.release.version);
      } catch (err) {
        return await refusalOnWriteFailure('checkForUpdate', err);
      }
      // 下限同步进 DPAPI 镜像：删掉 update-state.json 不再能把序号清零。
      // 写失败**绝不能静默放过**（I-44）：镜像是「首装 vs 被删档」的唯一锚点，同用户只要把
      // keyring 目录设成只读，就能让镜像恒为空，从而把删档攻击伪装成首次装机。
      try {
        await deps.seqMirror?.write({
          sequence: vo.release.sequence, nonce: vo.release.nonce, version: vo.release.version,
        });
      } catch (err) {
        await markCheckLogged(st);
        await refreshTiming(st);
        await logUpdateEvent(auditLike, 'update.verify-failed', {
          reason: 'STATE_TAMPERED', subreason: 'MIRROR_WRITE_FAILED', detail: `seq mirror write failed: ${String(err)}`,
        }, loggerLike);
        return tamperRefusal('本地防回退锚点无法写入，本次运行已停用自动更新');
      }
      try {
        await st.markSuccess(deps.now());
      } catch (err) {
        return await refusalOnWriteFailure('markSuccess', err);
      }
      await refreshTiming(st);
      state.remote = remoteFrom(vo.release);
      state.baseUrl = s.baseUrl || null;
      state.httpWarning = s.isHttp;
      // 合并本地 pending 与远端，判定二选一。
      const locals = await scanPending(deps.dataDir, scanOpts(st));
      state.local = pickBestLocal(locals, deps.currentVersion);
      const d = decide({
        currentVersion: deps.currentVersion,
        remoteVerified: state.remote,
        localValid: state.local,
        skippedVersions: p.skippedVersions,
        deferredUntil: p.deferredUntil,
        now: deps.now(),
      });
      state.choiceRequired = d.choiceRequired;
      if (!state.remote) {
        setPhase(d.local ? 'readyToInstall' : 'idle');
        return ok('已是最新版本');
      }
      setPhase('available');
      await logUpdateEvent(auditLike, 'update.available', {
        version: state.remote.version, sequence: state.remote.sequence,
      }, loggerLike);
      return ok(`发现新版本 ${state.remote.version}`);
    },

    async downloadUpdate({ version }) {
      // 拒绝要一致（I-46）：本次运行已因锚点不可用而停用自动更新时，手动点「下载」不得绕过这道门。
      if (tamperLatched) return bad('STATE_TAMPERED', '本地防回退锚点不可用，本次运行已停用自动更新');
      // I-81：第三态下**不得出网**。原先只有 checkForUpdate 早退，点「下载」仍会跑完 4 条元数据请求，
      // 而 §6.3 第 4 条的现场根本不具备可信下限 ⇒ 动作必须在任何网络请求之前被拒。
      const stUnreadable = (await store()).unreadableCode();
      if (stUnreadable) return refuseUnreadableState('downloadUpdate', stUnreadable);
      // 验签门禁①：downloadUpdate 必须重跑 fetchAndVerify，不通过一律拒绝。
      if (typeof version !== 'string' || !isSafeVersion(version)) {
        return bad('POINTER_INVALID', '版本号形态非法');
      }
      const vo = await fetchAndVerify(await verifyOpts());
      if (!vo.ok) {
        setPhase('error', vo.reason);
        return bad(vo.reason);
      }
      if (vo.release.version !== version) {
        return bad('POINTER_INVALID', '版本与清单不一致');
      }
      const s = await settings();
      if (!s.baseUrl) return bad('NO_BASE_URL');

      const derived = deriveLatestYml(vo.release, s.baseUrl);
      if (!derived.ok) return bad(derived.reason);

      setPhase('downloading');
      activeVersion = version;
      await logUpdateEvent(auditLike, 'update.download-start', { version }, loggerLike);
      // R19 · Major-2：AuditStore 那侧按「类型 + 天」限流（设计 §7.9 原文，防 MITM 刷库，本期不放宽），
      // 于是同一天第二次、第三次真实下载在库里与第一次长得一样、看起来"只发生过一次"。
      // 逐次历史改由**本地哈希链**承担：这三类事件都是用户动作 + 已验签清单才可能产生
      // （服务端喂垃圾清单喂不出 download-start），不属于可被刷的路径，进链是安全的。
      await chainQuiet({ action: 'update.download-start', version, sequence: vo.release.sequence });

      // 磁盘预检要建 pending 目录、要 statfs ⇒ 目录被占用 / 只读时这里就会抛（R13 · Major-1：
      // 原先它在下面那个大 try **之外**，ENOTDIR 原文直接抛穿 IPC）。
      let plan: Awaited<ReturnType<typeof planDownload>>;
      try {
        plan = await planDownload({
          dataDir: deps.dataDir,
          release: vo.release,
          freeDiskBytes: deps.freeDiskBytes,
        });
      } catch (err) {
        return await refusalOnIoFailure('planDownload', err);
      }
      if (!plan.ok) {
        setPhase('available', plan.reason ?? 'REQUIRES_UNMET');
        return bad(plan.reason ?? 'REQUIRES_UNMET');
      }

      const token = makeCancellationToken();
      activeToken = token;
      try {
        // §5.2 定案 A / D5：包体下载走 updater 的 downloadUpdate()，
        // 由注入的自定义 httpExecutor 执行真实网络（host/port/scheme 锁定 + 字节上限 + sha512 终检）。
        // updater 需要先 checkForUpdates() 才能拿到 updateInfoAndProvider。
        await writeDerivedFeed(deps.dataDir, derived.yml);
        const updater = await checkedUpdater(s.baseUrl, vo.release, derived.yml);
        const files = await updater.downloadUpdate(token as never);
        const cachedFilePath = firstDownloadedPath(files);
        if (!cachedFilePath) {
          throw new Error('updater.downloadUpdate() returned no artifact path');
        }
        activeToken = null;
        const finalized = await finalizeDownload({
          dataDir: deps.dataDir,
          plan,
          cachedFilePath,                     // updater 缓存中的成品（executor 已终检）
          releaseBytes: vo.releaseBytes,
          releaseSigText: vo.releaseSigText,
          channelBytes: vo.channelBytes,
          channelSigText: vo.channelSigText,
          audit: auditLike,
          logger: loggerLike,
        });
        if (!finalized.ok) {
          state.progress = null;
          setPhase('available', finalized.reason);
          return bad(finalized.reason);
        }

        // 下载完成 → readyToInstall，local 信息来自已验签 release（不重新扫描 / 不重新下载）。
        state.local = {
          version: vo.release.version,
          sequence: vo.release.sequence,
          nonce: vo.release.nonce,
          artifactPath: finalized.artifactPath,
          bytes: vo.release.artifact.bytes,
          sha512: vo.release.artifact.sha512,
          expiresAt: vo.release.expiresAt,
          valid: true,
        };
        state.progress = null;
        setPhase('readyToInstall');
        await logUpdateEvent(auditLike, 'update.download-complete', { version }, loggerLike);
        await chainQuiet({
          action: 'update.download-complete', version, sequence: vo.release.sequence,
          packageSha512: vo.release.artifact.sha512.slice(0, 16),
        });
        return ok(`版本 ${version} 已下载，可安装`);
      } catch (err) {
        const cancelled = token.cancelled;
        activeToken = null;
        await cancelDownloadFiles(deps.dataDir, version);
        state.progress = null;
        if (!cancelled && isUpdaterUnavailable(err)) {
          setPhase('available', 'NOT_READY');
          return bad('NOT_READY', '更新组件不可用，请检查安装完整性');
        }
        setPhase('available', cancelled ? null : 'DOWNLOAD_FAILED');
        if (!cancelled) {
          await logUpdateEvent(auditLike, 'update.failed', { reason: 'DOWNLOAD_FAILED' }, loggerLike);
          return bad('DOWNLOAD_FAILED', `下载失败：${String(err)}`);
        }
        return bad('DOWNLOAD_FAILED', '下载已取消');
      }
    },

    async cancelDownload() {
      // R22 · Maj-2 的第六个出口：第三态下连 .part 也不动，且不许把早退设的
      // STATE_WRITE_FAILED 洗成 available。与其余出口同口径，统一早退。
      const stUnreadable = (await store()).unreadableCode();
      if (stUnreadable) return refuseUnreadableState('cancelDownload', stUnreadable);
      // 先中止进行中的下载（executor 收到取消即删除 .part），再清残留临时文件。
      activeToken?.cancel();
      if (activeVersion) await cancelDownloadFiles(deps.dataDir, activeVersion);
      activeVersion = null;
      state.progress = null;
      // 回到 available（不丢已完成的包：cancelDownload 只清 .part）。
      // R7 · M-4：但本次运行已因锚点异常拒绝时，不能借「取消」把 errorCode 洗掉。
      if (tamperLatched) { setPhase('error', 'STATE_TAMPERED'); return ok(); }
      setPhase(state.local ? 'readyToInstall' : 'available');
      return ok();
    },

    async installUpdate({ version }) {
      // 同 I-46：锚点不可信的本次运行里，安装入口也不放行（磁盘上的旧包仍在，重启后可再试）。
      if (tamperLatched) return bad('STATE_TAMPERED', '本地防回退锚点不可用，本次运行已停用自动更新');
      if (typeof version !== 'string' || !isSafeVersion(version)) {
        return bad('POINTER_INVALID', '版本号形态非法');
      }
      // I-81：第三态下不得进入安装事务（下限不可信时本就不该发起动作；与下载共用同一道门）。
      const st = await store();
      if (st.unreadableCode()) return refuseUnreadableState('installUpdate', st.unreadableCode()!);
      // 验签门禁②：installUpdate 必须重跑本地伴生清单校验（零网络），不通过一律拒绝。
      const verdict = await verifyCompanion(
        pendingVersionDir(deps.dataDir, version),
        scanOpts(st),
      );
      if (!verdict.ok) {
        setPhase('error', verdict.reason);
        return bad(verdict.reason);
      }
      // §7.7 步骤 1：进入安装即置 isUpdating，before-quit 钩子据此不再 preventDefault。
      if (deps.isUpdatingRef) deps.isUpdatingRef.value = true;
      // installer.ts 是真实事务（快照 + 哨兵 + 分离的 watchdog）；失败按可逆 / 不可二分岔（I-33）。
      // deps 带上关机协议控制器与退出通道（§7.7：先跑完序列，再写哨兵 / 拉起 watchdog）。
      const result = await runInstallTransaction({
        dataDir: deps.dataDir,
        currentVersion: deps.currentVersion,
        targetVersion: version,
        artifactPath: join(pendingVersionDir(deps.dataDir, version), verdict.release.artifact.name),
        packageSha512: verdict.release.artifact.sha512,
        resourcePath: deps.resourcesPath,
        appId: 'com.sparkii.desktop',
        now: () => deps.now(),
      }, {
        now: () => deps.now(),
        logger: loggerLike,
        quitApp: () => deps.quitApp?.(),
        isUpdatingRef: deps.isUpdatingRef,
        shutdownController: deps.shutdownController,
        rt: deps.rt,
        release: verdict.release,
        channel: verdict.channel,
        // R16 · Major-2：这里原先没传 `audit` ⇒ `installer.ts` 的 `auditOf()` 恒为 undefined，
        // 事务内部的 `update.install-start` 等事件在生产里**一条都不落库**，
        // 而既有用例走的是注入缝（`verifyStartupWith` / 直接调事务并传 audit），所以测试一直是绿的。
        // 这就是"测试断的是缝、生产走的是包装器"——本仓第四种绿勾假象的新变体。
        audit: auditLike,
      });
      if (!result.ok) {
        // I-83（R20 · Major）：用户点安装失败的**本次运行**原先既不进库也不进链，
        // 只有下次启动读哨兵才可能补一条 ⇒ 事故现场拿不到时间线。这里与 startupScan 一样两边都写；
        // subreason 是有限枚举（≤32 且过限流键判据），不引入可被刷库的维度。
        await logUpdateEvent(auditLike, 'update.failed', {
          reason: 'INSTALL_FAILED',
          subreason: result.quitRequested === true ? 'INSTALL_QUIT_REQUESTED' : 'INSTALL_NOT_READY',
          targetVersion: version, detail: result.reason ?? 'INSTALL_BLOCKED',
        }, loggerLike);
        await chainQuiet({
          action: 'update.failed', reason: 'INSTALL_FAILED', stage: 'service-install',
          targetVersion: version, detail: result.reason ?? 'INSTALL_BLOCKED',
        });
        // R1 · B-1：事务已经跑过关机序列 ⇒ 现场不可逆，安装事务已请求退出。
        // 这里不能谎报「回到可安装」，也不能撤销 isUpdating（撤销会让守卫以为还在准备安装）。
        if (result.quitRequested === true) {
          setPhase('restarting', 'INSTALL_FAILED');
          return bad('INSTALL_FAILED', '安装准备失败，应用即将退出；数据与已下载的包都已保留，重启后可再试');
        }
        if (deps.isUpdatingRef) deps.isUpdatingRef.value = false; // 事务未启动，恢复普通退出语义
        setPhase('readyToInstall', result.reason ?? 'INSTALL_BLOCKED');
        return bad(result.reason ?? 'INSTALL_BLOCKED', '安装尚未就绪');
      }
      // `update.install-start` 由事务内部（`installer.ts`）带 txnId + sequence 写，这里不再重复发一条：
      // 两条事件的限流键相同（同 action、reason 都空），留着只会让第二条被静默压掉（I-66 同一课）。
      setPhase('installing');
      return ok();
    },

    async clearDownloaded({ version }) {
      // R22 · Maj-2：第三态的「不删包」必须覆盖到这个出口。它不调 store()、不进事务，
      // 却是全门面唯一会删 pending/<version> 整目录的动作；原先四处早退没把它收编，
      // 于是在第三态里删包、写链写库，还在 :1155 把 refuseUnreadableState 刚设的
      // STATE_WRITE_FAILED 洗成 idle/available ⇒ 界面与判定脱节。统一走同一个出口。
      const stUnreadable = (await store()).unreadableCode();
      if (stUnreadable) return refuseUnreadableState('clearDownloaded', stUnreadable);
      // clearPending 本身对非法段是空操作，但这里必须给出结构化的拒绝理由，
      // 不能把一次越界请求伪装成「已清理成功」。
      if (!isSafeVersion(version)) return bad('POINTER_INVALID', '版本号形态非法');
      // R13 · Major-1：删不掉（权限 / 占用）时同样绝不能报"已清理"——那会让界面把 local 清空、
      // 而盘上那套包还在，用户以为已经腾出空间、下次扫描又会把它认成可安装。
      if (!await (deps.removePackage ?? clearPending)(deps.dataDir, version)) {
        // I-82（R20 · Major / R21 · Minor-2）：清理失败是 LOCAL_STORAGE_FAILED，但**界面上的安全定性**
        // 不能被它洗掉——闩锁在场时一律以 STATE_TAMPERED 说话（与 I-74 的两个 refusal 出口同口径）。
        // 动作本身的 reason 仍如实报 LOCAL_STORAGE_FAILED，审计也照记，不把两类语义混成一句。
        setPhase('error', tamperLatched ? 'STATE_TAMPERED' : 'LOCAL_STORAGE_FAILED');
        if (tamperLatched) state.stateTampered = true;
        await logUpdateEvent(auditLike, 'update.failed', {
          reason: 'LOCAL_STORAGE_FAILED', subreason: subreasonWith('LOCAL_STORAGE_FAILED', 'clearPending'),
          method: 'clearDownloaded', version,
        }, loggerLike);
        return bad('LOCAL_STORAGE_FAILED', '本地存储不可用（目录不可写或被占用），这次没有清理成功');
      }
      if (state.local?.version === version) state.local = null;
      state.progress = null;
      // 逐次历史进链（R19 · Major-2 的分工：库限流、链不限流），两个出口都写、只写一次。
      await chainQuiet({ action: 'update.cleanup', scope: 'clearDownloaded', version });
      // R16 · Major-4（R7 · M-4 的第二个入口）：清理本身是成功的，但**不能借这次成功把
      // `errorCode=STATE_TAMPERED` 洗成 idle** —— 本次运行仍在拒检查 / 下载 / 安装，
      // 界面却看不出异常，用户只剩下"点检查更新没反应"。清理照做，状态保持可见。
      if (tamperLatched) {
        state.stateTampered = true;
        setPhase('error', 'STATE_TAMPERED');
        await logUpdateEvent(auditLike, 'update.cleanup', { version }, loggerLike);
        return ok();
      }
      setPhase(state.remote ? 'available' : 'idle');
      await logUpdateEvent(auditLike, 'update.cleanup', { version }, loggerLike);
      return ok();
    },

    async deferUpdate() {
      const st = await store();
      const s = await settings();
      try {
        await st.defer(deps.now() + s.remindIntervalHours * 3_600_000);
      } catch (err) { return await refusalOnWriteFailure('deferUpdate', err); }
      await refreshTiming(st);
      return ok();
    },

    async skipUpdate({ version }) {
      const st = await store();
      try {
        await st.skip(version);
      } catch (err) { return await refusalOnWriteFailure('skipUpdate', err); }
      if (state.remote?.version === version) state.remote = null;
      state.choiceRequired = false;
      emitState();
      return ok();
    },

    async startupScan() {
      // 零网络：仅扫描 pending/ 伴生清单 + 自检安装结果，绝不发任何网络请求。
      // §7.9 客户端审计链的**运行时消费方**（R13 指出 `verifyAuditChain` 此前只有测试在调，
      // 于是"同用户进程抹痕迹可被检出"只是纸面能力）。这里在任何提前返回之前核一次链：
      // 断链只留一条审计 + 一条日志，**不改变更新判定** —— 链覆盖的是本机审计历史，
      // 而"整段截断/替换"防不住（那需要服务端锚点，§8.3 / P2），本机没有第二个可比副本，
      // 把它升级成拒绝更新等于把一个可观测的取证信号换成一个无法自证的门。
      try {
        const chain = await verifyAuditChain(deps.dataDir);
        if (!chain.ok) {
          await logUpdateEvent(auditLike, 'update.verify-failed', {
            reason: 'AUDIT_CHAIN_BROKEN', subreason: 'AUDIT_CHAIN_BROKEN',
            brokenAtSeq: chain.brokenAtSeq ?? null, count: chain.count,
            detail: chain.message ?? chain.reason,
          }, loggerLike);
        }
      } catch (err) {
        // startupScan 在 index.ts 的装配链上：任何异常都不许把启动打断（R4 · Minor-3 同一条约束）。
        deps.logger.warn(`[update] 审计链自检异常（忽略，不影响装配）：${String(err)}`);
      }
      const st = await store();
      // 先判「下限是否被人抹掉」，再决定要不要拿它去删坏包：
      // 下限不可信时 scanPending 会把合法包判成坏包删掉，那是二次伤害。
      const destroyed = await mirrorSaysStateWasDestroyed(st);
      const p = await st.read();
      // R16 · Major-3：**下限不可信有两种现场**——文件被删（destroyed）与文件被改字节（isTampered）。
      // 原先只在 destroyed 时跳过扫描，于是 mac 被改一格的那次启动里 `scanOpts` 把下限顶到
      // MAX_SAFE_INTEGER ⇒ 已下载且验签通过的合法包被判成 SEQUENCE_REGRESSION 并**被 rm 掉**。
      // 那与我自己在上一行写的"二次伤害"直接矛盾，且是产品级数据丢失（用户只剩"重新下载"这一条路）。
      const floorUntrusted = destroyed || st.isTampered() || st.unreadableCode() != null;
      const locals = floorUntrusted ? [] : await scanPending(deps.dataDir, scanOpts(st));
      // 只有"被人动过"那两类现场抬 tamper 闩锁；读不动（EISDIR/EPERM…）是磁盘 / 权限现场，
      // 抬闩锁会把它误报成"状态不可信"并让整次运行停用（R18 · Major-1 / R19 · Major-1 明令区分）。
      if (destroyed || st.isTampered()) tamperLatched = true;
      // 启动扫描是本进程里 MAC 破坏的第一个现场；不在这里落痕，运维就只能等第一次检查出网才看到。
      if (st.isTampered()) {
        await logTamperSite(tamperSubreasonOf(st), st.unreadableCode()
          ? `state path is not a readable file at startup scan: ${st.unreadableCode()}`
          : 'state file fails MAC / shape check at startup scan');
      }
      state.stateTampered = tamperLatched;
      state.lastCheckedAt = p.lastCheckedAt;
      state.lastSuccessAt = p.lastSuccessAt;
      state.currentVersion = deps.currentVersion;
      state.local = pickBestLocal(locals, deps.currentVersion);
      state.remote = null;
      state.choiceRequired = false;
      const s = await settings();
      state.baseUrl = s.baseUrl || null;
      state.autoCheck = s.autoCheck;
      state.httpWarning = s.isHttp;
      // B 关 installer.ts：读哨兵 + install-result + 当前版本，判上次安装是否成功。
      // ⚠ R16 · Major-2：必须走 `verifyStartupWith` 并把 audit / logger 传进去。
      // 之前用的是 arity-2 的生产包装 `verifyStartup(...)`，它写死 `opts = {}` ⇒
      // §7.7 / §7.9 要求的 `update.completed`、保留策略的 `update.cleanup` 在生产里**一条都不进 AuditStore**，
      // 而既有那条"写 update.completed 与 update.cleanup 审计"的用例走的是 `verifyStartupWith(..., {audit})` 这条缝
      // ⇒ 测试断的是缝、生产走的是包装器，全仓看不出差别。
      const verdict = await verifyStartupWith(deps.dataDir, deps.currentVersion, {
        audit: auditLike, logger: loggerLike,
      });
      if (state.stateTampered) {
        setPhase('error', 'STATE_TAMPERED');
        return;
      }
      // R19 · 差异 (c)：状态位置读不动时这次启动不做任何更新动作，也**不能安静地走过去**
      // （原先这一格是 phase=idle + 零留痕，运维事后完全看不出发生过什么）。
      if (st.unreadableCode()) {
        // I-81：与 check / download / install 共用同一出口，避免四个入口各自抄一份判据和留痕字段。
        await refuseUnreadableState('startupScan', st.unreadableCode()!);
        return;
      }
      // §7.5「重启后：成功不打扰；失败给明确提示 + 重试入口」。
      // 判据只认 installer.ts 的 verdict.pending / verdict.ok，不在这里重新推断现场。
      if (verdict.pending === true && verdict.ok !== true) {
        state.remote = null;
        setPhase('error', 'INSTALL_FAILED');
        // R19 · 差异 (c)：上次安装失败（含"结果文件读不动 / 不属于本事务"这一格）原先只改界面上的 phase，
        // 库里零留痕 ⇒ 运维只能从设置页的红色文字反推，事故后拿不到时间线。
        // 这是本地因果事件（服务端喂不出来），所以同时进链，不受库侧「类型 + 天」限流影响。
        await logUpdateEvent(auditLike, 'update.failed', {
          reason: 'INSTALL_FAILED', subreason: verdict.reason ? String(verdict.reason).replace(/[^A-Z0-9_]/g, '').slice(0, 24) || 'INSTALL_FAILED' : 'INSTALL_FAILED',
          txnId: verdict.txnId, targetVersion: verdict.targetVersion, detail: verdict.message ?? '',
        }, loggerLike);
        await chainQuiet({
          action: 'update.failed', reason: 'INSTALL_FAILED', txnId: verdict.txnId,
          targetVersion: verdict.targetVersion,
        });
        return;
      }
      if (verdict.pending === true && verdict.ok === true) {
        // 安装事务刚收尾（成功）：不打扰用户，但要让保留策略有明确的当前版本。
        setPhase('completed');
        return;
      }
      setPhase(state.local ? 'readyToInstall' : 'idle');
    },

    onBeforeQuit() {
      // 普通退出（非更新）一律放行；更新退出必须等 §7.7 关机序列跑完才允许真正 quit。
      if (!deps.isUpdatingRef?.value) return true;
      if (!deps.shutdownController) return true;
      return deps.shutdownController.hasRun();
    },

    async shutdown() {
      if (scheduleTimer) {
        clearTimeout(scheduleTimer);
        scheduleTimer = null;
      }
      // 进行中的下载先取消（executor 收到取消即删 .part），再解绑监听。
      activeToken?.cancel();
      activeToken = null;
      for (const l of updaterListeners) {
        l.updater.removeListener?.(l.event, l.fn);
      }
      updaterListeners.length = 0;
      boundUpdater = null;
      boundUpdaterKey = null;
      activeVersion = null;
    },
  };

  singleton = service;
  return service;
}

/**
 * 从若干本地可安装版本中挑版本号最高者。
 * 必须排除「版本 == 当前运行版本」的那一份：§7.9 保留策略刻意留下当前版本包作为
 * 恢复 / 人工重装的介质，而 D13 的「可安装」是从 pending/ 扫描推导的 ——
 * 不加这条过滤，升级成功后状态栏会永久挂着「已下载完，可以安装 0.3.0」，
 * 而用户运行的正是 0.3.0。包仍在盘上，只是不再被显示成待办动作。
 */
/** 导出供单测直接钉「同版本构建元数据」这一格（I-85）；生产调用面不变。 */
export function pickBestLocal(locals: LocalUpdateInfo[], currentVersion: string): LocalUpdateInfo | null {
  // I-85（R20 域3）：原先这里用**字符串相等**排除同版本，而下方破平用 `compareVersions`
  // （只比三段数字，`0.3.0` 与 `0.3.0+build.2` 判等）⇒ 两处口径分叉：运行 0.3.0 时会把
  // 0.3.0+build.2 显示成「可安装新版本」，与本函数上方注释的意图直接冲突。
  // 统一到同一个比较函数：判等即排除；构建元数据合法（I-56），但不属于「新版本」。
  const usable = locals.filter((l) => compareVersions(l.version, currentVersion) !== 0);
  if (usable.length === 0) return null;
  // R16 · Minor-3 的残余：`compareVersions` 只比三段数字，于是 `0.3.0` 与 `0.3.0+build.2` **判等**；
  // 光统一实现还不够——平手时原来取决于 `readdir` 顺序（同一台机器两次启动可能显示不同的包）。
  // 现在显式按已验签的 `sequence` 破平（sequence 是清单里的单调量，比版本字符串更权威），
  // 再由 artifactPath 收尾，保证结果与目录枚举顺序无关。
  return usable.reduce((best, cur) => {
    const c = compareVersions(cur.version, best.version);
    if (c > 0) return cur;
    if (c < 0) return best;
    if (cur.sequence > best.sequence) return cur;
    if (cur.sequence < best.sequence) return best;
    return cur.artifactPath > best.artifactPath ? cur : best;
  }, usable[0]);
}
