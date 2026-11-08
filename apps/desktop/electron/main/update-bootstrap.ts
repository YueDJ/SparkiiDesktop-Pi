/**
 * 自动升级的主进程装配层（设计稿 §7.7 / §7.10，接口契约 §4 / §5.1 / §8）。
 *
 * 本模块是 main/index.ts 与 update/* 之间唯一的胶水：
 *  - resolveUpdateHmacKey()：§6.3 第 4 条的 HMAC 密钥（DPAPI keyring），拿不到即抛错 ⇒ 调用方不装配更新（fail closed）。
 *  - createShutdownController()：把 §7.7 的严格顺序包成幂等的 runOnce()，供 before-quit 兜底与 B 关安装事务复用。
 *  - createUpdateQuitGuard()：before-quit 守卫（isUpdating 标志 + 序列未完成则 preventDefault）。
 *  - startUpdateScheduling()：§7.10 的四类触发源 + 周期 + 退避 + 「连续不可用降级为仅手动」。
 *
 * 不 import electron：所有 Electron 对象（powerMonitor / net / app）以结构化参数注入，
 * 因此本文件可在 jsdom 单测里零 Electron 依赖地跑完整状态机。
 */

import { randomBytes } from 'node:crypto';
import { logUpdateEvent } from './update/audit.js';
import { ACTIVE_WORK_DEFER_MS, jitterDelay } from './update/scheduler.js';
import type { UpdateService, UpdateShutdownController } from './update/service.js';
import { resolveUpdateSettings, type AppSettingsLike } from './update/config.js';
import { runShutdownSequence, type ShutdownHooks, type ShutdownStep } from './shutdown.js';

/** DPAPI keyring 中更新 HMAC 密钥的名字（§6.3 第 4 条：lastSeenSequence / nonce 绑定的 HMAC）。 */
/**
 * keyring 名里**不能有冒号**：`Keyring.file()` 拼的是 `${name}.enc`，而 Windows 把 `update:hmacKey.enc`
 * 解析成「基名 `update` 的备用数据流（ADS）`hmacKey.enc`」——本机读写照样成功，但目录里只看得见一个
 * 0 字节的 `update`，于是任何不保留流的复制 / 压缩 / 快照（含 §7.8 的整 data\ 一致性快照）都会把它丢掉。
 * 实测证据见审核记录 §1.4 第 10 条。
 */
export const UPDATE_HMAC_KEY_NAME = 'update-hmacKey';
const HMAC_KEY_RE = /^[0-9a-f]{64}$/i;

