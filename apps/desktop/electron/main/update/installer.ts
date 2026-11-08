// 安装事务主体（契约 §6 / 设计 §7.7 安装事务与关机协议、§7.8 备份与数据兼容、§7.9 审计与磁盘保留）。
// B 关 · G7b 接管实现。快照算法本体复用已交付的 `snapshot.ts`（G7），本文件不重复实现快照复制。
//
// ── runInstallTransaction 的严格顺序（§7.7，测试逐条断言）────────────────────────
//   1) 形态门禁：artifactPath 必须恰好落在 pending/<targetVersion>/ 之下（不变量 4）
//   2) verifyArtifactBytes 再验一次包体（§6.3 第 5 条「点安装前各校验一次」）
//      ⇒ 失败即 ARTIFACT_INVALID，**不进入任何关机动作**（不 runOnce、不写盘、不 spawn）
//   3) resolveInstallDirectory（§0.7 P0-2 三级顺序；null ⇒ INSTALL_BLOCKED，不传 /D）
//   4) await shutdownController.runOnce()（§7.7 步骤 2–5 + 快照；缺失 ⇒ INSTALL_BLOCKED）
//   5) 快照定位（复用 snapshot.ts；失败 ⇒ 撤销 isUpdatingRef、不写哨兵、原样返回其 reason）
//   6) 原子写哨兵 <dataDir>/updates/pending-update.json（phase:'prepared'）
//   7) 定位 watchdog **独立可执行载体**（sparkii-update-watchdog.exe）并部署到 $INSTDIR
//      之外；缺件 / 部署失败 / 无法避开安装目录 ⇒ 删除刚写的哨兵 + 撤销 isUpdatingRef + INSTALL_BLOCKED
//   8) detached spawn 部署后的载体（args 逐字按契约 §6：`--updated --force-run /S /D=<dir>`，
//      `/D=` 最后且不加引号；不再设 ELECTRON_RUN_AS_NODE）
//   9) 哨兵 phase 改写为 'watchdog-started' ⇒ quitApp()
//
// ── 「不重复整份快照」的依据（交接文件第 46–48 行要求写清）───────────────────────
// `main/index.ts` 的 buildShutdownHooks().snapshotData 已在 §7.7 序列的第 ⑥ 步调过
// `snapshotDataDir(dataDir, 'shutdown-<Date.now()>', ['updates'])`，而本事务在第 4 步已
// `await runOnce()`，所以那一次快照必然发生在 closeStores（库已关闭、WAL 已 checkpoint）之后。
// 判定依据是**磁盘事实 + 时钟**，不是「记得有人调用过」：
//   ① 本事务 txnId 下已有可读 manifest ⇒ 直接复用（重入幂等）；
//   ② 否则扫 snapshots/，取 manifest.createdAt 最新的一份；仅当
//      `createdAt >= 本事务起点的真实 Date.now()` 时，认定它就是 runOnce 之后由关库钩子产出的
//      快照并复用（snapshot.ts 的生产入口恒用真实 Date.now() 写 createdAt，所以这里必须拿
//      **真实时钟** wallStart 比较，绝不能用可被单测固定的 deps.now()，否则会误判新旧）；
//   ③ 都不成立 ⇒ 自己补做一次快照。
// ①②③ 都只认「manifest 完整可读」的目录（snapshot.ts 的 tmp+rename 原子发布保证有 manifest
// 即是完整快照），因此不会把半份数据当备份，也不会对同一份 data\ 做两次整份复制。
//
// ── 边界 ────────────────────────────────────────────────────────────────────
// - 只写 <dataDir>/updates/ 之下（哨兵 / 结果读取 / 快照 / 审计链）；绝不碰真实
//   %LOCALAPPDATA%\SparkiiDesktop\data，绝不真跑 NSIS /S（单测全程注入 spawn，不产生子进程）。
// - 注册表读取恒为只读（`reg query`），且「命令输出」是可注入依赖：三级顺序全部由
//   固定文本驱动单测，不依赖真机注册表。
// - 任何一步失败都把 deps.isUpdatingRef.value 置回 false，避免应用卡在「更新退出」语义里。
// - 不改 service.ts / main/index.ts / snapshot.ts / scripts/update-watchdog.mjs 的任何约定；
//   契约 §6 的 7 个导出名与签名逐字保持。额外导出（*With / *Detailed / 常量 / 记录类型）
//   只为承载可注入依赖与可断言的细节。

import { execFile as cpExecFile, spawn as cpSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logUpdateEvent } from './audit.js';
import { compareVersions } from './decision.js';
import { pendingRoot, pendingVersionDir, updatesDir } from './dirs.js';
import { verifyArtifactBytes } from './downloader.js';
import {
  SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_TMP_PREFIX, hashFileSha256, isSafeTxnId,
  readSnapshotManifest, snapshotDataDirWithDeps, snapshotDir, snapshotsRoot,
} from './snapshot.js';
import type { SnapshotDeps, SnapshotManifest } from './snapshot.js';
import type { AuditLike, ChannelJson, LoggerLike, ReleaseJson } from './types.js';

// 契约 §6 的 snapshotDataDir / SnapshotResult 由 snapshot.ts 真正实现，本文件原样再导出。
export { snapshotDataDir } from './snapshot.js';
export type { SnapshotResult } from './snapshot.js';

// ───────────────────────────── 常量 ─────────────────────────────

/** 安装事务哨兵（契约 §1.9 目录 / §7.7 步骤 6）。 */
export const SENTINEL_FILENAME = 'pending-update.json';
/** watchdog 单一写入的安装结果文件（§7.7 结果回传）。 */
export const INSTALL_RESULT_FILENAME = 'install-result.json';
/** 客户端审计哈希链（§7.9 B 关项；与 §8.3 服务端发布透明日志无关）。 */
export const AUDIT_CHAIN_FILENAME = 'update-audit-chain.jsonl';
/** 哨兵存活期：expiresAt = min(release.expiresAt, now + SENTINEL_TTL_MS)。 */
export const SENTINEL_TTL_MS = 30 * 60_000;
/** 契约 §6 钉死的 watchdog --timeout-ms。 */
export const WATCHDOG_TIMEOUT_MS = 60_000;
/** §7.9 成功自检后默认保留的快照份数。 */
export const DEFAULT_SNAPSHOT_KEEP = 2;
/** reg query 只读超时；超时 / 命令缺失一律 fail closed 返回 null。 */
const REGISTRY_TIMEOUT_MS = 5_000;
/** 卸载注册表键前缀（HKCU，per-user NSIS oneClick 的登记位置）。 */
export const UNINSTALL_KEY_PREFIX = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
/**
 * 哈希链 genesis：固定常量，不依赖任何机器状态。首条记录的 prevHash 必须等于它，
 * 任何「整段替换 / 从头重写」都会在这里露馅。
 * 本地链的自证能力有限：「尾部被整段截断」无法由内容本身检出，那一项属于 §8.3
 * 服务端发布透明日志（P2），不要与本草稿混为一谈（设计 Minor · 6 闭合）。
 */
export const AUDIT_GENESIS_HASH = createHash('sha256')
  .update('sparkii:update-audit-chain:v1:genesis').digest('hex');

// ───────────────────────────── 契约 §6 类型 ─────────────────────────────

export interface InstallRequest {
  dataDir: string;
  currentVersion: string;
  targetVersion: string;
  artifactPath: string;
  packageSha512: string;
  resourcePath: string;       // app-update.yml 所在
  appId: string;              // 'com.sparkii.desktop'
  now(): number;
}

export interface InstallPlanResult {
  ok: boolean;
  reason?: string;
  txnId?: string;
  watchdogPid?: number;
  installDir?: string | null;
  snapshotPath?: string;
  /**
   * true = 关机序列已不可逆（库已关 / 池已停），调用方必须退出应用而不是回到运行态。
   * 契约 §6 的必备字段未变，这是可选新增（R1 · B-1）。
   */
  quitRequested?: boolean;
}

/** 注册表只读输出的注入形态：给定键返回 `reg query` 的 stdout；取不到返回 null。 */
export type RegistryReader = (key: string) => Promise<string | null>;

export interface SpawnOptionsLike {
  detached: boolean;
  stdio: 'ignore';
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
}

/** spawn 的最小返回形态（与真实 ChildProcess 结构兼容；单测注入假对象）。 */
export interface SpawnedChildLike {
  pid?: number;
  unref?(): void;
  on?(event: 'error', listener: (err: Error) => void): void;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptionsLike) => SpawnedChildLike;

/**
 * 关机协议依赖集合（契约 §6 的 `deps`）。
 * 主进程实际传入的形状见 `update/service.ts` 的 installUpdate（集成记录 I-5）：
 * `{ now, logger, quitApp, isUpdatingRef, shutdownController, rt, release, channel }`。
 * 其余可选成员是**注入缝**（时钟 / 进程 / 注册表 / 快照磁盘 / 阶段观测），
 * 生产代码一律走默认实现；缺失注入不改变任何判定（绝不因缺注入而放行）。
 * 文件系统不做抽象注入：单测用 mkdtempSync 真实临时目录，比 mock fs 更贴近现场。
 */
export interface InstallDeps {
  now?(): number;
  logger?: LoggerLike;
  quitApp?(): void;
  isUpdatingRef?: { value: boolean };
  /** §7.7 关机序列幂等控制器；缺失 ⇒ INSTALL_BLOCKED（绝不「跳过序列直接装」）。 */
  shutdownController?: { runOnce(): Promise<unknown[]>; hasRun(): boolean; progress?(): string[]; dismantled?(): boolean };
  rt?: unknown;
  /** 已验签清单：本模块只消费，不再验签（验签门禁在 IPC / service 层，不变量 2）。 */
  release?: ReleaseJson;
  channel?: ChannelJson;
  /** 额外审计出口（AuditStore）；缺省只落本地哈希链。 */
  audit?: AuditLike;
  // ---- 注入缝（单测：全程不真 spawn、不读真机注册表、不依赖真实磁盘余量） ----
  readRegistry?: RegistryReader;
  spawn?: SpawnFn;
  execPath?: string;
  pid?: number;
  /** 直接指定 watchdog 独立载体（sparkii-update-watchdog.exe）绝对路径（跳过候选定位）。 */
  watchdogPath?: string;
  /** 固定 txnId（单测确定性）；缺省按 now + 随机后缀生成。 */
  txnId?: string;
  /** 透传给 snapshot.ts 的注入依赖（磁盘余量 / 复制中途失败模拟）。 */
  snapshotDeps?: SnapshotDeps;
  /** 阶段观测缝：只记录，不参与任何判定。 */
  trace?: (step: string, info?: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface StartupVerdict {
  ok: boolean;
  pending: boolean;           // 是否有待处理安装事务
  txnId: string | null;
  targetVersion: string | null;
  message: string;
  /** 机器可判定的分支标识（可选新增字段，不影响契约 §6 的调用形状）。 */
  reason?: string;
}

// ───────────────────────────── 哨兵 / 结果 / 链 记录 ─────────────────────────────

export type SentinelPhase = 'prepared' | 'watchdog-started';

/** 哨兵记录：至少含 §7.7 步骤 6 列出的字段；额外字段让哨兵自描述（人工复跑不必再猜）。 */
export interface SentinelRecord {
  schemaVersion: 1;
  txnId: string;
  phase: SentinelPhase;
  fromVersion: string;
  targetVersion: string;
  packageSha512: string;
  /** 绝对路径，且必然落在 pending/<targetVersion>/ 之下（第 1 步已门禁）。 */
  artifactPath: string;
  installDir: string;
  snapshotPath: string;
  snapshotManifestPath: string;
  resultPath: string;
  watchdogPath: string;
  expiresAt: number;          // epoch ms = min(release.expiresAt, createdAt + 30min)
  createdAt: number;          // epoch ms
  writer: 'main';
  watchdogPid?: number;
}

/** watchdog 单一写入的结果文件形态（契约 §6 末段）。 */
export interface InstallResultRecord {
  ok: boolean;
  exitCode: number | null;
  targetVersion: string | null;
  packageSha512: string | null;
  parentGoneAt: string | null;
  spawnedAt: string | null;
  writtenAt: string | null;
  writer: 'watchdog';
  reason?: string;
}

/** 哈希链单条记录：hash = sha256(prevHash + eventHash)，与契约 §6 声明的哈希口径逐字一致。 */
export interface ChainRecord {
  seq: number;
  ts: number;
  prevHash: string;
  eventHash: string;
  hash: string;
  event: Record<string, unknown>;
}

export interface ChainVerdict {
  ok: boolean;
  count: number;
  head: string | null;
  reason?: string;
  brokenAtSeq?: number;
  message?: string;
}

export interface PruneReport {
  /** true ⇒ 哨兵在场，按 §7.9 完全不动 pending/。 */
  pendingSkipped: boolean;
  pendingRemoved: string[];
  pendingKept: string[];
  snapshotsRemoved: string[];
  snapshotsKept: string[];
  orphansRemoved: string[];
  reason?: string;
  /** m11：本次生效的字节上限（pending/ + snapshots/ 的非保护累积）。 */
  byteCapBytes?: number;
  /** 清理前后的 pending/+snapshots/ 实测字节数。 */
  bytesBefore?: number;
  bytesAfter?: number;
  /** true ⇒ 这次确实因字节上限驱逐过条目。 */
  byteCapApplied?: boolean;
  /** 被字节上限驱逐的条目（`pending/<v>` / `snapshots/<txnId>`）。 */
  evictedForCap: string[];
}

export interface RecoverReport {
  ok: boolean;
  reason?: string;
  message?: string;
  txnId: string;
  total: number;
  restored: number;
  /** 快照文件自身 sha256 与 manifest 不符 ⇒ 绝不回灌。 */
  mismatched: number;
  missing: number;
  /** manifest 里形态非法的路径（穿越风险）：拒绝且不碰磁盘。 */
  refused: number;
  failed: number;
}

export interface PruneOptions {
  /** 当前（已安装）版本：只有它明确时，才允许清 pending 里的旧包。 */
  currentVersion?: string;
  /** 已知哨兵（避免重复读盘）；不传则自己读。 */
  sentinel?: SentinelRecord | null;
  keep?: number;
  audit?: AuditLike;
  logger?: LoggerLike;
  now?(): number;
  /**
   * 字节上限（§7.9 / m11）。缺省 = 1.5 × 当前版本包体（RETAIN_BYTES_FACTOR）。
   * 只作用于**非保护累积**：当前版本包、哨兵引用的快照、最新一份快照绝不驱逐；
   * 哨兵在场时 pending/ 整体跳过（与「回滚未完成前不得删旧包」同一保护）。
   */
  limitBytes?: number;
  /**
   * 只做字节上限，跳过「按数量清 pending / 快照」的常规保留。
   * 用于失败 / 过期现场：既要防止无限累积，又不能把人工回滚介质当成「超量」清掉。
   */
  byteCapOnly?: boolean;
}

export interface RecoverOptions {
  /** 复制实现注入（与 snapshot.ts 同一形态），单测模拟中途失败。 */
  copyFileImpl?: (src: string, dst: string) => Promise<void>;
  audit?: AuditLike;
  logger?: LoggerLike;
}

export interface StartupVerifyOptions {
  now?(): number;
  audit?: AuditLike;
  logger?: LoggerLike;
  keep?: number;
}

type FileRead<T> =
  | { status: 'absent' }
  | { status: 'invalid'; detail: string }
  | { status: 'ok'; value: T };

// ───────────────────────────── 路径 helpers ─────────────────────────────

export function sentinelPath(dataDir: string): string {
  return join(updatesDir(dataDir), SENTINEL_FILENAME);
}
export function installResultPath(dataDir: string): string {
  return join(updatesDir(dataDir), INSTALL_RESULT_FILENAME);
}
export function auditChainPath(dataDir: string): string {
  return join(updatesDir(dataDir), AUDIT_CHAIN_FILENAME);
}

/** 原子写 JSON：同目录 `.tmp-*` + rename（与 snapshot.ts 的发布方式同一口径）。 */
async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}.json`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ───────────────────────────── 注册表解析（§0.7 P0-2）─────────────────────────────

/**
 * 单行 `reg query` 值输出：`    InstallLocation    REG_SZ    D:\path\`。
 * name 用非贪婪，确保取到**第一个** `REG_*` 词元（真实输出里值名不会自带 REG_ 前缀）。
 */
const REG_VALUE_LINE = /^[ \t]+(\S[^\r\n]*?)[ \t]+(REG_[A-Z_0-9]+)[ \t]*([^\r\n]*)$/;
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const APP_ID_RE = /^[0-9A-Za-z._-]+$/;
/** appId 长度上限：真实值是本包的固定常量，超长即异常形态（也顺带限定注册表键长度）。 */
const APP_ID_MAX_LENGTH = 128;
/** 带引号 exe 路径优先（本机实测：`"D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser`）。 */
const QUOTED_EXE_RE = /^\s*"([^"]+)"/;
/** 整值被成对引号包住（某些工具会把 InstallLocation 也写成带引号形态）。 */
const QUOTED_PAIR_RE = /^"[^"]*"$/;
/** 控制字符（NUL / CR / LF 等）：会改变命令行参数边界，一律拒绝。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * 清洗并校验候选目录：
 * - 去首尾空白 / 成对引号 / 尾随分隔符（盘符根与 UNC 根保留）；
 * - 必须 win32 绝对路径（盘符或 UNC），否则 null；
 * - 拒绝内嵌引号 / 控制字符：`/D=` 不加引号直接进命令行，这些字符会改写参数边界；
 * - 拒绝 `..` 段：注册表值虽是本机状态，也不允许它把安装目录指到别处。
 */
export function sanitizeInstallDir(raw: string): string | null {
  let value = raw.trim();
  if (QUOTED_PAIR_RE.test(value)) value = value.slice(1, -1).trim();   // 成对引号剥掉
  if (!value) return null;
  if (CONTROL_CHARS_RE.test(value)) return null;
  if (value.includes('"')) return null;
  value = value.replace(/\//g, '\\');            // 正斜杠归一：`D:/a/b` ⇒ `D:\a\b`
  if (!WIN_ABSOLUTE_RE.test(value)) return null;
  // Win32 命名空间前缀（`\\?\…` / `\\.\…`）绕过常规解析，NSIS 侧行为不确定 ⇒ 拒绝。
  if (value.startsWith('\\\\?\\') || value.startsWith('\\\\.')) return null;
  const segments = value.split('\\');
  if (segments.some((s) => s === '..')) return null;
  // 尾随分隔符去掉（`D:\software\SparkiiPi\` ⇒ `D:\software\SparkiiPi`），但保留 `D:\` 这类盘根。
  const trimmedTail = value.replace(/\\+$/, '');
  const isDriveRoot = /^[A-Za-z]:$/.test(trimmedTail);
  const isUncServerRoot = /^\\\\[^\\]+$/.test(trimmedTail);            // `\\srv` 这种只有服务器名的根
  const out = isDriveRoot || isUncServerRoot ? `${trimmedTail}\\` : trimmedTail;
  if (/[ \t]$/.test(out)) return null;   // 尾随空白：契约要求「不含尾随空白」
  return out.length > 0 ? out : null;
}

/** 值名大小写不敏感取值（注册表值名本身不区分大小写）。 */
function lookupValue(values: Record<string, { type: string; value: string }>, name: string):
  { type: string; value: string } | undefined {
  if (values[name]) return values[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(values)) {
    if (key.toLowerCase() === lower) return values[key];
  }
  return undefined;
}

/** 解析 `reg query` 文本，返回逐个值名（同名取第一次出现，忽略 HIVE 头与噪声行）。 */
export function parseRegistryOutput(text: string): Record<string, { type: string; value: string }> {
  const out: Record<string, { type: string; value: string }> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = REG_VALUE_LINE.exec(line);
    if (!m) continue;
    const name = (m[1] ?? '').trim();
    const type = m[2] ?? '';
    const value = m[3] ?? '';
    if (!name || name.startsWith('HKEY_')) continue;
    if (!(name in out)) out[name] = { type, value };   // 噪声 / 重复块：第一个块赢
  }
  return out;
}

/** 值可用 = REG_SZ，或不含 %VAR% 的 REG_EXPAND_SZ（本模块绝不做环境变量展开）。 */
function usableValue(entry: { type: string; value: string } | undefined): string | null {
  if (!entry) return null;
  if (entry.type !== 'REG_SZ' && !(entry.type === 'REG_EXPAND_SZ' && !entry.value.includes('%'))) {
    return null;
  }
  const v = entry.value.trim();
  return v.length > 0 ? v : null;
}

/**
 * UninstallString ⇒ 安装父目录。
 * ① 带引号 exe 路径；② 无引号时取第一个 `/开关` 之前的前缀，并要求它以 .exe 结尾
 *   （不带引号又含空格的路径本身有歧义，宁可判不可解析）。
 */
export function installDirFromUninstallString(raw: string): string | null {
  let exe: string | null = null;
  const quoted = QUOTED_EXE_RE.exec(raw);
  if (quoted) {
    exe = quoted[1] ?? null;
  } else {
    const withoutSwitches = raw.split(/\s+\/(?=[A-Za-z])/)[0]?.trim() ?? '';
    if (/\.exe$/i.test(withoutSwitches)) exe = withoutSwitches;
  }
  if (!exe) return null;
  if (CONTROL_CHARS_RE.test(exe) || exe.includes('"')) return null;
  if (!WIN_ABSOLUTE_RE.test(exe)) return null;
  // win32 语义的父目录：不用 path.dirname（POSIX 下会把反斜杠当普通字符，跨平台单测会误判）。
  const normalized = exe.replace(/[\\/]+$/, '');
  const cut = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (cut <= 0) return null;
  return sanitizeInstallDir(normalized.slice(0, cut));
}

export interface RegistryResolveDeps {
  readRegistry?: RegistryReader;
  logger?: LoggerLike;
  /** 平台门禁注入（单测可在任意平台跑 win32 语义；缺省按真实 process.platform）。 */
  platform?: NodeJS.Platform;
}

/** 生产用只读注册表读取：`reg query <key>`，任何失败 ⇒ null（fail closed）。 */
export const readRegistryViaRegQuery: RegistryReader = (key) =>
  new Promise((resolveFn) => {
    cpExecFile(
      'reg', ['query', key],
      { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err || typeof stdout !== 'string') { resolveFn(null); return; }
        resolveFn(stdout);
      },
    );
  });

/**
 * §0.7 P0-2 三级顺序（本机实测形态见 task0-results D-2：InstallLocation 为空、
 * UninstallString = `"D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser`）：
 *   ① InstallLocation；② 为空时从 UninstallString 的带引号 exe 取父目录；
 *   ③ 仍失败 ⇒ null（fail closed：不传 /D、拒绝进入自管安装）。
 * 非 win32 一律 null：NSIS 与这些键只存在于 Windows，绝不「猜」一个目录。
 */
export async function resolveInstallDirectoryWith(
  appId: string,
  deps: RegistryResolveDeps = {},
): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return null;
  if (
    typeof appId !== 'string'
    || appId.length === 0 || appId.length > APP_ID_MAX_LENGTH
    || appId.includes('..')                      // 防 `..\Uninstall\..` 这类键路径上溯
    || !/^[0-9A-Za-z]/.test(appId)               // 必须以字母数字开头（真实 appId 形态）
    || !APP_ID_RE.test(appId)
  ) {
    deps.logger?.warn(`[install-dir] appId 形态非法：${String(appId).slice(0, 64)}（fail closed）`);
    return null;
  }
  const read = deps.readRegistry ?? readRegistryViaRegQuery;
  const key = `${UNINSTALL_KEY_PREFIX}\\${appId}`;
  let text: string | null = null;
  try {
    text = await read(key);
  } catch (err) {
    deps.logger?.warn(`[install-dir] 注册表读取抛错：${String(err)}（fail closed）`);
    return null;
  }
  if (typeof text !== 'string' || text.trim() === '') return null;

  const values = parseRegistryOutput(text);
  const location = usableValue(lookupValue(values, 'InstallLocation'));
  if (location) {
    const dir = sanitizeInstallDir(location);
    if (dir) return dir;                       // ①
    deps.logger?.warn('[install-dir] InstallLocation 形态非法，转 UninstallString 回退');
  }
  const uninstall = usableValue(lookupValue(values, 'UninstallString'));
  if (uninstall) {
    const dir = installDirFromUninstallString(uninstall);
    if (dir) return dir;                       // ②
  }
  return null;                                 // ③ fail closed
}