export interface KeyringLike {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

/**
 * 取（或首次生成并落盘）HMAC 密钥。
 * 读不回、写不进（如 safeStorage 不可用）一律抛错：调用方据此**不装配更新服务**，
 * 绝不用「内存随机密钥」凑合——那会让每次启动的状态都对不上，等于悄悄放行。
 */
export async function resolveUpdateHmacKey(keyring: KeyringLike): Promise<Buffer> {
  const existing = await keyring.get(UPDATE_HMAC_KEY_NAME);
  if (typeof existing === 'string' && HMAC_KEY_RE.test(existing)) {
    return Buffer.from(existing, 'hex');
  }
  const fresh = randomBytes(32).toString('hex');
  await keyring.set(UPDATE_HMAC_KEY_NAME, fresh);
  const readback = await keyring.get(UPDATE_HMAC_KEY_NAME);
  if (readback !== fresh) throw new Error('update HMAC key could not be persisted in the keyring');
  return Buffer.from(fresh, 'hex');
}

/**
 * §7.9「`update.verify-failed` 同时镜像到 errors 只读展示」的落点。
 * 放在装配层而不是验签内核：只有这里同时握有 audit 与 errors 两个 store，
 * 也让 update/* 保持「只写 AuditStore」的单一职责（限流由 update/audit.ts 负责，镜像因此天然不刷屏）。
 */
export interface AuditAppendRecord {
  actor: string;
  action: string;
  resource?: string;
  decision?: string;
  payloadSummary?: string;
}

export function createUpdateAuditSink(
  audit: { append(rec: AuditAppendRecord): Promise<unknown> },
  errors: { append(rec: { id: string; message: string; source: string; createdAt: number }): unknown } | undefined,
  now: () => number = () => Date.now(),
): { append(rec: AuditAppendRecord): Promise<unknown> } {
  return {
    async append(rec) {
      await audit.append(rec);
      if (rec.action === 'update.verify-failed' && errors) {
        const createdAt = now();
        let reason = '';
        try {
          reason = String((JSON.parse(rec.payloadSummary ?? '{}') as { reason?: unknown }).reason ?? '');
        } catch {
          reason = '';
        }
        // 只镜像可读事实，不写包内容 / 地址之外的信息；id 唯一，避免 INSERT OR IGNORE 吞掉后续事件。
        // ⚠ R18 · Major-2：这一段必须自己吞异常。`errors.append` 是同步的 `db.prepare().run`（errors.db 坏 / 锁 / 满会抛），
        // 而它跑在 `audit.append` **之后**——一旦抛出，`logUpdateEvent` 会把这次当成"没留痕"而不记限流键（I-65 的语义），
        // 于是同一条现场当天会被反复重新提交到审计库：限流（§7.9 的防刷库手段）在这种复合故障下被整个旁路。
        // 审计行此刻已经落库，是既成事实；镜像只是一个只读展示副本，它的失败不许回头改留痕语义。
        try {
          errors.append({
            id: `update-verify-failed-${createdAt}`,
            message: `更新清单验签失败${reason ? `（${reason}）` : ''}，已按「无更新」处理。`,
            source: 'update',
            createdAt,
          });
        } catch { /* 镜像失败不回滚审计，也不影响限流键 */ }
      }
      return undefined;
    },
  };
}

export interface ShutdownControllerOptions {  /** 每步完成时的回调（B 关写哨兵进度 / 单测断言顺序）。 */
  onStep?(step: ShutdownStep): void;
  onError?(err: unknown): void;
}

/**
 * 把 Runtime 的真实句柄包成 §7.7 的 ShutdownHooks（`main/index.ts` 装配用）。
 * 放在装配层而不是散在调用点：顺序由 `shutdown.ts` 写死，这里只负责「每一步接谁」。
 */
export interface ShutdownRtHandles {
  pool: { stopAll(): Promise<void> };
  audit: { append(rec: AuditAppendRecord): Promise<unknown>; close(): void };
  chatSessions: { close(): void };
  errors: { close(): void };
  gate: { abortPendingForQuit(reason: string): Promise<number> };
  reviewer: { dispose(): Promise<void> };
  documentParseSupervisor: { beginQuit(): Promise<void> };
}

export interface ShutdownHookOptions {
  /** update.* 事件的审计出口（限流由 update/audit.ts 负责）。 */
  audit: { append(rec: AuditAppendRecord): Promise<unknown> };
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** 快照实现注入点：生产传 `update/installer.js` 的 snapshotDataDir，单测传假实现。 */
  snapshot(
    dataDir: string,
    txnId: string,
    excludeRel: string[],
  ): Promise<{ ok: boolean; reason?: string }>;
  now?(): number;
}

export function createShutdownHooks(
  rt: ShutdownRtHandles,
  dataDir: string,
  opts: ShutdownHookOptions,
): ShutdownHooks {
  const now = opts.now ?? (() => Date.now());
  return {
    // ① 审批门 pending 提案显式过期并留痕；未清空前不得进入安装（§7.7 步骤 2）。
    //    gate 自己写的是 proposal.expired；这里再按 §7.9 的 update.* 口径补一条，
    //    否则「哪些待审批项被安装动作放弃」在更新事件流里根本查不到。
    abortPendingApprovals: async (reason) => {
      const aborted = await rt.gate.abortPendingForQuit(reason);
      if (aborted > 0) {
        await logUpdateEvent(opts.audit, 'update.install-abort', { aborted, reason }, opts.logger);
      }
      return aborted;
    },
    // ② 复用既有 stopAll()（§0.7 P0-1：不新造 stop()）；stopped 闸门拒绝任何新 acquire()。
    stopPool: async () => { await rt.pool.stopAll(); },
    stopDocumentParse: async () => { await rt.documentParseSupervisor.beginQuit(); },
    disposeReviewer: async () => { await rt.reviewer.dispose(); },
    // ⑤ 固定顺序 audit → chatSessions → errors，让 WAL 各自 checkpoint 后再交还文件系统。
    closeStores: async () => {
      rt.audit.close();
      rt.chatSessions.close();
      rt.errors.close();
    },
    // ⑥ 整 data\ 一致性快照必须在关库之后。快照非成功 ⇒ 抛错中止（绝不带着未快照的现场进入安装）；
    //    占位语义 INSTALL_BLOCKED 视为「本轮不做快照」而跳过（A 关路径）。
    snapshotData: async () => {
      const res = await opts.snapshot(dataDir, `shutdown-${now()}`, ['updates']);
      if (res.ok || res.reason === 'INSTALL_BLOCKED') return;
      throw new Error(`data snapshot failed: ${res.reason ?? 'unknown'}`);
    },
    now,
  };
}

/**
 * DPAPI keyring 中「序号下限镜像」的名字（§6.3 第 4 条的判别锚）。
 * 同样禁止冒号，理由见 UPDATE_HMAC_KEY_NAME 上方（Windows ADS）。
 */
export const SEQ_MIRROR_KEY_NAME = 'update-seqMirror';

export interface SeqMirrorRecord {
  sequence: number;
  nonce: string;
  version?: string;
}

/** 镜像内容不可解析时的毒化记录：sequence 顶到上限 ⇒ 任何清单都过不了下限闸门。 */
const CORRUPT_MIRROR: SeqMirrorRecord = { sequence: Number.MAX_SAFE_INTEGER, nonce: 'CORRUPT_MIRROR' };

/**
 * DPAPI 侧的 sequence/nonce 下限镜像（R2 · B1 的修复面）。
 *
 * 它**不是**第二份权威状态，也从不用于放宽判定，只回答一个问题：
 * `update-state.json` 的缺失到底是「首次装机」还是「被人删过」。
 *   镜像为空 + 文件缺失 ⇒ 首次装机 ⇒ 允许（无历史可重放）。
 *   镜像有序号 + 文件缺失 ⇒ 下限被抹 ⇒ 本次运行拒绝自动更新（§6.3.4「不得回退默认状态」）。
 *   镜像读出来不可解析 ⇒ 按毒化处理（宁可停摆，也不静默降级）。
 */
export function createSeqMirror(keyring: KeyringLike): {
  read(): Promise<SeqMirrorRecord | null>;
  write(rec: SeqMirrorRecord): Promise<void>;
} {
  return {
    async read() {
      const raw = await keyring.get(SEQ_MIRROR_KEY_NAME);
      if (raw == null || raw === '') return null;
      try {
        const parsed = JSON.parse(raw) as Partial<SeqMirrorRecord>;
        if (typeof parsed?.sequence !== 'number' || !Number.isInteger(parsed.sequence) ||
            parsed.sequence < 0 || typeof parsed.nonce !== 'string') {
          return CORRUPT_MIRROR;
        }
        return {
          sequence: parsed.sequence,
          nonce: parsed.nonce,
          version: typeof parsed.version === 'string' ? parsed.version : undefined,
        };
      } catch {
        return CORRUPT_MIRROR;
      }
    },
    async write(rec) {
      await keyring.set(SEQ_MIRROR_KEY_NAME, JSON.stringify(rec));
    },
  };
}

/**
 * 幂等的关机序列控制器（§7.7 步骤 2–5 + 整 data\ 快照）。
 * runOnce() 并发/重入只跑一遍（共享同一个 inFlight）。失败**不提供 reset**：
 * 序列一旦进入过拆机步骤，本进程就不允许再跑第二遍（R4 · Minor-2：
 * 曾经有个 reset() 会把 entered 记忆清空，等于自己造一个绕过 I-40 的把手，已删除）。
 */
export function createShutdownController(
  hooks: ShutdownHooks,
  opts: ShutdownControllerOptions = {},
): UpdateShutdownController & {
  steps(): ShutdownStep[];
  progress(): string[];
  dismantled(): boolean;
  running(): boolean;
} {
  let inFlight: Promise<ShutdownStep[]> | null = null;
  let done: ShutdownStep[] | null = null;
  /**
   * 已进入（未必完成）的步骤名。R1 · B-1 需要它：序列半途失败时，调用方无法从
   * 「成功返回的 steps」推断出已经拆掉了什么，只能靠**进入顺序**判断现场是否已不可逆
   * （stopPool / closeStores 一旦进入，应用就不可能继续正常服务）。
   */
  const entered: string[] = [];
  const tracked: ShutdownHooks = {
    abortPendingApprovals: (reason) => { entered.push('abortPendingApprovals'); return hooks.abortPendingApprovals(reason); },
    stopPool: () => { entered.push('stopPool'); return hooks.stopPool(); },
    stopDocumentParse: () => { entered.push('stopDocumentParse'); return hooks.stopDocumentParse(); },
    disposeReviewer: () => { entered.push('disposeReviewer'); return hooks.disposeReviewer(); },
    closeStores: () => { entered.push('closeStores'); return hooks.closeStores(); },
    snapshotData: () => { entered.push('snapshotData'); return hooks.snapshotData(); },
    now: () => hooks.now(),
  };
  /**
   * 除「审批门显式过期」之外的每一步都算**拆掉运行态**（§7.7 单向性）。
   * 拆过之后再进来的 runOnce 必须拒绝：第二次 `pool.stopAll()` / `closeStores()` /
   * 整盘快照是在已经关库、已经停池的躯体上再拆一遍（R3 · Blocker-2 堵住了 before-quit
   * 这一扇门，用户立刻再点一次「安装」是另一扇门 —— 见契约 I-40）。
   */
  const isDismantleStep = (name: string): boolean => name !== 'abortPendingApprovals';
  const controller = {
    hasRun(): boolean { return done != null; },
    steps(): ShutdownStep[] { return done ?? []; },
    progress(): string[] { return [...entered]; },
    /** 是否有一次序列**正在进行**（R4 · Major-1：守卫必须区分「进行中」与「试过但失败」）。 */
    running(): boolean { return inFlight != null; },
    dismantled(): boolean { return entered.some(isDismantleStep); },
    async runOnce(): Promise<ShutdownStep[]> {
      if (done) return done;
      if (inFlight) return inFlight;
      if (controller.dismantled()) {
        // 不重跑、也不静默返回成功：抛错让调用方走 blocked() 的不可逆分支（保持退出意图）。
        throw new Error('shutdown sequence already dismantled (entered: ' + entered.join(' → ') + '); refusing to re-run');
      }
      inFlight = runShutdownSequence(tracked).then(
        (list) => {
          for (const step of list) opts.onStep?.(step);
          done = list;
          inFlight = null;
          return list;
        },
        (err) => {
          inFlight = null;
          opts.onError?.(err);
          throw err;
        },
      );
      return inFlight;
    },
  };
  return controller;
}

export interface QuitGuardApp {
  quit(): void;
}

export interface QuitGuardOptions {
  service: Pick<UpdateService, 'onBeforeQuit'>;
  controller: UpdateShutdownController;
  app: QuitGuardApp;
  isUpdatingRef: { value: boolean };
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** 事件对象形态（Electron BeforeQuitEvent 的结构子集）。 */
}

/**
 * before-quit 守卫（§7.7 步骤 1 / 契约 §4 onBeforeQuit）。
 * 返回 false ⇒ preventDefault，先把 §7.7 序列跑完再真正退出；
 * 序列失败 ⇒ 撤销 isUpdating（回到普通退出语义）后照样退出：数据完整性与日常退出一致，
 * 但绝不带着未关的库 / 未停的进程进入安装（安装侧由 runInstallTransaction 的 reject 拦住）。
 */
export function createUpdateQuitGuard(o: QuitGuardOptions): (e: { preventDefault(): void }) => void {
  // ⚠ 这里**不做**「quit() 只请求一次」的去重（I-47② 原先加了 `quitRequested` 闩锁，R7 · N-1 实测出死区）：
  // 第一次 quit() 被守卫自己 preventDefault 掉时闩锁已经立死，之后序列重跑成功也没人再请求退出
  // ⇒ 进程带着已关闭的库常驻，正是 I-33 禁止的半关机僵尸态。
  // 不去重是安全的：`app.quit()` 可重入，重复调用只会再派一次 before-quit，
  // 而守卫的两个前置判断（序列已完成 / 现场已拆过）会让那一次直接放行。
  const requestQuit = (): void => { try { o.app.quit(); } catch { /* 退出失败由 index.ts 的兜底负责 */ } };
  return (e) => {
    if (!o.isUpdatingRef.value) return;              // 普通退出：完全不干预既有语义
    if (o.service.onBeforeQuit()) return;            // 序列已完成：放行
    const running = typeof o.controller.running === 'function' ? o.controller.running() : false;
    if (running) {
      // R4 · Major-1：序列**正在进行**时到来的第二次退出事件，绝不能直接放行。
      // 上一次修复用 `progress().length > 0` 一刀切，把「进行中」也当成「已失败」放走，
      // 于是主进程可以在 stopPool / closeStores 做到一半时被终止 ⇒ Pi 子进程残留、库不 checkpoint。
      // 这里改为照常 preventDefault 并挂到同一次 runOnce 上：runOnce 内部共享 inFlight，
      // 不会拆第二遍，退出一定发生在整个序列结束之后。
      e.preventDefault();
      void o.controller.runOnce().then(
        () => { requestQuit(); },
        (err) => {
          o.logger.error(`update shutdown failed while quitting: ${String(err)}`);
          // 与主分支同口径：没拆过现场就退回普通退出语义，让下一次 before-quit 能重跑一趟；
          // 拆过就保持 isUpdating，由上面「已拆机 ⇒ 放行不重跑」那支负责。
          if (!(typeof o.controller.dismantled === 'function' && o.controller.dismantled())) {
            o.isUpdatingRef.value = false;
          }
          requestQuit();
        },
      );
      return;
    }
    const dismantled = typeof o.controller.dismantled === 'function' ? o.controller.dismantled() : false;
    if (dismantled) {
      // 试过、没跑完，而且现场已拆（与 installer 侧 `blocked()` 同一条判据）：
      // 不重跑（I-40 的拒绝照样生效），也不撤销 isUpdating ⇒ 放行退出，恢复入口交给哨兵与下次启动。
      const entered = typeof o.controller.progress === 'function' ? o.controller.progress() : [];
      o.logger.warn(`update shutdown already attempted [${entered.join(' → ')}]; quitting without re-running`);
      return;
    }
    e.preventDefault();
    void o.controller.runOnce().then(
      () => { requestQuit(); },
      (err) => {
        o.logger.error(`update shutdown failed: ${String(err)}`);
        o.isUpdatingRef.value = false;
        requestQuit();
      },
    );
  };
}

export interface PowerMonitorLike {
  on(name: 'resume' | 'unlock-screen', cb: () => void): void;
  removeListener?(name: 'resume' | 'unlock-screen', cb: () => void): void;
}

export interface NetLike {
  readonly online: boolean;
}

export interface SchedulingOptions {
  service: Pick<UpdateService, 'checkForUpdate'>;
  settings(): Promise<AppSettingsLike>;
  now(): number;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** §7.10 活跃任务判定（Pi 池有会话 / 有待审批提案）。 */
  hasActiveWork?(): boolean;
  /** §7.10 离线判定（注入 Electron net.online）；缺省按在线。 */
  net?: NetLike;
  powerMonitor?: PowerMonitorLike;
  /** 本地抖动种子（永不出网）；缺省用 'sparkii-update'。 */
  jitterSeed?: string;
  /** 测试可注入的定时器实现；缺省用全局 setTimeout/clearTimeout。 */
  setTimer?(ms: number, fn: () => void): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * 这些 reason 是「闸门抑制 / 本次动作根本没执行」，不计入连续不可用。
 * I-84（R20 · Major）：`STATE_WRITE_FAILED` 是 I-74/I-75 承诺「故障消失后同实例即恢复」的现场——状态文件
 * 位置读不动时 `checkForUpdate` 在出网之前就早退并回报该 reason，它经调度层的 `afterOutcome()` 进入本集合
 * ⇒ 复位 streak、排 15min 闸门心跳，故障修好之后不会仍要等最多 24h、第 7 轮更不会整进程不再排期。
 * ⚠ R22 · Maj-5：`LOCAL_STORAGE_FAILED` 在生产上**只**由 IPC 用户动作（`saveSettings` / `planDownload` /
 * `clearDownloaded`）回报，而 `afterOutcome()` 的唯一调用方 `tick()` 只跑 `checkForUpdate`——后者永不返回
 * 该 reason ⇒ 它从未真正进入本集合，属于「冗余抑制项」：既无承重用例、又让 I-84 契约「这两类被计入」的口径
 * 失真。故只保留真正可达的 `STATE_WRITE_FAILED`，使集合每一项都承重。`STATE_TAMPERED`（by-design 拒绝、
 * 需重启）**仍计入不可用**，R18 · Minor-3 的 warn 归因问题维持登记不改：只排除可自愈那一类，不把「拒绝」
 * 与「不可用」混起来。
 */
const GATE_SUPPRESSED = new Set([
  'DISABLED', 'NO_BASE_URL', 'DEFERRED', 'TOO_SOON', 'MANUAL_ONLY', 'BACKOFF', 'NETWORK_OFFLINE',
  'STARTUP_DELAY', 'STATE_WRITE_FAILED',
]);

/**
 * §7.10：连续 **7 天**真实不可用后降级为「仅手动」（停止自动排期，手动检查仍可用）。
 * m6：原本按「连续 7 轮」计数，而退避六档累计只有约 1.6–2.7 天（取决于从哪一档起算），
 * 与设计要求的 7 天口径不符。现在按**累计不可用时长**判定：从第一次真实不可用起计时，
 * 期间任何一次成功 / 闸门抑制（故障自愈）都会清零。
 */
export const UNAVAILABLE_DOWNGRADE_MS = 7 * 24 * 3_600_000;

/**
 * 真实不可用时的退避档（§7.10：30s → 5min → 30min → 2h → 24h）。
 * 取 6 档：最后一档是 24h 的兜底；降级改由 UNAVAILABLE_DOWNGRADE_MS 判定，
 * 不再与档位数绑定。
 */
const UNAVAILABLE_BACKOFF_MS = [30_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000];

/** 闸门抑制时的兜底心跳（不联网，只重算闸门）。 */
const GATE_HEARTBEAT_MS = 15 * 60_000;
/**
 * 闸门启动窗口的抖动**上界**（秒，加性）。
 * service.ts 的闸门是 `startupDelaySeconds + (jitterDelay(id,60)-60)`，
 * 后者 ∈ [-9,+9]s —— 是**加性**偏移，不是乘法比例。故闸门真正的最迟放行时刻
 * = startupDelaySeconds + 9s（不是 ×1.15）。
 */
export const STARTUP_GATE_JITTER_BOUND_SEC = 9;
/** 排到闸门上界之后的余量（秒）：避免同毫秒计时与闸门比较的边界竞争。 */
export const STARTUP_GATE_MARGIN_SEC = 1;
/** 网络状态边沿检测的轮询间隔（net 模块没有 online 事件）。 */
const NETWORK_POLL_MS = 60_000;

export interface SchedulingHandle {
  stop(): void;
  /** 立即触发一次带闸门的检查（设置变更后 / 测试用）。 */
  tickNow(trigger?: 'network' | 'system'): void;
}

/**
 * §7.10 自动检查调度：四类触发源（启动延迟 + 递归周期 + 恢复补检 + 手动由 UI 走 IPC，不在此处），
 * 统一经 service.checkForUpdate(false) 的闸门，任何抑制都不会产生网络请求。
 */
export function startUpdateScheduling(o: SchedulingOptions): SchedulingHandle {
  const setTimer = o.setTimer ?? ((ms: number, fn: () => void) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => { clearTimeout(h as ReturnType<typeof setTimeout>); });
  const seed = o.jitterSeed ?? 'sparkii-update';

  let stopped = false;
  let timer: unknown = null;
  let poll: unknown = null;
  let unavailableStreak = 0;
  /** 本轮连续不可用的起点（epoch ms）；成功 / 闸门抑制时清零（m6：按累计时长判定降级）。 */
  let unavailableSince: number | null = null;
  let running = false;
  let lastOnline = o.net?.online ?? true;
  const resumeHandlers: Array<{ name: 'resume' | 'unlock-screen'; cb: () => void }> = [];

  const clearAll = (): void => {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (poll != null) { clearTimer(poll); poll = null; }
    for (const h of resumeHandlers) {
      try { o.powerMonitor?.removeListener?.(h.name, h.cb); } catch { /* 忽略解绑失败 */ }
    }
    resumeHandlers.length = 0;
  };

  const schedule = (ms: number): void => {
    if (stopped || !Number.isFinite(ms) || ms < 0) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(Math.floor(ms), () => { timer = null; void tick(); });
  };

  const periodMs = (checkIntervalHours: number, jitterSeconds: number): number =>
    checkIntervalHours * 3_600_000 + jitterSeconds * 1000;

  const afterOutcome = async (result: { ok: boolean; reason?: string }): Promise<void> => {
    const settings = resolveUpdateSettings(await o.settings());
    if (settings.checkIntervalHours <= 0) return; // 0 = 仅手动：不再自动排期
    const jitterSeconds = jitterDelay(seed, 3600) - 3600; // ±15% 的 1h 幅度（周期级散布）
    if (result.ok) {
      unavailableStreak = 0;
      unavailableSince = null;
      schedule(periodMs(settings.checkIntervalHours, jitterSeconds));
      return;
    }
    if (result.reason === 'ACTIVE_WORK') {
      schedule(ACTIVE_WORK_DEFER_MS);            // §7.10：活跃任务推迟 15min
      return;
    }
    if (result.reason == null || GATE_SUPPRESSED.has(result.reason)) {
      unavailableStreak = 0;
      unavailableSince = null;
      schedule(GATE_HEARTBEAT_MS);
      return;
    }
    unavailableStreak += 1;
    // m6：累计不可用时长 ≥ 7 天 ⇒ 降级为仅手动（不是"7 轮"）。
    if (unavailableSince === null) unavailableSince = o.now();
    if (o.now() - unavailableSince >= UNAVAILABLE_DOWNGRADE_MS) {
      o.logger.warn('update checks unavailable for 7 days; falling back to manual-only until restart');
      // 降级后真正停掉所有自动触发（周期 / 15min 心跳 / 网络轮询），tickNow 也不再进入 ——
      // 否则同一进程里再触发一次会重复告警，"仅手动"也没有兑现。
      stopped = true;
      clearAll();
      return;                                     // 关于页「检查更新」走 IPC，不受这里影响
    }
    // 阶梯退避（§7.10 口径 + 一档 12h 过渡）。
    schedule(UNAVAILABLE_BACKOFF_MS[Math.min(unavailableStreak - 1, UNAVAILABLE_BACKOFF_MS.length - 1)]);
  };

  const tick = async (trigger?: 'network' | 'system'): Promise<void> => {
    if (stopped || running) return;   // 单一执行窗口：触发源叠加时不并发跑两次检查
    running = true;
    try {
      const result = await o.service.checkForUpdate(false, trigger ?? null);
      await afterOutcome(result);
    } catch (err) {
      o.logger.error(`update check threw: ${String(err)}`);
      await afterOutcome({ ok: false, reason: 'NETWORK' });
    } finally {
      running = false;
    }
  };

  const pollOnce = (): void => {
    if (stopped || !o.net) return;
    const online = o.net.online;
    if (online && !lastOnline) void tick('network');
    lastOnline = online;
    poll = setTimer(NETWORK_POLL_MS, () => { pollOnce(); });
  };

  const start = async (): Promise<void> => {
    const settings = resolveUpdateSettings(await o.settings());
    // 触发源①：启动后 startupDelaySeconds + 抖动（仍受闸门复核，不绕过任何抑制）。
    if (settings.checkOnStartup && settings.autoCheck && settings.baseUrl) {
      // 闸门里的窗口是 `startupDelaySeconds + jitterSeconds`，其中 jitterSeconds ∈ [-9,+9]s
      // （service.ts 用 jitterDelay(id,60)-60，**加性**）。这里必须排到那个窗口的**上界之后**，
      // 否则约半数现场的首个 tick 会早于闸门 ⇒ 白跑一趟 STARTUP_DELAY，再退到 15min 心跳
      // （R1 · Major-2：实际首检时刻会从设计的 90s 漂到 ~15min）。
      // m4：散布复用同一个**形态**的加性抖动（[-9,+9] 取正半段），叠加在闸门上界之上 ⇒
      // 排期永远 ≥ 闸门阈值，同时保留 per-install 分散（不再用会被 Math.max 恒支配的乘性 spread）。
      // ⚠ seed 与闸门不是同一个：闸门用 installId（service），这里用 jitterSeed（主进程装配）。
      // 正因两者不同值，排期必须按闸门的**上界**（+9s）计算，不能按本进程的抖动值算。
      const gateUpperMs =
        (settings.startupDelaySeconds + STARTUP_GATE_JITTER_BOUND_SEC + STARTUP_GATE_MARGIN_SEC) * 1000;
      const jitterSeconds = jitterDelay(seed, 60) - 60;      // 与闸门同源的加性抖动 [-9,+9]
      const positiveSpreadMs = Math.max(0, jitterSeconds) * 1000;
      schedule(gateUpperMs + positiveSpreadMs);
    } else {
      schedule(GATE_HEARTBEAT_MS);
    }
    // 触发源③：系统恢复 / 解锁屏补检（闸门内要求距上次 >1h）。
    if (o.powerMonitor && settings.checkOnSystemResume) {
      for (const name of ['resume', 'unlock-screen'] as const) {
        const cb = () => { if (!stopped) void tick('system'); };
        resumeHandlers.push({ name, cb });
        o.powerMonitor.on(name, cb);
      }
    }
    // 触发源③′：网络恢复（net 模块没有 online 事件，用固定间隔轮询捕捉 offline→online 边沿）。
    if (o.net && settings.checkOnNetworkResume) {
      lastOnline = o.net.online;
      poll = setTimer(NETWORK_POLL_MS, () => { pollOnce(); });
    }
  };

  void start();

  return {
    stop(): void { stopped = true; clearAll(); },
    tickNow(trigger): void { if (!stopped) void tick(trigger); },
  };
}