/** 契约 §6 导出：生产入口（只读 reg query）。注入版见 resolveInstallDirectoryWith。 */
export async function resolveInstallDirectory(appId: string): Promise<string | null> {
  return resolveInstallDirectoryWith(appId, {});
}

/**
 * §0.4 不变量 4 的后半句：「安装器参数（含目标目录）由 Main 进程根据已验签清单与
 * **本机安装位置**计算」。注册表只是线索，不是权威 —— 本机安装位置的权威来源是
 * 「我现在这个正在运行的 exe 到底躺在哪儿」。
 *
 * 判据：`dirname(execPath)` 与候选目录**精确相等**（大小写与尾分隔符归一后）。不符即 fail closed：
 * 宁可不装，也绝不能把更新写到另一个目录去 ——
 * 那正是 §7.7 点名的「两份安装 / 快捷方式仍指向旧版」事故形态，
 * 而注册表值对同用户可写，把它单独当依据等于把目标目录交给外部输入。
 * 以前这里还接受「候选是运行位置的祖先」，R8 判为 Major：那等于把盘根 / 主目录也认成合法安装目录。
 */
export function assertInstallDirAnchored(
  candidateDir: string,
  execPath: string | undefined,
): { ok: true; runningDir: string } | { ok: false; reason: string; runningDir: string | null } {
  const runningDir = dirname(String(execPath ?? ''));
  if (!execPath || !runningDir || runningDir === '.' || runningDir === sep) {
    return { ok: false, reason: 'EXEC_PATH_UNAVAILABLE', runningDir: null };
  }
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/g, '').toLowerCase();
  const cand = norm(candidateDir);
  const run = norm(runningDir);
  if (!cand || !run) return { ok: false, reason: 'PATH_UNPARSABLE', runningDir };
  // ⚠ 只认**精确相等**（R8 · Major-3）。原先还接受「候选是运行位置的祖先」，于是同用户可写的
  // HKCU 值填盘根 `C:\`、用户目录 `C:\Users\X`、甚至 `%LOCALAPPDATA%` 容器本身都会被判相符 ⇒
  // 升级被写到那些目录里，正是 §0.4 不变量 4 / §7.7 要防的「两份安装、快捷方式仍指旧版」。
  // per-user NSIS 的安装目录就是 exe 所在目录，相等判据已经够用；祖先一律 fail closed（不传 /D、拒绝自管安装）。
  if (run !== cand) return { ok: false, reason: 'INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION', runningDir };
  // 再兜一层：安装目录本身是盘根 / UNC 共享根 / 用户主目录时一律拒绝——正常 per-user 安装不会长这样，
  // 而真长这样的话说「升级会原地覆盖」也不可信（宁可拒绝自管安装，交给 M-2 人工确认）。
  const home = String(process.env.USERPROFILE ?? process.env.HOME ?? '');
  const homeNorm = home ? norm(home) : '';
  const isDriveRoot = /^[a-z]:$/i.test(cand);
  const isUncRoot = /^[\\/]{2}[^\\/]+(?:[\\/][^\\/]+)?$/.test(cand);
  if (isDriveRoot || isUncRoot || (homeNorm && cand === homeNorm)) {
    return { ok: false, reason: 'INSTALL_DIR_TOO_BROAD', runningDir };
  }
  return { ok: true, runningDir: run };
}

// ───────────────────────────── watchdog 载体定位与部署 ─────────────────────────────

/**
 * B1 载体 = 独立镜像的 Node SEA 可执行文件（scripts/build-watchdog-sea.mjs 产出），
 * **不是** `update-watchdog.mjs` 脚本、也不是 Sparkii.exe 改名。
 *
 * 为什么必须是独立镜像名 + $INSTDIR 之外的路径（真实 NSIS 模板）：
 *   - 第一 kill 点：新安装器 installSection.nsh:33 在 oneClick 静默下也跑 CHECK_APP_RUNNING，
 *     allowOnlyOneInstallerInstance.nsh 的 FIND_PROCESS 按 `Path.StartsWith('$INSTDIR')`（:66）
 *     或 `IMAGENAME eq Sparkii.exe`（:75）匹配，然后 KILL_PROCESS。
 *   - 第二 kill 点：旧卸载器由 installUtil.nsh:224/230 以 `/S … --updated` 跑，un.onInit 静默下
 *     又 call un.checkAppRunning（uninstaller.nsh:18-19）⇒ 同一个宏再杀一次。
 *   - 文件锁：旧卸载器 un.atomicRMDir（uninstaller.nsh:164-182）逐文件 Rename，占用的文件会
 *     Abort。watchdog 只要还持有 `$INSTDIR\Sparkii.exe` 镜像句柄，升级就会失败。
 * 独立镜像名同时避开两条匹配；部署到 $INSTDIR 之外则不占用安装目录里的任何文件。
 */
const WATCHDOG_EXE_FILENAME = 'sparkii-update-watchdog.exe';
/** 部署子目录：`<updatesDir>/watchdog/`（updates/ 不在快照范围内，也不被 prune 触碰）。 */
const WATCHDOG_DEPLOY_SUBDIR = 'watchdog';

/**
 * 候选顺序（打包产物优先，其次开发态）：
 *   ① `<resourcePath>/scripts/sparkii-update-watchdog.exe`（extraResources 的落点）
 *   ② `<resourcePath>/sparkii-update-watchdog.exe`
 *   ③ 开发态相对本模块的 `build/watchdog/…`（源码态上溯 3 层、bundle 后上溯 2 层）
 * 缺件 ⇒ 事务 fail closed（INSTALL_BLOCKED），**绝不**退化回 `.mjs` 脚本载体——
 * 那正是被 NSIS 杀掉的形态（B1）。
 */
export function watchdogBinaryCandidatePaths(resourcePath: string): string[] {
  const out: string[] = [];
  if (typeof resourcePath === 'string' && resourcePath) {
    out.push(join(resourcePath, 'scripts', WATCHDOG_EXE_FILENAME));
    out.push(join(resourcePath, WATCHDOG_EXE_FILENAME));
  }
  const moduleBase = typeof import.meta?.url === 'string' ? import.meta.url : null;
  if (moduleBase) {
    for (const rel of [
      `../../build/${WATCHDOG_DEPLOY_SUBDIR}/${WATCHDOG_EXE_FILENAME}`,
      `../../../build/${WATCHDOG_DEPLOY_SUBDIR}/${WATCHDOG_EXE_FILENAME}`,
      `../../../../build/${WATCHDOG_DEPLOY_SUBDIR}/${WATCHDOG_EXE_FILENAME}`,
    ]) {
      try {
        out.push(fileURLToPath(new URL(rel, moduleBase)));
      } catch {
        /* 非法 URL：跳过该候选 */
      }
    }
  }
  return out;
}

/**
 * asar 内的可执行文件**不可执行**：Electron 的 fs 打过 asar 补丁 ⇒ existsSync 返回 true，
 * 但 detached 出去的子进程没有这个补丁，spawn 必然失败（哨兵写好、应用退出、安装从未发生）。
 * 因此 asar 路径一律跳过（`app.asar.unpacked/...` 是真目录，可以用）。
 */
function isSpawnablePath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  if (!normalized.includes('.asar/')) return true;
  return normalized.includes('.asar.unpacked/');
}

export function locateWatchdogBinary(resourcePath: string, override?: string): string | null {
  if (typeof override === 'string' && override) {
    return isSpawnablePath(override) && existsSync(override) ? override : null;
  }
  for (const candidate of watchdogBinaryCandidatePaths(resourcePath)) {
    if (!isSpawnablePath(candidate)) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 单条候选探测失败不影响其余候选 */
    }
  }
  return null;
}

/** child 是否落在 parent 目录树内（win32 大小写不敏感；按路径段边界判断）。 */
export function isPathInside(child: string, parent: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/g, '');
  const c = norm(child);
  const p = norm(parent);
  if (!p) return false;
  const ci = process.platform === 'win32';
  const cc = ci ? c.toLowerCase() : c;
  const pp = ci ? p.toLowerCase() : p;
  if (cc === pp) return true;
  return cc.startsWith(`${pp}\\`) || cc.startsWith(`${pp}/`);
}

/**
 * watchdog 运行时的部署路径。**必须**在安装目录树之外（否则 PowerShell 的
 * `Path.StartsWith('$INSTDIR')` 仍会命中）。首选 `<dataDir>/updates/watchdog/`；
 * 若 dataDir 恰好被指到安装目录里（非常规现场），退到 `<appDataRoot>/runtime/watchdog/`；
 * 两者都在安装目录内 ⇒ null（fail closed，绝不带着必被杀掉的载体进入安装）。
 */
export function deployedWatchdogPath(dataDir: string, installDir: string | null): string | null {
  const candidates = [join(updatesDir(dataDir), WATCHDOG_DEPLOY_SUBDIR)];
  const appDataRoot = dirname(resolve(dataDir));
  if (appDataRoot && resolve(appDataRoot) !== resolve(dataDir)) {
    candidates.push(join(appDataRoot, 'runtime', WATCHDOG_DEPLOY_SUBDIR));
  }
  for (const dir of candidates) {
    const target = join(dir, WATCHDOG_EXE_FILENAME);
    if (!installDir || !isPathInside(target, installDir)) return target;
  }
  return null;
}

// ───────────────────────────── 哨兵 / 结果读写 ─────────────────────────────

function invalidDetail(parsed: Record<string, unknown>): string {
  if (parsed.schemaVersion !== 1) return 'schemaVersion 非 1';
  if (parsed.writer !== 'main') return "writer 非 'main'";
  if (typeof parsed.txnId !== 'string' || !isSafeTxnId(parsed.txnId)) return 'txnId 形态非法';
  if (parsed.phase !== 'prepared' && parsed.phase !== 'watchdog-started') return 'phase 形态非法';
  for (const key of [
    'fromVersion', 'targetVersion', 'packageSha512', 'artifactPath',
    'installDir', 'snapshotPath', 'snapshotManifestPath',
  ] as const) {
    if (typeof parsed[key] !== 'string' || (parsed[key] as string).trim() === '') return `${key} 缺失`;
  }
  if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return 'createdAt 非数值';
  if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return 'expiresAt 非数值';
  return '';
}

/** 哨兵读取：absent（不存在）/ invalid（不可解析或字段非法）/ ok。 */
export async function readSentinel(dataDir: string): Promise<FileRead<SentinelRecord>> {
  let text: string;
  try {
    text = await readFile(sentinelPath(dataDir), 'utf8');
  } catch {
    return { status: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', detail: `JSON 解析失败：${String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', detail: '顶层不是 JSON 对象' };
  }
  const record = parsed as Record<string, unknown>;
  const detail = invalidDetail(record);
  if (detail) return { status: 'invalid', detail };
  return { status: 'ok', value: record as unknown as SentinelRecord };
}

/**
 * 结果文件读取。写入方唯一性（§7.7）由 `writer === 'watchdog'` 把住：
 * 出现别的写入者即视为 invalid，绝不把「customInstall / 人工伪造」的结果当成安装事实。
 */
export async function readInstallResult(dataDir: string): Promise<FileRead<InstallResultRecord>> {
  let text: string;
  try {
    text = await readFile(installResultPath(dataDir), 'utf8');
  } catch {
    return { status: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', detail: `JSON 解析失败：${String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', detail: '顶层不是 JSON 对象' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.writer !== 'watchdog') return { status: 'invalid', detail: "writer 非 'watchdog'（写入方不唯一）" };
  if (typeof record.ok !== 'boolean') return { status: 'invalid', detail: 'ok 非布尔' };
  return { status: 'ok', value: record as unknown as InstallResultRecord };
}

/** 结果是否属于该哨兵（防「上一轮事务的残留结果」把本轮误判为成功/失败）。 */
export function resultMatchesSentinel(r: InstallResultRecord, s: SentinelRecord): boolean {
  return r.targetVersion === s.targetVersion && r.packageSha512 === s.packageSha512;
}

export function makeTxnId(nowMs: number): string {
  return `install-${nowMs.toString(36)}-${randomUUID().slice(0, 8)}`;
}

// ───────────────────────────── 快照定位（复用 snapshot.ts）─────────────────────────────

interface SnapshotPlan {
  ok: boolean;
  reason?: string;
  message?: string;
  path?: string;
  manifestPath?: string;
  files?: number;
  /** 复用来源：本事务已有快照 / 关库钩子刚产出的快照 / 自己补做。仅诊断用。 */
  source?: 'own' | 'shutdown-hook' | 'made-now';
}

async function latestSnapshotManifest(
  dataDir: string,
): Promise<{ txnId: string; manifest: SnapshotManifest } | null> {
  let names: string[];
  try {
    names = await readdir(snapshotsRoot(dataDir));
  } catch {
    return null;
  }
  let best: { txnId: string; manifest: SnapshotManifest } | null = null;
  for (const name of names) {
    if (name.startsWith(SNAPSHOT_TMP_PREFIX)) continue;      // 半份 tmp，绝不可用
    if (!isSafeTxnId(name)) continue;
    const manifest = await readSnapshotManifest(dataDir, name);
    if (!manifest) continue;                                  // manifest 不可读 ⇒ 不是完整快照
    if (!best || manifest.createdAt > best.manifest.createdAt) best = { txnId: name, manifest };
  }
  return best;
}

/**
 * 见文件头「不重复整份快照的依据」①②③。wallStart 必须是**真实** Date.now()。
 */
async function resolveSnapshotForTransaction(
  dataDir: string,
  txnId: string,
  wallStart: number,
  deps: InstallDeps,
): Promise<SnapshotPlan> {
  if (!isSafeTxnId(txnId)) {
    return { ok: false, reason: 'SNAPSHOT_FAILED', message: `txnId 形态非法：${String(txnId)}` };
  }
  // ① 本事务 txnId 下已有完整快照 ⇒ 幂等复用。
  const own = await readSnapshotManifest(dataDir, txnId);
  if (own) {
    const path = snapshotDir(dataDir, txnId);
    return {
      ok: true, path, manifestPath: join(path, SNAPSHOT_MANIFEST_FILENAME),
      files: own.files.length, source: 'own',
    };
  }
  // ② 关库钩子（main/index.ts snapshotData）在本次事务起点之后产出的快照 ⇒ 复用，不重复整份复制。
  const latest = await latestSnapshotManifest(dataDir);
  if (latest && latest.manifest.createdAt >= wallStart) {
    return {
      ok: true, path: snapshotDir(dataDir, latest.txnId),
      manifestPath: join(snapshotDir(dataDir, latest.txnId), SNAPSHOT_MANIFEST_FILENAME),
      files: latest.manifest.files.length, source: 'shutdown-hook',
    };
  }
  // ③ 补做一次（snapshot.ts 内部已含空间预检 / WAL 脏检查 / tmp+rename 原子发布）。
  const made = await snapshotDataDirWithDeps(dataDir, txnId, ['updates'], deps.snapshotDeps ?? {});
  if (!made.ok || !made.snapshotPath) {
    return { ok: false, reason: made.reason ?? 'SNAPSHOT_FAILED', message: made.message };
  }
  return {
    ok: true, path: made.snapshotPath,
    manifestPath: join(made.snapshotPath, SNAPSHOT_MANIFEST_FILENAME),
    files: made.files, source: 'made-now',
  };
}

// ───────────────────────────── 安装事务主体 ─────────────────────────────

/** 形态门禁：child 必须**恰好**是 parent 的直接子文件（不变量 4，更深的子目录也拒绝）。 */
function isDirectChildOf(childPath: string, parentDir: string): boolean {
  const ci = process.platform === 'win32';
  const strip = (p: string): string => p.replace(/[\\/]+$/, '');
  const child = strip(resolve(childPath));
  const parent = strip(resolve(parentDir));
  if (child === parent) return false;                    // 目录本身不是安装包
  const c = ci ? child.toLowerCase() : child;
  const p = ci ? parent.toLowerCase() : parent;
  if (!c.startsWith(`${p}\\`) && !c.startsWith(`${p}/`)) return false;
  const rest = c.slice(p.length + 1);
  return rest.length > 0 && !rest.includes('\\') && !rest.includes('/');
}

/** 只消费已验签清单：要求它与本次请求的目标版本一致（不一致即 fail closed）。 */
function releaseForTarget(release: ReleaseJson, targetVersion: string): string | null {
  if (!release || typeof release !== 'object') return '缺少已验签 release';
  if (release.version !== targetVersion) return `release.version(${release.version}) != targetVersion(${targetVersion})`;
  if (!Number.isFinite(release.artifact?.bytes)) return 'release.artifact.bytes 非数值';
  if (typeof release.artifact?.sha512 !== 'string' || !release.artifact.sha512) return 'release.artifact.sha512 缺失';
  if (typeof release.expiresAt !== 'string' || Number.isNaN(Date.parse(release.expiresAt))) {
    return 'release.expiresAt 不可解析';
  }
  return null;
}

/**
 * §7.7 关机协议 + 安装事务主体（契约 §6）。
 * 返回 ok:true 表示「哨兵已落盘、watchdog 已 detached、已请求退出」；
 * 任何 ok:false 路径都已撤销 isUpdatingRef，且不会留下比当步更靠后的产物。
 */
export async function runInstallTransaction(
  req: InstallRequest,
  deps: InstallDeps = {},
): Promise<InstallPlanResult> {
  const nowMs = (): number => deps.now?.() ?? req.now?.() ?? Date.now();
  const wallStart = Date.now();               // 真实时钟：只用于快照新旧判定（见文件头）
  const logger = deps.logger;
  const trace = deps.trace;
  const dataDir = req?.dataDir ?? '';
  const txnId = deps.txnId ?? makeTxnId(nowMs());
  let stage = 'enter';
  /** §7.7 的关机序列是否已经跑完（跑完之后失败只能退出，见 blocked() 的 R1 · B-1 分支）。 */
  let sequenceRan = false;

  const auditOf = (): AuditLike | undefined => deps.audit;
  const chain = (event: Record<string, unknown>): Promise<void> =>
    appendClientAuditChain(dataDir, event).then(() => undefined, () => undefined);

  /** 统一失败出口：撤销「更新退出」标志 + 留痕，不静默吞掉原因。 */
  const blocked = async (reason: string, detail: string): Promise<InstallPlanResult> => {
    const msg = `[install-txn] ${txnId} 于 ${stage} 中止：${reason} — ${detail}`;
    try { logger?.warn(msg); } catch { /* 日志器异常不影响判定 */ }
    await chain({ action: 'update.failed', stage, reason, txnId, targetVersion: req?.targetVersion });
    // I-83（R20 · Major）：事务内部中止原先**只进链、不进库**，本次运行的 AuditStore 里看不到原因。
    // 与门面 installUpdate / startupScan 同一处置；subreason 固定枚举，不构成刷库通道。
    await logUpdateEvent(auditOf(), 'update.failed', {
      reason: 'INSTALL_FAILED', subreason: 'INSTALL_TRANSACTION',
      txnId, targetVersion: req?.targetVersion, detail: reason,
    }, logger);
    // 现场是否已不可逆：序列完整跑完，或已经**进入过** stopPool / closeStores
    // （这些步骤一旦开始，应用就不可能继续正常服务，把它留在运行态就是僵尸进程）。
    // 注意必须直接取 deps.shutdownController：blocked() 可能早于下方 `const controller` 被调用（TDZ）。
    const ctl = deps.shutdownController;
    const entered = typeof ctl?.progress === 'function' ? ctl.progress() : [];
    // 判据优先级：控制器自己的 dismantled() 是权威（步骤清单只有一份，见契约 I-40）；
    // 老式替身没有该方法时，退回到「已进入过 stopPool 及之后任一步」的等价判断。
    const irreversible = sequenceRan || (typeof ctl?.dismantled === 'function'
      ? ctl.dismantled()
      : entered.some((n) => n === 'stopPool' || n === 'stopDocumentParse' || n === 'disposeReviewer'
        || n === 'closeStores' || n === 'snapshotData'));
    if (irreversible) {
      // R1 · B-1：保持 isUpdating（序列已完成 ⇒ 守卫会直接放行退出），退出应用。
      // 用户下次启动时 pending/ 与伴生清单仍在，可重新发起安装；data\ 从未被动过。
      if (deps.isUpdatingRef) deps.isUpdatingRef.value = true;
      queueMicrotask(() => { try { deps.quitApp?.(); } catch { /* 退出失败由 index.ts 的 3s 兜底 */ } });
      return { ok: false, reason, quitRequested: true };
    }
    if (deps.isUpdatingRef) deps.isUpdatingRef.value = false;      // §7.7 步骤 1 的反向操作
    return { ok: false, reason };
  };

  // ── 0) 请求形态门禁 ────────────────────────────────────────────────
  stage = 'request-shape';
  if (
    typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir)
    || typeof req.targetVersion !== 'string' || !req.targetVersion
    || typeof req.artifactPath !== 'string' || !req.artifactPath
    || typeof req.packageSha512 !== 'string' || !req.packageSha512
    || typeof req.appId !== 'string' || !req.appId
  ) {
    // dataDir 必须是绝对路径：相对路径会把哨兵 / 快照 / 审计链写到 cwd 之下（现场不可控）。
    return blocked('INSTALL_BLOCKED', 'InstallRequest 字段缺失、dataDir 非绝对路径或形态非法');
  }
  const release = deps.release;
  const channel = deps.channel;
  if (!release) return blocked('INSTALL_BLOCKED', '缺少已验签 release（service.ts 必须传入）');
  const releaseProblem = releaseForTarget(release, req.targetVersion);
  if (releaseProblem) return blocked('INSTALL_BLOCKED', releaseProblem);
  if (channel && channel.targetVersion !== release.version) {
    return blocked('INSTALL_BLOCKED', `channel.targetVersion(${channel.targetVersion}) 与 release.version 不一致`);
  }

  // ── 1) 形态门禁：安装包只认 pending/<targetVersion>/ 下那一个文件（不变量 4）──
  stage = 'artifact-shape';
  let expectedPendingDir: string;
  try {
    expectedPendingDir = pendingVersionDir(dataDir, req.targetVersion);
  } catch (err) {
    return blocked('INSTALL_BLOCKED', `pending 目录构造失败：${String(err)}`);
  }
  if (!isDirectChildOf(req.artifactPath, expectedPendingDir)) {
    return blocked(
      'INSTALL_BLOCKED',
      `artifactPath 不在 pending/${req.targetVersion}/ 之下：${req.artifactPath}`,
    );
  }
  trace?.('verify-artifact', { artifactPath: req.artifactPath });

  // ── 2) 包体再验一次（§6.3 第 5 条）。失败绝不进入任何关机动作 ──
  stage = 'verify-artifact';
  const verified = await verifyArtifactBytes(req.artifactPath, req.packageSha512, release.artifact.bytes);
  if (!verified.ok) return blocked(verified.reason ?? 'ARTIFACT_INVALID', '包体 sha512/bytes 复核不通过');

  // ── 3) 安装目录三级解析（§0.7 P0-2）───────────────────────────────
  stage = 'resolve-install-dir';
  trace?.('resolve-install-dir', { appId: req.appId });
  const installDir = await resolveInstallDirectoryWith(req.appId, {
    readRegistry: deps.readRegistry,
    logger,
  });
  if (!installDir) {
    return blocked('INSTALL_BLOCKED', '安装目录解析失败：fail closed，不传 /D、拒绝自管安装（请人工确认卸载注册表）');
  }
  // §0.4 不变量 4：注册表只是线索，本机安装位置的权威来源是「正在运行的 exe 在哪」。
  // 两者不符 ⇒ 在进入任何关机动作之前就 fail closed（既避免装到别的目录，也避免留下半关机现场）。
  const anchor = assertInstallDirAnchored(installDir, deps.execPath ?? process.execPath);
  if (!anchor.ok) {
    try {
      logger?.warn(`[install-txn] 安装目录与运行位置不符（${anchor.reason}）：`
        + `registry=${installDir} running=${anchor.runningDir ?? '未知'} ⇒ fail closed，不传 /D`);
    } catch { /* 日志失败不改变判定 */ }
    return blocked('INSTALL_BLOCKED', anchor.reason === 'INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION'
      ? `注册表指向 ${installDir}，但当前运行的是 ${anchor.runningDir ?? '未知位置'}：疑似存在两份安装，已拒绝自管安装（请人工确认后重装）`
      : anchor.reason === 'INSTALL_DIR_TOO_BROAD'
        ? `解析到的安装目录 ${installDir} 是盘根 / UNC 共享根 / 用户主目录，不可能是一次 per-user 安装的落点：已拒绝自管安装（请人工确认卸载注册表）`
        : '无法确定当前运行的安装目录：fail closed，不传 /D');
  }

  // ── 4) 关机序列必须先跑完（§7.7 步骤 2–5 + 快照；缺失即 fail closed）──
  const controller = deps.shutdownController;
  if (!controller || typeof controller.runOnce !== 'function') {
    return blocked('INSTALL_BLOCKED', '缺少 shutdownController：无法保证「先关库再安装」');
  }
  stage = 'shutdown-runOnce';
  trace?.('shutdown-runOnce');
  try {
    await controller.runOnce();
    sequenceRan = true;
  } catch (err) {
    return blocked('INSTALL_BLOCKED', `关机序列失败：${String(err)}`);
  }

  // ── 5) 快照（复用 snapshot.ts；见文件头的三步判定）────────────────
  stage = 'snapshot';
  trace?.('snapshot');
  const snap = await resolveSnapshotForTransaction(dataDir, txnId, wallStart, deps);
  if (!snap.ok || !snap.path || !snap.manifestPath) {
    return blocked(snap.reason ?? 'SNAPSHOT_FAILED', snap.message ?? '整 data\\ 快照失败');
  }

  // ── 6) 写哨兵（原子 tmp+rename）────────────────────────────────────
  stage = 'sentinel-write';
  trace?.('sentinel-write');
  const createdAt = nowMs();
  const expiresAt = Math.min(Date.parse(release.expiresAt), createdAt + SENTINEL_TTL_MS);
  const sentinelPathAbs = sentinelPath(dataDir);
  const resultPathAbs = installResultPath(dataDir);
  const record: SentinelRecord = {
    schemaVersion: 1,
    txnId,
    phase: 'prepared',
    fromVersion: req.currentVersion,
    targetVersion: req.targetVersion,
    packageSha512: req.packageSha512,
    artifactPath: resolve(req.artifactPath),
    installDir,
    snapshotPath: snap.path,
    snapshotManifestPath: snap.manifestPath,
    resultPath: resultPathAbs,
    watchdogPath: '',
    expiresAt,
    createdAt,
    writer: 'main',
  };
  try {
    await atomicWriteJson(sentinelPathAbs, record);
  } catch (err) {
    return blocked('INSTALL_BLOCKED', `哨兵写入失败：${String(err)}`);
  }

  // ── 7) watchdog 载体定位 + 部署到 $INSTDIR 之外；缺件/部署失败 ⇒ 清掉刚写的哨兵 ──
  stage = 'locate-watchdog';
  trace?.('locate-watchdog');
  const watchdogSource = locateWatchdogBinary(req.resourcePath, deps.watchdogPath);
  if (!watchdogSource) {
    await rm(sentinelPathAbs, { force: true }).catch(() => undefined);
    return blocked(
      'INSTALL_BLOCKED',
      `未找到 ${WATCHDOG_EXE_FILENAME}（候选：${watchdogBinaryCandidatePaths(req.resourcePath).join(' | ')}）；哨兵已回收`,
    );
  }
  // B1：载体必须跑在 $INSTDIR 之外，否则 NSIS 的两个 kill 点仍会按路径命中它。
  const watchdogTarget = deployedWatchdogPath(dataDir, installDir);
  if (!watchdogTarget) {
    await rm(sentinelPathAbs, { force: true }).catch(() => undefined);
    return blocked(
      'INSTALL_BLOCKED',
      `watchdog 部署位置无法避开安装目录 ${installDir}（NSIS 会杀掉它）：哨兵已回收，请人工确认 dataDir`,
    );
  }
  try {
    await mkdir(dirname(watchdogTarget), { recursive: true });
    await copyFile(watchdogSource, watchdogTarget);
  } catch (err) {
    await rm(sentinelPathAbs, { force: true }).catch(() => undefined);
    return blocked('INSTALL_BLOCKED', `watchdog 部署失败：${String(err)}；哨兵已回收`);
  }
  trace?.('deploy-watchdog', { from: watchdogSource, to: watchdogTarget });
  record.watchdogPath = watchdogTarget;

  // ── 8) detached spawn watchdog（参数逐字按契约 §6）────────────────
  stage = 'spawn-watchdog';
  trace?.('spawn-watchdog');
  // 全部 `<abs>` 参数取自哨兵本身（不接受 Renderer / 外部输入，不变量 4）。
  // M1：`--updated` 让重启的 app 拿到 --updated（common.nsh:125-126 StartApp），
  //     `--force-run` 让 oneClick 静默安装真正重启（installSection.nsh:94-97 只认 isForceRun）。
  //     `/D=` 必须最后、不加引号（NSIS 约定，§7.7）。
  const args = [
    '--parent-pid', String(deps.pid ?? process.pid),
    '--sentinel', sentinelPathAbs,
    '--result', record.resultPath,
    '--timeout-ms', String(WATCHDOG_TIMEOUT_MS),
    '--installer', record.artifactPath,
    '--',
    '--updated',
    '--force-run',
    '/S',
    `/D=${record.installDir}`,
  ];
  const spawnFn: SpawnFn = deps.spawn ?? ((cmd, a, o) => cpSpawn(cmd, a, o));
  // 载体是独立的 Node SEA 可执行文件：不需要（也不应该继承）ELECTRON_RUN_AS_NODE。
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const options: SpawnOptionsLike = {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
    windowsHide: true,
  };
  let child: SpawnedChildLike;
  try {
    child = spawnFn(watchdogTarget, args, options);
  } catch (err) {
    await rm(sentinelPathAbs, { force: true }).catch(() => undefined);
    return blocked('INSTALL_BLOCKED', `watchdog 拉起失败：${String(err)}；哨兵已回收`);
  }
  // detached 子进程的异步 error 无法回滚（此刻尚未退出），必须挂监听避免 unhandled 'error'。
  try {
    child.on?.('error', (err: Error) => {
      logger?.error(`[install-txn] ${txnId} watchdog 运行期错误：${String(err)}`);
    });
  } catch { /* 注入的假 child 可以没有 on */ }
  if (typeof child.pid !== 'number') {
    await rm(sentinelPathAbs, { force: true }).catch(() => undefined);
    return blocked('INSTALL_BLOCKED', 'watchdog 无 pid：视为拉起失败，哨兵已回收');
  }
  try {
    child.unref?.();                 // 主进程退出后由 watchdog 独立完成安装（§7.7 步骤 7.1）
  } catch { /* ignore */ }

  // ── 9) 哨兵 phase 改写（原子）⇒ quitApp ──────────────────────────
  stage = 'sentinel-phase';
  trace?.('sentinel-phase');
  const started: SentinelRecord = { ...record, phase: 'watchdog-started', watchdogPid: child.pid };
  try {
    await atomicWriteJson(sentinelPathAbs, started);
  } catch (err) {
    // watchdog 已经 detached 起来了，此刻删哨兵只会让它 SENTINEL_INVALID 而白跑一趟；
    // 哨兵的 'prepared' 版本字段完整可用，因此记录告警后继续退出（判定不依赖 phase 改写成功）。
    try { logger?.warn(`[install-txn] ${txnId} 哨兵 phase 改写失败（沿用 prepared）：${String(err)}`); } catch { /* ignore */ }
  }
  await chain({
    action: 'update.install-start', txnId, targetVersion: req.targetVersion,
    installDir, watchdogPid: child.pid, snapshotSource: snap.source,
  });
  await logUpdateEvent(auditOf(), 'update.install-start', {
    txnId, version: req.targetVersion, sequence: deps.release?.sequence ?? null,
  }, logger);
  trace?.('quit-app');
  try {
    deps.quitApp?.();
  } catch (err) {
    try { logger?.error(`[install-txn] quitApp 抛错（watchdog 已 detached，安装继续）：${String(err)}`); } catch { /* ignore */ }
  }
  return { ok: true, txnId, watchdogPid: child.pid, installDir, snapshotPath: snap.path };
}

// ───────────────────────────── 启动自检（§7.7 结果回传与恢复）─────────────────────────────

/** 契约 §6 导出：生产入口（真实时钟、默认保留份数）。 */
export async function verifyStartup(dataDir: string, currentVersion: string): Promise<StartupVerdict> {
  return verifyStartupWith(dataDir, currentVersion, {});
}

/**
 * 读哨兵 + install-result + currentVersion 三方对齐，给出**可执行**的结论。
 * 分支（交接文件第 77–83 行）：
 *   无哨兵 ⇒ 无待处理事务（零写盘）
 *   哨兵在 + 版本相符 + result.ok ⇒ 成功：清哨兵与结果、按 §7.9 保留策略清理（保留当前版本包）
 *   版本不符 / result.ok === false / 哨兵已过期 ⇒ 失败态：
 *     旧包与快照一律保留（§7.9「回滚未完成前不得删旧包与对应备份」），message 给恢复入口；
 *     过期残留额外做**幂等清理**（只清哨兵本身），使下次启动不再重复提示。
 *   结果缺失 / 不可解析 / 属于别的事务，但**运行版本已是目标版本**（③′）⇒ 按残留事务**收敛**：
 *     §7.5「不打扰」+ §7.7「残留时幂等清理」优先于「必须等到结果文件」，故不必等 expiresAt；
 *     只清哨兵（结果文件归 watchdog 单写，我们不越权删），包与快照全部保留。
 *     但因无安装器回传凭据，`ok` 仍为 false —— 只是 `pending:false` 让 UI 不再反复报失败。
 *     这一分支是 G7c 审核时指出的真实缺陷（升级实际成功却会在 TTL 内每次启动都报失败）的修复。
 * 全程零网络；除 updates/ 下的事务记录外不写任何东西。
 */
export async function verifyStartupWith(
  dataDir: string,
  currentVersion: string,
  opts: StartupVerifyOptions = {},
): Promise<StartupVerdict> {
  const nowMs = opts.now?.() ?? Date.now();
  const keep = opts.keep ?? DEFAULT_SNAPSHOT_KEEP;

  const sRead = await readSentinel(dataDir);
  const chain = (event: Record<string, unknown>): Promise<void> =>
    appendClientAuditChain(dataDir, event).then(() => undefined, () => undefined);

  if (sRead.status === 'absent') {
    return {
      ok: true, pending: false, txnId: null, targetVersion: null, message: '无待处理事务',
    };
  }
  if (sRead.status === 'invalid') {
    return {
      ok: false, pending: true, txnId: null, targetVersion: null, reason: 'SENTINEL_INVALID',
      message: `安装事务记录无法解析（${sRead.detail}）：为保留线索未自动清理。`
        + `安装包仍在 ${pendingRoot(dataDir)}，快照未改动，可人工确认后重跑安装或从快照回灌。`
        // 恢复介质是自描述的（manifest.json 完整可读），不依赖哨兵 ⇒ 必须给出可定位的入口，
        // 否则用户只知道「可以回灌」却不知道该回灌哪一份。
        + `现有快照目录：${snapshotsRoot(dataDir)}。`,
    };
  }
  const s = sRead.value;
  const rRead = await readInstallResult(dataDir);
  const matched = rRead.status === 'ok' && resultMatchesSentinel(rRead.value, s) ? rRead.value : null;
  const expired = nowMs > s.expiresAt;
  const versionMatched = currentVersion === s.targetVersion;
  const recovery = `恢复入口：旧安装包仍在 ${pendingRoot(dataDir)}（不得删），`
    + `可对 txnId ${s.txnId} 调用 recoverFromSnapshot 从 ${s.snapshotPath} 逐文件回灌 data\\，或重新发起安装。`;

  // ① 明确成功
  if (matched && matched.ok === true && versionMatched) {
    // R13 · Minor：这两条 rm 原先 `.catch(() => undefined)` 之后照旧在结论里写"已清理"，
    // 等于把"没清掉"谎报成"清掉了"。哨兵没删掉会让下次启动再走一遍同一格（幂等，无害），
    // 但报告必须说实话——运维据此判断"这台机器的事务记录是否已收口"。
    let txnRecordsCleared = true;
    for (const p of [sentinelPath(dataDir), installResultPath(dataDir)]) {
      try {
        await rm(p, { force: true });
      } catch (err) {
        txnRecordsCleared = false;
        try { opts.logger?.warn(`[startup-verify] 事务记录清理失败（安装判定不变，下次启动幂等重走本格）：${p}：${String(err)}`); } catch { /* ignore */ }
      }
    }
    // R18 · 域1②的相邻格（刻意不 gated by 下限可信性，理由写在这里）：这一格只在"安装器真退出 0 且
    // 运行版本已等于目标版本"时到达，删的是**已被更新的自己取代**的旧版本目录，判据是版本字符串相等 +
    // 事务在场，从不消费 `lastSeenSequence`。因此"状态锚点不可信"（update-state.json 被改字节 / 读不动）
    // 不会改变这里的取舍：把它一起关掉只会让 `pending/` 无限增长（§7.6 的保留策略反过来被破坏），
    // 而与 I-70 那一类"以破坏的方式处置合法包"不是同一件事——那一条删的是**仍可能被安装**的那一份。
    const prune = await pruneRetainedDetailed(dataDir, keep, {
      currentVersion, sentinel: null, audit: opts.audit, logger: opts.logger, now: () => nowMs,
    });
    await chain({ action: 'update.completed', txnId: s.txnId, from: s.fromVersion, to: s.targetVersion });
    await chain({ action: 'update.cleanup', txnId: s.txnId, scope: 'post-install', prune });
    await logUpdateEvent(opts.audit, 'update.completed', { txnId: s.txnId, version: s.targetVersion }, opts.logger);
    return {
      ok: true, pending: false, txnId: s.txnId, targetVersion: s.targetVersion, reason: 'INSTALL_OK',
      message: `升级完成：${s.fromVersion} → ${s.targetVersion}（安装器退出码 ${matched.exitCode ?? 0}）。`
        + (txnRecordsCleared
          ? `已清理事务记录与旧包${prune.pendingSkipped ? '（本次按策略保留 pending/）' : ''}，`
          : `事务记录未能清理（下次启动会幂等重走这一次完成，不重复提示升级），旧包`
            + `${prune.pendingSkipped ? '（本次按策略保留 pending/）' : ''}，`
          )
        + `保留最近 ${prune.snapshotsKept.length} 份快照。`,
    };
  }

  // ② 安装器明确失败
  if (matched && matched.ok === false) {
    await chain({
      action: 'update.failed', txnId: s.txnId, stage: 'installer',
      exitCode: matched.exitCode ?? null, watchdogReason: matched.reason ?? null,
    });
    // 契约 §6 的两种「失败形态」要分开说：exitCode 为数字 ⇒ 安装器真的跑了并返回非 0；
    // exitCode 为 null ⇒ watchdog 在拉起/校验阶段就退出（安装可能根本没执行）。
    const message = matched.exitCode === null
      ? `安装未执行（watchdog 原因 ${matched.reason ?? 'UNKNOWN'}，exitCode=null）。`
        + `哨兵、旧包与快照全部保留。${recovery}`
      : `安装器返回失败（exitCode=${matched.exitCode}`
        + `${matched.reason ? `，watchdog 原因 ${matched.reason}` : ''}）。哨兵、旧包与快照全部保留。${recovery}`;
    return {
      ok: false, pending: true, txnId: s.txnId, targetVersion: s.targetVersion, reason: 'INSTALL_FAILED',
      message,
    };
  }

  // ③ watchdog 说成功但运行版本仍是旧的 ⇒ 装错目录 / 半安装 / 快捷方式指向旧版（B 关验收②）
  if (matched && matched.ok === true) {
    return {
      ok: false, pending: true, txnId: s.txnId, targetVersion: s.targetVersion, reason: 'VERSION_MISMATCH',
      message: `watchdog 报告安装成功，但当前运行版本仍是 ${currentVersion}（目标 ${s.targetVersion}）：`
        + `疑似装到其它目录或半安装，请核对安装目录 ${s.installDir}。${recovery}`,
    };
  }

  // ③′ 结果回传丢失 / 不可解析 / 属于别的事务，**但运行版本已经是目标版本**
  //    ⇒ 版本证据独立成立，继续 nag 没有意义：§7.5「成功不打扰」+ §7.7「残留时幂等清理，
  //      避免每次启动都提示」优先于「必须等到结果文件」，因此不必等 expiresAt。
  //    但**不宣称「已验证安装成功」**：安装器回传凭据本身不可用，故 ok 仍为 false、
  //    只把 pending 置 false（= 不再提示），并保留全部恢复介质：
  //    只清哨兵（结果文件归 watchdog 单写，我们不越权删），包与快照一律不动（§7.9）。
  if (versionMatched && !matched) {
    await rm(sentinelPath(dataDir), { force: true }).catch(() => undefined);
    await chain({ action: 'update.cleanup', txnId: s.txnId, scope: 'result-unavailable-version-ok' });
    return {
      ok: false, pending: false, txnId: s.txnId, targetVersion: s.targetVersion,
      reason: 'RESULT_MISSING_BUT_VERSION_OK',
      message: `运行版本已是目标 ${s.targetVersion}，但安装结果回传缺失或不属于本次事务：`
        + `已按残留事务收敛处理（下次启动不再提示），**未宣称安装已验证成功**（无安装器回传凭据）。`
        + `安装包与快照全部保留，未删除任何用户数据。`,
    };
  }

  // ④ 无可用结果且已过期 ⇒ 幂等清理残留（只清哨兵本身，绝不碰包与快照）
  if (expired) {
    await rm(sentinelPath(dataDir), { force: true }).catch(() => undefined);
    await chain({ action: 'update.cleanup', txnId: s.txnId, scope: 'expired-sentinel' });
    // m11：反复失败 / 过期的安装会把 pending/ 与快照无限累积。这里只启用**字节上限**
    // （byteCapOnly），不动「按数量清旧包」：常规场景下人工回滚介质一个都不会少，
    // 只有在非保护累积超过 1.5× 包体时才驱逐最旧的失败残留与旧快照。
    const cap = await pruneRetainedDetailed(dataDir, keep, {
      currentVersion, sentinel: null, byteCapOnly: true,
      audit: opts.audit, logger: opts.logger, now: () => nowMs,
    });
    const detail = rRead.status === 'invalid' ? `（结果文件亦不可解析：${rRead.detail}）` : '';
    const capNote = cap.byteCapApplied
      ? `另按 §7.9 字节上限（${cap.byteCapBytes}）释放了 ${cap.evictedForCap.length} 项旧残留：${cap.evictedForCap.join('、')}。`
      : '安装包与快照全部保留，可重新发起安装。';
    return {
      ok: false, pending: false, txnId: s.txnId, targetVersion: s.targetVersion, reason: 'SENTINEL_EXPIRED',
      message: `事务 ${s.txnId}（目标 ${s.targetVersion}）超过 expiresAt 仍未回传结果${detail}：`
        + `已清理过期事务记录（下次启动不再重复提示），${capNote}`,
    };
  }

  // ⑤ 结果缺失 / 与本次事务不匹配 ⇒ 安装可能仍在进行，或结果回传丢失；不删任何东西
  const detail = rRead.status === 'absent'
    ? '安装结果文件缺失'
    : rRead.status === 'invalid'
      ? `安装结果文件不可解析（${rRead.detail}）`
      : '安装结果与本次事务不匹配（疑为上一轮残留）';
  return {
    ok: false, pending: true, txnId: s.txnId, targetVersion: s.targetVersion, reason: 'RESULT_MISSING',
    message: `${detail}：运行版本 ${currentVersion}、目标 ${s.targetVersion}、事务 ${s.txnId}。`
      + `未删除任何包与快照。${recovery}`,
  };
}

// ───────────────────────────── 磁盘保留策略（§7.9）─────────────────────────────

/** `.part` / `.tmp-*` 孤儿的最低年龄：更年轻的可能是在途下载 / 在途快照，绝不动。 */
const ORPHAN_MIN_AGE_MS = 10 * 60_000;

/** 契约 §6 导出：生产入口（自己读哨兵、不注入审计出口）。 */
export async function pruneRetained(dataDir: string, keep: number): Promise<void> {
  await pruneRetainedDetailed(dataDir, keep, {});
}

export async function pruneRetainedDetailed(
  dataDir: string,
  keep: number,
  opts: PruneOptions = {},
): Promise<PruneReport> {
  const report: PruneReport = {
    pendingSkipped: false, pendingRemoved: [], pendingKept: [],
    snapshotsRemoved: [], snapshotsKept: [], orphansRemoved: [], evictedForCap: [],
  };
  const nowMs = opts.now?.() ?? Date.now();
  const byteCapOnly = opts.byteCapOnly === true;

  let sentinelPresent: boolean;
  let protectedTxnId: string | null;
  if (opts.sentinel !== undefined) {
    sentinelPresent = opts.sentinel != null;
    protectedTxnId = opts.sentinel?.txnId ?? null;
  } else {
    const sr = await readSentinel(dataDir);
    // invalid 哨兵同样算「在场」：状态不明时绝不删旧包（fail closed）。
    sentinelPresent = sr.status !== 'absent';
    protectedTxnId = sr.status === 'ok' ? sr.value.txnId : null;
  }

  // 1) pending/：哨兵在场 ⇒ 一律不清（§7.9「回滚未完成前不得删旧包与对应备份」）。
  //    currentVersion 不明确时同样不清：无法判定「哪一份是当前版本包」。
  //    byteCapOnly（失败 / 过期现场）跳过这一步：常规「按数量清旧包」会把人工回滚介质一并删掉，
  //    那一档只允许字节上限在**超过 1.5× 包体**时驱逐最旧的失败残留。
  const currentVersion = typeof opts.currentVersion === 'string' ? opts.currentVersion.trim() : '';
  if (byteCapOnly) {
    // 不动盘，只登记保留清单；哨兵在场时 pending 仍整体受保护（承重不变量，与完整 prune 同一口径）。
    report.pendingSkipped = sentinelPresent;
    if (sentinelPresent) report.reason = 'SENTINEL_PRESENT';
    for (const version of await listDir(pendingRoot(dataDir))) report.pendingKept.push(version);
  } else if (sentinelPresent || !currentVersion) {
    report.pendingSkipped = true;
    report.reason = sentinelPresent ? 'SENTINEL_PRESENT' : 'CURRENT_VERSION_UNKNOWN';
  } else {
    let versions: string[] = [];
    try {
      versions = await readdir(pendingRoot(dataDir));
    } catch {
      report.reason = 'PENDING_ROOT_ABSENT';
    }
    for (const version of versions) {
      const dir = join(pendingRoot(dataDir), version);
      // R22 · Maj-3：版本「是否相同」与「谁更高」用同一个权威判据 `compareVersions`，
      // 不再拿字符串相等另判。这样运行 `0.3.0` 时 `0.3.0+build.2` 这种「同版本不同构建元数据」的
      // 包会被判等、作为「恢复 / 人工重装的介质」保留（service.ts 注释的意图），而不是被当成旧包删掉；
      // 预发布（如 `0.3.0-beta.1`）也不会被误判成与正式版相等。
      if (compareVersions(version, currentVersion) === 0) {
        report.pendingKept.push(version);
      } else {
        try {
          await rm(dir, { recursive: true, force: true });
          report.pendingRemoved.push(version);
        } catch (err) {
          report.pendingKept.push(version);   // 删不动就当保留，绝不谎报已清理
          try { opts.logger?.warn(`[prune] pending/${version} 删除失败：${String(err)}`); } catch { /* ignore */ }
        }
      }
    }
    // 2) `.part` 孤儿（只在允许动 pending/ 时清：.part 就在 pending/ 里）。
  }
  if (!sentinelPresent) await removeStaleParts(dataDir, opts, nowMs, report);

  // 3) 快照：先清 `.tmp-*` 孤儿（abort 掉的半份快照，snapshot.ts 的原子发布保证它们永不可用），
  //    再按 manifest.createdAt 由新到旧保留 keep 份；哨兵引用的那一份无条件额外保留。
  for (const name of await listDir(snapshotsRoot(dataDir))) {
    if (!name.startsWith(SNAPSHOT_TMP_PREFIX)) continue;
    const target = join(snapshotsRoot(dataDir), name);
    if (await olderThan(target, nowMs, ORPHAN_MIN_AGE_MS)) {
      try {
        await rm(target, { recursive: true, force: true });
        report.orphansRemoved.push(target);
      } catch (err) {
        try { opts.logger?.warn(`[prune] 临时残骸删除失败（保留现场）：${target}：${String(err)}`); } catch { /* ignore */ }
      }
    }
  }
  // 3b) updates/ 根本身的 `.tmp-*` 原子写残骸（哨兵 / 结果写入中途崩溃留下的）。
  //     只碰 `.tmp-*` 前缀：pending-update.json / install-result.json / 审计链等一概不动。
  for (const name of await listDir(updatesDir(dataDir))) {
    if (!name.startsWith(SNAPSHOT_TMP_PREFIX)) continue;
    if (join(updatesDir(dataDir), name) === snapshotsRoot(dataDir)) continue;
    const target = join(updatesDir(dataDir), name);
    if (await olderThan(target, nowMs, ORPHAN_MIN_AGE_MS)) {
      try {
        await rm(target, { recursive: true, force: true });
        report.orphansRemoved.push(target);
      } catch (err) {
        try { opts.logger?.warn(`[prune] 临时残骸删除失败（保留现场）：${target}：${String(err)}`); } catch { /* ignore */ }
      }
    }
  }
  const snapshots: Array<{ txnId: string; createdAt: number; path: string }> = [];
  for (const name of await listDir(snapshotsRoot(dataDir))) {
    if (name.startsWith(SNAPSHOT_TMP_PREFIX) || !isSafeTxnId(name)) continue;
    const path = join(snapshotsRoot(dataDir), name);
    const manifest = await readSnapshotManifest(dataDir, name);
    const createdAt = manifest ? manifest.createdAt : await mtimeMs(path);
    snapshots.push({ txnId: name, createdAt, path });
  }
  snapshots.sort((a, b) => b.createdAt - a.createdAt);
  if (byteCapOnly) {
    // 不动按数量的保留，只在需要时由字节上限驱逐（见下）。
    for (const snap of snapshots) report.snapshotsKept.push(snap.txnId);
  } else {
    const limit = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 0;
    let counted = 0;
    for (const snap of snapshots) {
      const mustKeep = snap.txnId === protectedTxnId;
      if (mustKeep || counted < limit) {
        if (!mustKeep) counted += 1;
        report.snapshotsKept.push(snap.txnId);
        continue;
      }
      try {
        await rm(snap.path, { recursive: true, force: true });
        report.snapshotsRemoved.push(snap.txnId);
      } catch (err) {
        report.snapshotsKept.push(snap.txnId);
        try { opts.logger?.warn(`[prune] 快照 ${snap.txnId} 删除失败：${String(err)}`); } catch { /* ignore */ }
      }
    }
  }

  // 4) m11 字节上限（§7.9「data/updates/ 总容量上限（如 1.5× 包体）」）。
  //    只作用于**非保护累积**：当前版本包、哨兵引用的快照、最新一份快照绝不驱逐；
  //    哨兵在场时 pending/ 整体跳过（与「回滚未完成前不得删旧包」同一保护）。
  await applyByteCap(dataDir, snapshots, protectedTxnId, currentVersion, opts, report);

  const summary = {
    pendingSkipped: report.pendingSkipped,
    pendingRemoved: report.pendingRemoved.length,
    snapshotsRemoved: report.snapshotsRemoved.length,
    orphansRemoved: report.orphansRemoved.length,
    byteCapBytes: report.byteCapBytes ?? null,
    bytesBefore: report.bytesBefore ?? null,
    bytesAfter: report.bytesAfter ?? null,
    evictedForCap: report.evictedForCap.length,
  };
  await chainQuiet(dataDir, { action: 'update.cleanup', scope: 'pruneRetained', ...summary });
  await logUpdateEvent(
    opts.audit, 'update.cleanup', { scope: 'pruneRetained', ...summary }, opts.logger,
  );
  return report;
}

/** §7.9 字节上限的默认倍数（决策：1.5× 包体）。 */
export const RETAIN_BYTES_FACTOR = 1.5;
/**
 * 用「包体」推导上限时要求的最小包体参考（1 MiB）。真实 NSIS 安装包是数十 MB 量级；
 * pending/ 里若只有几百字节的合成文件（单测 / 损坏残留），拿它 ×1.5 当上限会把所有
 * 恢复介质都判成超量。低于该值 ⇒ 视为没有可信参考，**不**启用默认上限
 * （显式传 limitBytes 时不受此限）。
 */
const MIN_CAP_REFERENCE_BYTES = 1024 * 1024;

/** 递归统计目录字节数；取不到的条目按 0 计（宁可少算，也不误删）。 */
async function pathBytes(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await pathBytes(child);
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch { /* 并发删除 / 权限：按 0 计 */ }
    }
  }
  return total;
}

/**
 * 一个「包体」的字节数参考：优先当前版本目录里最大的非临时文件，其次任一版本目录里的最大值。
 * 取不到任何包 ⇒ null（没有参考就不启用字节上限，而不是凭空造一个阈值）。
 */
async function packageBytesHint(dataDir: string, currentVersion: string): Promise<number | null> {
  const versions = await listDir(pendingRoot(dataDir));
  const ordered = currentVersion && versions.includes(currentVersion)
    ? [currentVersion, ...versions.filter((v) => v !== currentVersion)]
    : versions;
  let best = 0;
  let sawCurrent = false;
  for (const version of ordered) {
    if (currentVersion && version === currentVersion) sawCurrent = true;
    let versionBest = 0;
    for (const name of await listDir(join(pendingRoot(dataDir), version))) {
      if (name.endsWith('.part') || name.endsWith('.json') || name.endsWith('.sig')) continue;
      try {
        const st = await stat(join(pendingRoot(dataDir), version, name));
        if (st.isFile() && st.size > versionBest) versionBest = st.size;
      } catch { /* ignore */ }
    }
    if (versionBest > 0) {
      best = versionBest;
      // 当前版本优先：找到就停，不再拿旧失败包的尺寸当参考。
      if (sawCurrent || !currentVersion) break;
    }
  }
  return best > 0 ? best : null;
}

/** 清理过老的 `.part` 残骸（在途下载由 ORPHAN_MIN_AGE_MS 保护）。 */
async function removeStaleParts(
  dataDir: string,
  opts: PruneOptions,
  nowMs: number,
  report: PruneReport,
): Promise<void> {
  for (const version of await listDir(pendingRoot(dataDir))) {
    for (const name of await listDir(join(pendingRoot(dataDir), version))) {
      if (!name.endsWith('.part')) continue;
      const target = join(pendingRoot(dataDir), version, name);
      if (!(await olderThan(target, nowMs, ORPHAN_MIN_AGE_MS))) continue;
      // 与 pending/ 那一段同一条纪律：**删成功才记进 orphansRemoved**（R13 · Minor）。
      try {
        await rm(target, { force: true });
        report.orphansRemoved.push(target);
      } catch (err) {
        try { opts.logger?.warn(`[prune] .part 孤儿删除失败（保留现场）：${target}：${String(err)}`); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * 字节上限驱逐（m11）。顺序：先失败安装残留（非当前版本 pending，哨兵在场时跳过），
 * 再最旧的非保护快照；当前版本包、哨兵引用的快照、最新一份快照永不驱逐。
 * 上限默认 1.5× 包体；测不到包体且未显式给 limitBytes ⇒ 不启用（不凭空造阈值）。
 */
async function applyByteCap(
  dataDir: string,
  snapshots: Array<{ txnId: string; createdAt: number; path: string }>,
  protectedTxnId: string | null,
  currentVersion: string,
  opts: PruneOptions,
  report: PruneReport,
): Promise<void> {
  const explicit = Number.isFinite(opts.limitBytes) && (opts.limitBytes ?? 0) > 0
    ? Math.floor(opts.limitBytes!)
    : null;
  const hint = explicit === null ? await packageBytesHint(dataDir, currentVersion) : null;
  const usableHint = hint !== null && hint >= MIN_CAP_REFERENCE_BYTES ? hint : null;
  const cap = explicit ?? (usableHint !== null ? Math.floor(usableHint * RETAIN_BYTES_FACTOR) : null);
  if (cap === null || cap <= 0) return;

  let total = (await pathBytes(pendingRoot(dataDir))) + (await pathBytes(snapshotsRoot(dataDir)));
  report.byteCapBytes = cap;
  report.bytesBefore = total;
  report.bytesAfter = total;
  if (total <= cap) return;

  type Candidate = { path: string; label: string; bytes: number; oldest: number };
  // (a) 失败安装残留：非当前版本的 pending 目录，按 mtime 最旧优先。哨兵在场 ⇒ 一律不驱逐（承重不变量）。
  //     当前版本未知时同样不驱逐：无法判定哪一份是「必须留下的当前版本包」。
  const pendingCandidates: Candidate[] = [];
  if (!report.pendingSkipped && currentVersion) {
    for (const version of await listDir(pendingRoot(dataDir))) {
      if (currentVersion && compareVersions(version, currentVersion) === 0) continue;
      const path = join(pendingRoot(dataDir), version);
      pendingCandidates.push({
        path, label: `pending/${version}`, bytes: await pathBytes(path), oldest: await mtimeMs(path),
      });
    }
  }
  pendingCandidates.sort((a, b) => a.oldest - b.oldest);
  // (b) 最旧的非保护快照；最新一份永远留下（至少保留一个可恢复点）。
  const snapshotCandidates: Candidate[] = [];
  const newest = [...snapshots].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  for (const snap of [...snapshots].sort((a, b) => a.createdAt - b.createdAt)) {
    if (snap.txnId === protectedTxnId) continue;
    if (newest && snap.txnId === newest.txnId) continue;
    snapshotCandidates.push({
      path: snap.path, label: `snapshots/${snap.txnId}`, bytes: await pathBytes(snap.path), oldest: snap.createdAt,
    });
  }
  const candidates = [...pendingCandidates, ...snapshotCandidates];

  for (const candidate of candidates) {
    if (total <= cap) break;
    try {
      await rm(candidate.path, { recursive: true, force: true });
      total -= candidate.bytes;
      report.evictedForCap.push(candidate.label);
      report.byteCapApplied = true;
      if (candidate.label.startsWith('pending/')) {
        const version = candidate.label.slice('pending/'.length);
        report.pendingKept = report.pendingKept.filter((v) => v !== version);
      } else {
        const txnId = candidate.label.slice('snapshots/'.length);
        report.snapshotsKept = report.snapshotsKept.filter((t) => t !== txnId);
      }
    } catch (err) {
      try { opts.logger?.warn(`[prune] 字节上限驱逐失败（保留现场）：${candidate.label}：${String(err)}`); } catch { /* ignore */ }
    }
  }
  report.bytesAfter = Math.max(0, total);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 仅在「确实比阈值更老」时返回 true；取不到状态 ⇒ false（宁可不删）。 */
async function olderThan(path: string, nowMs: number, minAgeMs: number): Promise<boolean> {
  const mtime = await mtimeMs(path);
  if (mtime <= 0) return false;
  return nowMs - mtime >= minAgeMs;
}

// ───────────────────────────── 断电 / 失败恢复（§7.7 恢复介质）─────────────────────────────

/**
 * 契约 §6 导出形状：`{ ok, reason? }`，细节见 recoverFromSnapshotDetailed。
 * ⚠ R18 · 出口枚举表第④项：`opts` 原先被写死成 `{}`，而 `update.rolledBack` 只在 detailed 里写 ⇒
 * 任何走这个名字的调用（运维手册 §5 / `verifyStartupWith` 的恢复文案点名的就是它）**不留痕**。
 * 生产代码目前不自动调它（回灌是人工/脚本入口），所以改成把 opts 透传下去，
 * 让手册里写的"人工回灌"也能选择留下审计；不传时行为与原来一致。
 */
export async function recoverFromSnapshot(
  dataDir: string,
  txnId: string,
  opts: RecoverOptions = {},
): Promise<{ ok: boolean; reason?: string }> {
  const report = await recoverFromSnapshotDetailed(dataDir, txnId, opts);
  return { ok: report.ok, reason: report.reason };
}

/** manifest 里的相对路径是否可安全落到 dataDir 之下。 */
function safeManifestPath(rel: unknown): string[] | null {
  if (typeof rel !== 'string' || rel.trim() === '') return null;
  if (CONTROL_CHARS_RE.test(rel)) return null;
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (WIN_ABSOLUTE_RE.test(rel) || rel.startsWith('/')) return null;
  // 快照永不套快照 ⇒ 合法 manifest 不含 updates/；出现即视为被篡改，拒绝（也顺带保证
  // 回灌绝不复活旧哨兵 / 旧 update-state.json）。
  if (parts[0] === 'updates') return null;
  return parts;
}

/**
 * 按 manifest 逐文件 sha256 校验后回灌。
 * **只覆盖、不删除**：快照里没有的文件保持现状（§7.7「至少有可执行恢复路径且 data\ 完整」，
 * 删除属于不可逆动作，交人工决定）。任一条不一致即不算成功（fail closed）。
 */
export async function recoverFromSnapshotDetailed(
  dataDir: string,
  txnId: string,
  opts: RecoverOptions = {},
): Promise<RecoverReport> {
  const report: RecoverReport = {
    ok: false, txnId, total: 0, restored: 0, mismatched: 0, missing: 0, refused: 0, failed: 0,
  };
  if (!isSafeTxnId(txnId)) {
    report.reason = 'TXNID_INVALID';
    report.message = `txnId 形态非法：${String(txnId)}`;
    return report;
  }
  const manifest = await readSnapshotManifest(dataDir, txnId);
  if (!manifest) {
    report.reason = 'SNAPSHOT_MISSING';
    report.message = `读不到 ${snapshotDir(dataDir, txnId)} 的 manifest.json，无法回灌`;
    return report;
  }
  const src = snapshotDir(dataDir, txnId);
  // 复制实现可注入（与 snapshot.ts 的 SnapshotDeps.copyFileImpl 同一形态），默认 fs.copyFile。
  const copyImpl = opts.copyFileImpl ?? ((a: string, b: string) => copyFile(a, b).then(() => undefined));
  for (const entry of manifest.files) {
    report.total += 1;
    const parts = safeManifestPath(entry.path);
    if (!parts) { report.refused += 1; continue; }
    const srcFile = join(src, ...parts);
    const dstFile = join(dataDir, ...parts);
    try {
      await stat(srcFile);
    } catch {
      report.missing += 1;
      continue;
    }
    let actual: string;
    try {
      actual = await hashFileSha256(srcFile);
    } catch {
      report.failed += 1;
      continue;
    }
    if (actual !== entry.sha256) { report.mismatched += 1; continue; }  // 快照自身损坏 ⇒ 不回灌
    try {
      await mkdir(dirname(dstFile), { recursive: true });
      await copyImpl(srcFile, dstFile);
      report.restored += 1;
    } catch {
      report.failed += 1;
    }
  }
  if (report.failed > 0) report.reason = 'RECOVER_COPY_FAILED';
  else if (report.mismatched > 0) report.reason = 'RECOVER_HASH_MISMATCH';
  else if (report.missing > 0) report.reason = 'RECOVER_SOURCE_MISSING';
  else if (report.refused > 0) report.reason = 'RECOVER_PATH_REFUSED';
  report.ok = report.reason === undefined;
  report.message = `回灌 ${report.restored}/${report.total} 个文件`
    + `（损坏 ${report.mismatched}、缺失 ${report.missing}、拒绝 ${report.refused}、写入失败 ${report.failed}）`;
  if (report.ok) {
    await chainQuiet(dataDir, { action: 'update.rolledBack', txnId, restored: report.restored });
    await logUpdateEvent(opts.audit, 'update.rolledBack', { txnId, restored: report.restored }, opts.logger);
  }
  return report;
}

// ───────────────────────────── 客户端审计哈希链（§7.9 B 关项）─────────────────────────────

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 键序归一的 JSON：哈希必须与序列化顺序无关，否则同一事件会「看起来」被改过。 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj).sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 读取链上记录；文件缺失 ⇒ 空数组，尾部不可解析 ⇒ tailBroken。 */
async function readChainRecords(dataDir: string): Promise<{ records: ChainRecord[]; tailBroken: boolean }> {
  let text = '';
  try {
    text = await readFile(auditChainPath(dataDir), 'utf8');
  } catch {
    return { records: [], tailBroken: false };
  }
  const records: ChainRecord[] = [];
  let tailBroken = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as ChainRecord;
      if (typeof parsed?.hash !== 'string' || typeof parsed?.seq !== 'number') {
        tailBroken = true;
        continue;
      }
      records.push(parsed);
    } catch {
      tailBroken = true;
    }
  }
  return { records, tailBroken };
}

/**
 * 链文件容量护栏：纯追加文件必须有上限，否则「反复触发失败事务」就成了无界磁盘写入。
 * 触顶时 appendClientAuditChain 抛错拒写（调用方吞掉 ⇒ 只失去留痕，不影响安装判定），
 * 但绝不截断、绝不轮转、绝不覆盖已有记录——那等于自己抹掉可检出的篡改面。
 * 归档 / 轮转与 §8.3 服务端锚点一起做（P2）。
 */
export const AUDIT_CHAIN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 追加一条链记录，返回该记录的 hash（= sha256(prevHash + eventHash)）。
 * 落 <dataDir>/updates/update-audit-chain.jsonl：与 audit.db 分开存放，
 * 目的是「同用户进程想抹掉痕迹必须同时改这份纯追加文件」，抹除/改写可由 verifyAuditChain 检出。
 * 链本身不可防止**整段截断或替换**（那需要服务端锚点，见 §8.3 / P2），本函数与 verifyAuditChain
 * 只保证「断链 / 插队 / 就地篡改」一定可检出。
 * 两个护栏都以抛错表达（调用方一律吞掉 ⇒ 只影响留痕，绝不改变任何安装判定）：
 *   - dataDir 非绝对路径 ⇒ 拒写（否则会往 cwd 里造 updates/）；
 *   - 链已达 AUDIT_CHAIN_MAX_BYTES ⇒ 拒写，但**绝不截断 / 轮转 / 覆盖**既有记录
 *     （自己抹掉可检出的篡改面等于没链）。归档策略属 §7.9 后续项（与服务端锚点一起做）。
 */
export async function appendClientAuditChain(
  dataDir: string,
  event: Record<string, unknown>,
): Promise<string> {
  if (typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir)) {
    throw new Error(`appendClientAuditChain: dataDir 必须为绝对路径，收到 ${String(dataDir)}`);
  }
  const dir = updatesDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = auditChainPath(dataDir);
  try {
    if ((await stat(target)).size >= AUDIT_CHAIN_MAX_BYTES) {
      throw new Error(`update audit chain reached ${AUDIT_CHAIN_MAX_BYTES} bytes`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { records } = await readChainRecords(dataDir);
  const last = records.length > 0 ? records[records.length - 1]! : null;
  const prevHash = last ? last.hash : AUDIT_GENESIS_HASH;
  const seq = (last?.seq ?? 0) + 1;
  const payload: Record<string, unknown> = event && typeof event === 'object' ? event : { raw: String(event) };
  const eventHash = sha256hex(stableStringify(payload));
  const hash = sha256hex(prevHash + eventHash);
  const record: ChainRecord = {
    seq, ts: Date.now(), prevHash, eventHash, hash, event: payload,
  };
  await appendFile(target, `${JSON.stringify(record)}\n`, 'utf8');
  return hash;
}

/** 链写入绝不能反过来影响主流程：所有异常就地吞掉（判定不依赖它成功）。 */
async function chainQuiet(dataDir: string, event: Record<string, unknown>): Promise<void> {
  try {
    await appendClientAuditChain(dataDir, event);
  } catch {
    /* 审计链不可写（只读盘 / 权限）不改变任何安装判定 */
  }
}

/** 校验整条链：断链 / 插队 / 就地篡改 / seq 跳号 / genesis 不符 都能检出。 */
export async function verifyAuditChain(dataDir: string): Promise<ChainVerdict> {
  if (typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir)) {
    return { ok: false, count: 0, head: null, reason: 'DATA_DIR_INVALID' };
  }
  const { records, tailBroken } = await readChainRecords(dataDir);
  if (tailBroken) {
    return {
      ok: false, count: records.length, head: records.at(-1)?.hash ?? null,
      reason: 'LINE_UNPARSEABLE', message: '审计链存在无法解析的行（文件被截断或就地改写）',
    };
  }
  if (records.length === 0) {
    return { ok: true, count: 0, head: null, message: '尚无本地审计链' };
  }
  let expectedPrev = AUDIT_GENESIS_HASH;
  for (const [index, rec] of records.entries()) {
    const expectedSeq = index + 1;
    if (rec.seq !== expectedSeq) {
      return { ok: false, count: records.length, head: null, reason: 'SEQ_GAP', brokenAtSeq: expectedSeq };
    }
    if (rec.prevHash !== expectedPrev) {
      return {
        ok: false, count: records.length, head: null, reason: 'PREV_HASH_MISMATCH', brokenAtSeq: expectedSeq,
        message: index === 0 ? '首条 prevHash 与 genesis 不符（整段重写）' : '链在此断开（删除或插入了记录）',
      };
    }
    const eventHash = sha256hex(stableStringify(rec.event ?? {}));
    if (eventHash !== rec.eventHash) {
      return { ok: false, count: records.length, head: null, reason: 'EVENT_HASH_MISMATCH', brokenAtSeq: expectedSeq };
    }
    const hash = sha256hex(rec.prevHash + rec.eventHash);
    if (hash !== rec.hash) {
      return { ok: false, count: records.length, head: null, reason: 'HASH_MISMATCH', brokenAtSeq: expectedSeq };
    }
    expectedPrev = rec.hash;
  }
  return { ok: true, count: records.length, head: expectedPrev };
}

/** 读链上全部记录（诊断 / 测试用；不做校验，校验用 verifyAuditChain）。 */
export async function readAuditChain(dataDir: string): Promise<ChainRecord[]> {
  return (await readChainRecords(dataDir)).records;
}
