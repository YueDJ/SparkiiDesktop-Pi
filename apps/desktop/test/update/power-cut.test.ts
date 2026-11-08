// G7c · B④「安装失败 / 中途断电后至少有可执行恢复路径且 data\ 完整」的直接测试证据
// （契约 §9 验收映射 → test/update/power-cut.test.ts；设计 §9 B 关④、§7.7 安装事务与关机协议、
//   §7.8 备份与数据兼容、§7.9 磁盘保留；接口契约 §6 installer 契约、§1.9 目录布局、§10 I-5 / I-16 / I-23）。
//
// 断电现场全靠**可控注入**复现：写哨兵后不调用任何安装、注入 copyFileImpl、把结果文件截断成半截、
// 留下原子写中途崩溃的 .tmp-* 残骸。验收口径按设计 §7.7 末段：
// **不承诺「旧版本仍可启动」**，只断言「至少有可执行恢复路径且 data\ 完整」。
//
// 现场：mkdtempSync(join(tmpdir(),'sparkii-power-cut-*'))，afterEach 删除。
// 绝不碰真实 %LOCALAPPDATA%\SparkiiDesktop\data、绝不执行真实 NSIS /S（spawn 全程注入假对象，
// 不产生子进程）、绝不写注册表（readRegistry 注入固定 reg query 文本）。
//
// 本次交付**只新增本文件与 snapshot.test.ts，未改动任何产品代码或既有测试**。

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { pendingRoot, pendingVersionDir, updatesDir } from '../../electron/main/update/dirs.js';
import {
  DEFAULT_SNAPSHOT_KEEP, INSTALL_RESULT_FILENAME, SENTINEL_FILENAME,
  auditChainPath, installResultPath, pruneRetainedDetailed, readInstallResult, readSentinel,
  recoverFromSnapshot, recoverFromSnapshotDetailed, runInstallTransaction, sentinelPath,
  snapshotDataDir, verifyAuditChain, verifyStartup, verifyStartupWith,
} from '../../electron/main/update/installer.js';
import type { InstallDeps, InstallResultRecord, SentinelRecord } from '../../electron/main/update/installer.js';
import {
  SNAPSHOT_MANIFEST_FILENAME, hashFileSha256, readSnapshotManifest, snapshotDir,
} from '../../electron/main/update/snapshot.js';
import type { SnapshotManifest } from '../../electron/main/update/snapshot.js';
import type { ReleaseJson } from '../../electron/main/update/types.js';

const HOUR = 3_600_000;
const TTL = 30 * 60_000;
const OLD = '0.1.0';
const NEW = '0.2.0';
const NAME = 'Sparkii-0.2.0-win-x64.exe';
const TXN = 'txn-cut';
const PKG_SHA = createHash('sha512').update('artifact-bytes').digest('base64');

/** §7.8 点名的 data\ 形态（断电注入现场要断言「data\ 完整」，必须有真实文件可哈希）。 */
const DATA_FILES: Record<string, string> = {
  'audit.db': 'SQLITE-AUDIT-BYTES',
  'sessions.db': 'SQLITE-SESSIONS',
  'errors.db': 'SQLITE-ERRORS',
  'settings.json': '{"update":{"autoCheck":false}}',
  'keyring/master.enc': 'DPAPI-CIPHER-BLOB',
  'logs/app.log': 'boot\ninstall-click\n',
  'tasks/task-1.json': '{"state":"running"}',
  'pi-agent/bin/pi.exe': 'PI-BINARY',
};

let root: string;      // mkdtemp 根：dir 是它的子目录，便于断言「绝不写到 dataDir 之外」
let dir: string;       // == <root>/data，即注入的 SPARKII_DATA_DIR

function writeAt(base: string, rel: string, content: string | Buffer): string {
  const target = join(base, ...rel.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function plantData(): void {
  for (const [rel, content] of Object.entries(DATA_FILES)) writeAt(dir, rel, content);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** data\（不含 updates/ 子树）的逐文件哈希表：断言「data\ 完整」的唯一可信口径。 */
async function dataDigests(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of Object.keys(DATA_FILES)) {
    const abs = join(dir, ...rel.split('/'));
    if (existsSync(abs)) out[rel] = await hashFileSha256(abs);
  }
  return out;
}

/** 递归列出某目录下的全部文件（'/' 分隔相对路径），用于「一个都没被删/没被改」的对照。 */
function listFiles(base: string, prefix = ''): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(base, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** §1.9 的 pending/<version>/ 完整形态：安装包 + 伴生清单四件（B④ 要求「旧包与伴生清单一个都没被删」）。 */
function plantPending(version: string): string[] {
  const dirOfVersion = pendingVersionDir(dir, version);
  const files = [
    `Sparkii-${version}-win-x64.exe`,
    'release.json', 'release.json.sig', 'channel.json', 'channel.json.sig',
  ];
  for (const name of files) writeAt(dirOfVersion, name, `${name}-bytes`);
  return files;
}

function sentinel(over: Partial<SentinelRecord> = {}): SentinelRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    txnId: TXN,
    phase: 'watchdog-started',
    fromVersion: OLD,
    targetVersion: NEW,
    packageSha512: PKG_SHA,
    artifactPath: join(pendingVersionDir(dir, NEW), NAME),
    installDir: 'D:\\software\\SparkiiPi',
    snapshotPath: snapshotDir(dir, TXN),
    snapshotManifestPath: join(snapshotDir(dir, TXN), SNAPSHOT_MANIFEST_FILENAME),
    resultPath: installResultPath(dir),
    watchdogPath: join(dir, 'update-watchdog.mjs'),
    createdAt: now - HOUR,
    expiresAt: now + TTL,
    writer: 'main',
    ...over,
  };
}

function writeSentinel(over: Partial<SentinelRecord> = {}): SentinelRecord {
  const record = sentinel(over);
  writeAt(updatesDir(dir), SENTINEL_FILENAME, JSON.stringify(record, null, 2));
  return record;
}

function result(over: Partial<InstallResultRecord> = {}): InstallResultRecord {
  return {
    ok: true,
    exitCode: 0,
    targetVersion: NEW,
    packageSha512: PKG_SHA,
    parentGoneAt: new Date().toISOString(),
    spawnedAt: new Date().toISOString(),
    writtenAt: new Date().toISOString(),
    writer: 'watchdog',
    ...over,
  };
}

function writeResult(over: Partial<InstallResultRecord> = {}): InstallResultRecord {
  const record = result(over);
  writeAt(updatesDir(dir), INSTALL_RESULT_FILENAME, JSON.stringify(record, null, 2));
  return record;
}

/** 复现「断电正好落在 watchdog 写结果写到一半」：只留下完整 JSON 的前若干比例字节。 */
function writeHalfResult(ratio = 0.6): { path: string; full: string; half: string } {
  const full = JSON.stringify(result(), null, 2);
  const half = full.slice(0, Math.floor(full.length * ratio));
  expect(half.length).toBeGreaterThan(0);
  expect(half.length).toBeLessThan(full.length);
  writeAt(updatesDir(dir), INSTALL_RESULT_FILENAME, half);
  return { path: installResultPath(dir), full, half };
}

function writeHalfSentinel(ratio = 0.5): string {
  const full = JSON.stringify(sentinel(), null, 2);
  const half = full.slice(0, Math.floor(full.length * ratio));
  writeAt(updatesDir(dir), SENTINEL_FILENAME, half);
  return half;
}

/**
 * 用**真实快照模块**产出恢复介质（而不是手写 manifest）：
 * B④ 的「可执行恢复路径」必须是 §7.8 那份快照真能被 recoverFromSnapshot 消费。
 */
async function makeRealSnapshot(txnId = TXN): Promise<SnapshotManifest> {
  const made = await snapshotDataDir(dir, txnId, ['updates']);
  if (!made.ok) throw new Error(`快照未产出：${made.reason ?? ''} ${made.message ?? ''}`);
  const manifest = await readSnapshotManifest(dir, txnId);
  if (!manifest) throw new Error(`manifest 缺失：${snapshotDir(dir, txnId)}`);
  return manifest;
}

function ageHours(path: string, hours = 2): void {
  const t = new Date(Date.now() - hours * HOUR);
  utimesSync(path, t, t);
}

/** 现场断言：恢复介质、旧包与伴生清单全部在场（§7.9「回滚未完成前不得删旧包与对应备份」）。 */
function expectRecoveryMediaIntact(): void {
  for (const version of [OLD, NEW]) {
    const versionDir = pendingVersionDir(dir, version);
    for (const name of plantPendingNames(version)) {
      expect(existsSync(join(versionDir, name))).toBe(true);
    }
  }
}

function plantPendingNames(version: string): string[] {
  return [
    `Sparkii-${version}-win-x64.exe`,
    'release.json', 'release.json.sig', 'channel.json', 'channel.json.sig',
  ];
}

// ───────────────── runInstallTransaction 的假依赖（场景⑤ 用，全程不真 spawn）─────────────────

const REG_TEXT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop',
  '    DisplayName    REG_SZ    Sparkii',
  '    InstallLocation    REG_SZ    ',
  '    UninstallString    REG_SZ    "D:\\software\\SparkiiPi\\Uninstall Sparkii.exe" /currentuser',
  '',
].join('\r\n');

const NOW = 1_800_000_000_000;
let artifact: Buffer;
let artifactSha512: string;

function makeRelease(): ReleaseJson {
  return {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 11, nonce: 'nonce-A',
    publishedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 72 * HOUR).toISOString(),
    version: NEW, minSupportedVersion: OLD,
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: '断电注入', highlights: ['B④'] },
    artifact: { name: NAME, bytes: artifact.length, sha512: artifactSha512, url: `releases/${NEW}/${NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
  } as ReleaseJson;
}

interface TxnProbe {
  deps: InstallDeps;
  /** 注入的 spawn 时刻读到的哨兵原文（产品代码此刻正好卡在两次原子写之间）。 */
  sentinelDuringSpawn: string | null;
  quit: number;
}

function txnFixture(spawnObserver?: () => void): TxnProbe {
  const watchdog = join(dir, 'update-watchdog.mjs');
  writeAt(dir, 'update-watchdog.mjs', '// 占位：locateWatchdogScript 只判存在性，绝不执行\n');
  const probe: TxnProbe = { deps: {}, sentinelDuringSpawn: null, quit: 0 };
  probe.deps = {
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    quitApp: () => { probe.quit += 1; },
    isUpdatingRef: { value: true },
    shutdownController: { runOnce: async () => [], hasRun: () => true },
    release: makeRelease(),
    readRegistry: async () => REG_TEXT,
    txnId: 'txn-powercut-1',
    pid: 4321,
    execPath: 'D:\\software\\SparkiiPi\\Sparkii.exe',   // 必须落在注册表指向的安装目录内（不变量 4 / R2 · B3）
    watchdogPath: watchdog,
    spawn: () => {
      // 此刻哨兵已由 atomicWriteJson 落盘（phase:prepared），phase 改写尚未发生：
      // 断电若正好发生在这一瞬，磁盘上的哨兵必须是**完整可用**的 JSON。
      probe.sentinelDuringSpawn = existsSync(sentinelPath(dir))
        ? readFileSync(sentinelPath(dir), 'utf8')
        : null;
      spawnObserver?.();
      return { pid: 900001, unref: () => undefined, on: () => undefined };
    },
  };
  return probe;
}

function txnRequest() {
  return {
    dataDir: dir,
    currentVersion: OLD,
    targetVersion: NEW,
    artifactPath: join(pendingVersionDir(dir, NEW), NAME),
    packageSha512: artifactSha512,
    resourcePath: join(dir, 'resources'),
    appId: 'com.sparkii.desktop',
    now: () => NOW,
  };
}

beforeEach(() => {
  resetAuditThrottle();
  root = mkdtempSync(join(tmpdir(), 'sparkii-power-cut-'));
  dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  plantData();
  plantPending(OLD);
  plantPending(NEW);
  // runInstallTransaction 的包体门禁要求真实字节与清单一致（假包体，绝不含安装器语义）
  artifact = Buffer.from(`NSIS-FAKE-BYTES-${NEW}-`.repeat(4));
  artifactSha512 = createHash('sha512').update(artifact).digest('base64');
  writeAt(pendingVersionDir(dir, NEW), NAME, artifact);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ───────────────────────────── 场景① ─────────────────────────────

describe('场景① 哨兵在场、watchdog 未起（写哨兵后现场就没了）', () => {
  beforeEach(async () => {
    await makeRealSnapshot();
    // 步骤 6 刚落盘就断电：phase 仍是 prepared，watchdog 从未被拉起，结果文件不存在
    writeSentinel({ phase: 'prepared', watchdogPid: undefined });
  });

  it('verifyStartup 判为待处理失败态并给出可执行恢复入口（不是静默成功）', async () => {
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.ok).toBe(false);
    expect(verdict.pending).toBe(true);
    expect(verdict.reason).toBe('RESULT_MISSING');
    expect(verdict.txnId).toBe(TXN);
    expect(verdict.targetVersion).toBe(NEW);
    // 恢复入口：契约 §9 映射的 B④ 判据「至少有可执行恢复路径」必须写进结论里
    expect(verdict.message).toContain('安装结果文件缺失');
    expect(verdict.message).toContain('recoverFromSnapshot');
    expect(verdict.message).toContain(pendingRoot(dir));
    expect(verdict.message).toContain(snapshotDir(dir, TXN));
  });

  it('pending/ 的旧包与伴生清单一个都没被删（§7.9 回滚未完成前不得删旧包与对应备份）', async () => {
    await verifyStartup(dir, OLD);
    for (const version of [OLD, NEW]) {
      for (const name of plantPendingNames(version)) {
        expect(existsSync(join(pendingVersionDir(dir, version), name))).toBe(true);
      }
    }
    // 结果文件从未存在，也不得被客户端凭空造出来（写入方唯一 = watchdog）
    expect(existsSync(installResultPath(dir))).toBe(false);
    expect(existsSync(sentinelPath(dir))).toBe(true);   // 线索保留，不擅自抹掉现场
  });

  it('随后再调 pruneRetained 也不得清 pending/（哨兵在场 ⇒ 一律跳过）', async () => {
    await verifyStartup(dir, OLD);
    const report = await pruneRetainedDetailed(dir, DEFAULT_SNAPSHOT_KEEP, { currentVersion: NEW });
    expect(report.pendingSkipped).toBe(true);
    expect(report.reason).toBe('SENTINEL_PRESENT');
    expect(report.pendingRemoved).toEqual([]);
    expectRecoveryMediaIntact();
  });

  it('恢复路径真的可执行：直接拿 verdict.txnId 回灌即可，data\\ 一字未损时也是幂等的', async () => {
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.txnId).toBe(TXN);
    const before = await dataDigests();
    const out = await recoverFromSnapshot(dir, verdict.txnId ?? TXN);
    expect(out).toEqual({ ok: true });
    expect(await dataDigests()).toEqual(before);           // 未破坏完好现场
    expectRecoveryMediaIntact();
    expect(existsSync(join(snapshotDir(dir, TXN), SNAPSHOT_MANIFEST_FILENAME))).toBe(true);
  });
});

// ───────────────────────────── 场景② ─────────────────────────────

describe('场景② install-result.json 明确失败（ok:false / 非零 exitCode）', () => {
  beforeEach(async () => {
    await makeRealSnapshot();
    writeSentinel();
  });

  it('ok:false + 非零 exitCode ⇒ 失败语义（不是静默成功），退出码与 watchdog 原因都在结论里', async () => {
    writeResult({ ok: false, exitCode: 3, reason: 'INSTALLER_EXIT' });
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.ok).toBe(false);
    expect(verdict.pending).toBe(true);
    expect(verdict.reason).toBe('INSTALL_FAILED');
    expect(verdict.txnId).toBe(TXN);
    expect(verdict.message).toContain('exitCode=3');
    expect(verdict.message).toContain('INSTALLER_EXIT');
  });

  it('ok:false + exitCode:null（父进程超时未拉起安装器）同样判失败并保留全部线索', async () => {
    writeResult({ ok: false, exitCode: null, reason: 'PARENT_TIMEOUT' });
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('INSTALL_FAILED');
    expect(verdict.message).toContain('exitCode=null');
    expect(verdict.message).toContain('PARENT_TIMEOUT');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expect(existsSync(installResultPath(dir))).toBe(true);
    expectRecoveryMediaIntact();
  });

  it('结果字段与契约 §6 的 watchdog 写入口径逐字一致：writer 恒为 watchdog', async () => {
    writeResult({ ok: false, exitCode: 1 });
    const read = await readInstallResult(dir);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') throw new Error('unreachable');
    expect(read.value.writer).toBe('watchdog');
    expect(read.value.ok).toBe(false);
    expect(read.value.exitCode).toBe(1);
    expect(read.value.targetVersion).toBe(NEW);
    expect(read.value.packageSha512).toBe(PKG_SHA);
  });

  it('writer 不是 watchdog（customInstall / 人工伪造）⇒ 结果不可用，且绝不因此判成功', async () => {
    writeResult({ writer: 'customInstall' as unknown as 'watchdog' });
    const read = await readInstallResult(dir);
    expect(read.status).toBe('invalid');
    // 无版本证据（仍跑旧版）⇒ 保持现场，RESULT_MISSING，并点名 writer 违规
    const noVersion = await verifyStartup(dir, OLD);
    expect(noVersion.ok).toBe(false);
    expect(noVersion.reason).toBe('RESULT_MISSING');
    expect(noVersion.message).toContain("writer 非 'watchdog'");
    expectRecoveryMediaIntact();
    // 版本证据独立成立（已运行目标版）⇒ 收敛不再 nag，但 ok 仍 false：伪造件不作依据
    const withVersion = await verifyStartup(dir, NEW);
    expect(withVersion.ok).toBe(false);
    expect(withVersion.pending).toBe(false);
    expect(withVersion.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(withVersion.message).toContain('未宣称安装已验证成功');
    expect(withVersion.message).not.toContain('customInstall');
    expectRecoveryMediaIntact();
  });

  it('结果属于别的事务（陈旧残留）⇒ 不得改判成功', async () => {
    writeResult({ targetVersion: '9.9.9', packageSha512: 'stale-sha' });
    // 旧版在跑 ⇒ 陈旧结果既不作成功依据，也不收敛
    const noVersion = await verifyStartup(dir, OLD);
    expect(noVersion.ok).toBe(false);
    expect(noVersion.reason).toBe('RESULT_MISSING');
    expect(noVersion.message).toContain('不匹配');
    expectRecoveryMediaIntact();
    // 目标版在跑 ⇒ 按残留收敛（依据是 app 版本，不是那份陈旧结果）
    const byVersion = await verifyStartup(dir, NEW);
    expect(byVersion.ok).toBe(false);
    expect(byVersion.pending).toBe(false);
    expect(byVersion.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(byVersion.message).not.toContain('9.9.9');
    expectRecoveryMediaIntact();
  });

  it('契约入口与注入入口在同一断电现场结论逐字一致（判定不依赖隐藏时钟或网络）', async () => {
    writeResult({ ok: false, exitCode: 1, reason: 'INSTALLER_EXIT' });
    const plain = await verifyStartup(dir, NEW);
    const injected = await verifyStartupWith(dir, NEW, { now: () => Date.now() });
    expect(injected).toEqual(plain);
    expect(injected.ok).toBe(false);
  });

  it('失败态下恢复介质完好：快照 manifest 仍逐文件可读，data\\ 未被客户端改动', async () => {
    writeResult({ ok: false, exitCode: 2, reason: 'SPAWN_FAILED' });
    const before = await dataDigests();
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.ok).toBe(false);
    expect(await dataDigests()).toEqual(before);
    const manifest = await readSnapshotManifest(dir, TXN);
    expect(manifest?.files.map((f) => f.path).sort()).toEqual(Object.keys(DATA_FILES).sort());
    const out = await recoverFromSnapshot(dir, TXN);
    expect(out.ok).toBe(true);
  });
});

// ───────────────────────────── 场景③ ─────────────────────────────

describe('场景③ 运行版本已到 targetVersion 但哨兵残留', () => {
  it('无结果 + 已过期 ⇒ 幂等清理只清哨兵，二次调用不再提示，且绝不清 pending/ 当前版本包', async () => {
    await makeRealSnapshot();
    const expired = writeSentinel({ expiresAt: Date.now() - 1 });
    // 版本证据不存在（仍在旧版）⇒ 走 expiresAt 驱动的幂等清理 SENTINEL_EXPIRED
    const first = await verifyStartup(dir, OLD);
    expect(first.reason).toBe('SENTINEL_EXPIRED');
    expect(first.pending).toBe(false);
    expect(first.txnId).toBe(expired.txnId);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    const again = await verifyStartup(dir, OLD);
    expect(again.message).toBe('无待处理事务');
    expect(again.ok).toBe(true);
    // 幂等清理只动哨兵本身：当前版本包 + 伴生清单 + 快照全部保留
    for (const name of plantPendingNames(NEW)) {
      expect(existsSync(join(pendingVersionDir(dir, NEW), name))).toBe(true);
    }
    expect(existsSync(join(snapshotDir(dir, TXN), SNAPSHOT_MANIFEST_FILENAME))).toBe(true);
  });

  it('无结果 + 已过期 + 版本已到位 ⇒ 更早一档收敛（不必等 expiresAt），介质同样全部保留', async () => {
    await makeRealSnapshot();
    const expired = writeSentinel({ expiresAt: Date.now() - 1 });
    // ③′ 排在幂等清理之前：版本证据已成立，没必要再拖到 TTL 才停止 nag（G7c 缺陷 1）
    const first = await verifyStartup(dir, NEW);
    expect(first.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(first.pending).toBe(false);
    expect(first.ok).toBe(false);          // 无回传凭据 ⇒ 不宣称已验证成功
    expect(first.txnId).toBe(expired.txnId);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    const again = await verifyStartup(dir, NEW);
    expect(again.message).toBe('无待处理事务');
    for (const name of plantPendingNames(NEW)) {
      expect(existsSync(join(pendingVersionDir(dir, NEW), name))).toBe(true);
    }
    expect(existsSync(join(snapshotDir(dir, TXN), SNAPSHOT_MANIFEST_FILENAME))).toBe(true);
  });

  it('结果明确成功 + 版本已到位 ⇒ 收尾为 INSTALL_OK：清哨兵与结果，保留当前版本包（只删旧版包）', async () => {
    await makeRealSnapshot();
    writeSentinel();
    writeResult();
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.reason).toBe('INSTALL_OK');
    expect(verdict.ok).toBe(true);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(existsSync(installResultPath(dir))).toBe(false);
    for (const name of plantPendingNames(NEW)) {
      expect(existsSync(join(pendingVersionDir(dir, NEW), name))).toBe(true);   // 当前版本包不清
    }
    expect(existsSync(pendingVersionDir(dir, OLD))).toBe(false);                 // 旧版包按 §7.9 清理
  });

  it('结果缺失且未过期 ⇒ 版本未到位时保持现场；版本已到位时收敛（G7c 缺陷 1 的修复点）', async () => {
    await makeRealSnapshot();
    writeSentinel();
    // 仍在旧版 ⇒ 安装可能仍在进行，必须保持现场：既不删包也不误判成功
    const pending = await verifyStartup(dir, OLD);
    expect(pending.ok).toBe(false);
    expect(pending.pending).toBe(true);
    expect(pending.reason).toBe('RESULT_MISSING');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectRecoveryMediaIntact();
    // 同一磁盘现场、版本已到目标 ⇒ 不再 nag（原实现在此处会 TTL 内每次启动报失败）
    const converged = await verifyStartupWith(dir, NEW, { now: () => Date.now() });
    expect(converged.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(converged.pending).toBe(false);
    expect(converged.ok).toBe(false);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expectRecoveryMediaIntact();
    // 二次调用确实不再提示
    const third = await verifyStartup(dir, NEW);
    expect(third.message).toBe('无待处理事务');
  });

  it('哨兵残留时 data\\ 仍是可恢复现场：快照可回灌，回灌不动哨兵与包', async () => {
    const manifest = await makeRealSnapshot();
    writeSentinel();
    writeAt(dir, 'settings.json', 'POST-CRASH-PARTIAL');
    const report = await recoverFromSnapshotDetailed(dir, TXN);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(DATA_FILES['settings.json']);
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expect(report.total).toBe(manifest.files.length);
  });
});

// ───────────────────────────── 场景④ ─────────────────────────────

describe('场景④ 快照在场 + 断电：recoverFromSnapshot 逐文件按 manifest 回灌', () => {
  let manifest: SnapshotManifest;

  beforeEach(async () => {
    manifest = await makeRealSnapshot();
    writeSentinel();
  });

  /** 断电后的典型损坏：半截写 + 内容漂移 + 文件消失。 */
  function damageData(): void {
    writeAt(dir, 'settings.json', '{"update":{"autoCheck":tru');        // 半截 JSON
    writeAt(dir, 'audit.db', 'GARBAGE-PAGE-0');                          // 被改写
    rmSync(join(dir, 'sessions.db'), { force: true });                   // 断电时丢失
    writeAt(dir, 'new-version-data.json', 'written-by-newer-build');     // 快照里没有：新版本写入的数据
    writeAt(dir, 'logs/post-crash.log', 'boot-after-crash');             // 快照里没有：日志
  }

  function shaOfEntry(rel: string): string {
    const entry = manifest.files.find((f) => f.path === rel);
    if (!entry) throw new Error(`manifest 里没有 ${rel}`);
    return entry.sha256;
  }

  it('恢复介质的清单哈希与独立 node:crypto 结果一致（回灌依据可信）', () => {
    for (const [rel, content] of Object.entries(DATA_FILES)) {
      expect(shaOfEntry(rel)).toBe(sha256(content));
    }
  });

  it('被改过的文件回灌成快照版本（逐文件 sha256 前后对比，而不是只看返回码）', async () => {
    damageData();
    // 断电现场的三类损坏各自都可证：改内容 / 半截写 / 文件消失
    expect(existsSync(join(dir, 'sessions.db'))).toBe(false);
    expect(await hashFileSha256(join(dir, 'settings.json'))).not.toBe(shaOfEntry('settings.json'));
    expect(await hashFileSha256(join(dir, 'audit.db'))).not.toBe(shaOfEntry('audit.db'));

    const report = await recoverFromSnapshotDetailed(dir, TXN);
    expect(report.ok).toBe(true);
    expect(report.reason).toBeUndefined();
    expect(report.restored).toBe(manifest.files.length);
    expect(report.total).toBe(manifest.files.length);

    for (const entry of manifest.files) {
      const live = join(dir, ...entry.path.split('/'));
      expect(existsSync(live)).toBe(true);
      expect(await hashFileSha256(live)).toBe(entry.sha256);            // data\ 完整（按快照口径）
      expect(statSync(live).size).toBe(entry.bytes);
    }
    // 断电丢失的 sessions.db 被重新建出来，内容等于快照版本
    expect(readFileSync(join(dir, 'sessions.db'), 'utf8')).toBe(DATA_FILES['sessions.db']);
  });

  it('快照里没有的文件不被删除（保护新版本写入的数据）', async () => {
    damageData();
    const extra = ['new-version-data.json', 'logs/post-crash.log'];
    for (const rel of extra) expect(manifest.files.some((f) => f.path === rel)).toBe(false);
    const extraBefore = extra.map((rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8'));

    const report = await recoverFromSnapshotDetailed(dir, TXN);
    expect(report.ok).toBe(true);
    for (let i = 0; i < extra.length; i += 1) {
      expect(existsSync(join(dir, ...extra[i].split('/')))).toBe(true);
      expect(readFileSync(join(dir, ...extra[i].split('/')), 'utf8')).toBe(extraBefore[i]);
    }
    expect(report.missing).toBe(0);
    expect(report.failed).toBe(0);
  });

  it('回灌对 updates/ 子树不动手：快照本身不在其中，哨兵/包/审计线索都不被覆盖或删除', async () => {
    damageData();
    const updatesBefore = listFiles(updatesDir(dir)).map(async (rel) => [
      rel, await hashFileSha256(join(updatesDir(dir), ...rel.split('/'))),
    ] as const);
    const entries = Object.fromEntries(await Promise.all(updatesBefore));

    const report = await recoverFromSnapshotDetailed(dir, TXN);
    expect(report.ok).toBe(true);
    // 清单里没有任何 updates/ 路径（§7.8 硬护栏 ⇒ 恢复介质不含 updates/）
    expect(manifest.files.some((f) => f.path.split('/')[0] === 'updates')).toBe(false);
    const after = listFiles(updatesDir(dir)).filter((rel) => rel !== 'update-audit-chain.jsonl');
    expect(after).toEqual(Object.keys(entries).filter((rel) => rel !== 'update-audit-chain.jsonl').sort());
    for (const rel of after) {
      expect(await hashFileSha256(join(updatesDir(dir), ...rel.split('/')))).toBe(entries[rel]);
    }
    // 哨兵仍是同一份记录（回灌不得复活旧哨兵之外的任何东西）
    const read = await readSentinel(dir);
    expect(read.status).toBe('ok');
  });

  it('复制中途抛错 ⇒ RECOVER_COPY_FAILED，整体不算成功且已回灌的部分仍保持完整', async () => {
    damageData();
    let calls = 0;
    const report = await recoverFromSnapshotDetailed(dir, TXN, {
      copyFileImpl: async () => {
        calls += 1;
        if (calls === 2) throw new Error('EBUSY: 目标仍被占用（断电后常见）');
      },
    });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('RECOVER_COPY_FAILED');
    expect(report.failed).toBe(1);
    expect(report.restored).toBe(manifest.files.length - 1);
    // 失败也绝不删任何东西：新版本写入的文件仍在
    expect(existsSync(join(dir, 'new-version-data.json'))).toBe(true);
  });

  it('快照自身损坏 ⇒ 该文件绝不回灌（fail closed），其余照常恢复', async () => {
    damageData();
    const victim = manifest.files.find((f) => f.path === 'errors.db')!;
    writeAt(snapshotDir(dir, TXN), 'errors.db', 'SNAPSHOT-CORRUPTED');
    const report = await recoverFromSnapshotDetailed(dir, TXN);
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('RECOVER_HASH_MISMATCH');
    expect(report.mismatched).toBe(1);
    expect(readFileSync(join(dir, 'errors.db'), 'utf8')).not.toBe('SNAPSHOT-CORRUPTED');
    // 脏快照没被当真相：其它文件仍按 manifest 恢复到一致状态
    for (const entry of manifest.files) {
      if (entry.path === victim.path) continue;
      expect(await hashFileSha256(join(dir, ...entry.path.split('/')))).toBe(entry.sha256);
    }
  });

  it('没有快照就没有恢复路径：SNAPSHOT_MISSING 且绝不写盘、绝不删包', async () => {
    damageData();
    const before = await dataDigests();
    const out = await recoverFromSnapshot(dir, 'txn-never-made');
    expect(out).toEqual({ ok: false, reason: 'SNAPSHOT_MISSING' });
    const digests = await dataDigests();
    for (const rel of Object.keys(before)) expect(digests[rel]).toBe(before[rel]);
    expectRecoveryMediaIntact();
  });

  it('契约导出 recoverFromSnapshot 只返回 {ok,reason}（§6 形状），成功回灌写 update.rolledBack 且链自证完好', async () => {
    damageData();
    const append = vi.fn(async (_event: { action: string }) => undefined);
    const shape = await recoverFromSnapshot(dir, TXN);
    expect(Object.keys(shape).sort()).toEqual(['ok', 'reason']);
    const report = await recoverFromSnapshotDetailed(dir, TXN, { audit: { append } });
    expect(report.ok).toBe(true);
    expect(append.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(append.mock.calls[0]![0].action).toBe('update.rolledBack');
    // I-88：用例名写着「链自证完好」，原先正文一条链断言都没有（R15b 域3 第五种假象）。
    expect(readFileSync(auditChainPath(dir), 'utf8')).toContain('update.rolledBack');
    expect((await verifyAuditChain(dir)).ok, '逐条哈希自洽').toBe(true);
  });
});

// ───────────────────────────── 场景⑤ ─────────────────────────────

describe('场景⑤ 半写 / 原子替换：读到的一定是完整 JSON，读不到就 fail closed', () => {
  it('半截 install-result.json（断电截断）⇒ 不擅自修复；版本未到位则报缺失，版本到位则收敛但不宣称成功', async () => {
    await makeRealSnapshot();
    writeSentinel();
    const { path, half } = writeHalfResult();
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).toThrow();   // 现场确实是半截文件
    const read = await readInstallResult(dir);
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') throw new Error('unreachable');
    expect(read.detail).toContain('JSON 解析失败');

    // 旧版仍在跑 ⇒ 保持现场，明确说明「不可解析」
    const noVersion = await verifyStartup(dir, OLD);
    expect(noVersion.ok).toBe(false);
    expect(noVersion.pending).toBe(true);
    expect(noVersion.reason).toBe('RESULT_MISSING');
    expect(noVersion.message).toContain('不可解析');
    expect(readFileSync(path, 'utf8')).toBe(half);                     // 客户端不覆写、不删除线索
    expectRecoveryMediaIntact();

    // 版本已到位 ⇒ 收敛不再 nag；依据是 app 版本而非半截文件，故 ok 仍 false，
    // 且那条线索依旧不动（结果文件归 watchdog 单写，我们不越权删）。
    const converged = await verifyStartup(dir, NEW);
    expect(converged.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(converged.pending).toBe(false);
    expect(converged.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(half);
    expectRecoveryMediaIntact();
  });

  it('半截 pending-update.json ⇒ SENTINEL_INVALID，线索保留、包与快照一个不删', async () => {
    await makeRealSnapshot();
    const half = writeHalfSentinel();
    expect(() => JSON.parse(half)).toThrow();
    const read = await readSentinel(dir);
    expect(read.status).toBe('invalid');
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('SENTINEL_INVALID');
    expect(verdict.txnId).toBeNull();
    expect(verdict.message).toContain('无法解析');
    expect(verdict.message).toContain(pendingRoot(dir));
    // 注：该分支的 message 只说「快照未改动、可从快照回灌」，不给具体 txnId / snapshots 目录
    // （哨兵不可读时确实拿不到 txnId）。见返回报告的「发现的产品缺陷」第 2 条。
    expect(verdict.message).toContain('快照未改动');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectRecoveryMediaIntact();
    // 即使哨兵本身半截了，恢复介质仍自描述：按已知 txnId 一样能把 data\ 灌回完整状态
    const out = await recoverFromSnapshot(dir, TXN);
    expect(out).toEqual({ ok: true });
  });

  it('哨兵写入是原子替换：事务两次原子写之间的任意时刻，磁盘上的哨兵都是完整可用 JSON', async () => {
    const probe = txnFixture();
    const res = await runInstallTransaction(txnRequest(), probe.deps);
    expect(res.ok).toBe(true);

    // ① spawn 时刻（= prepared 已落盘、phase 改写未发生）：断电就发生在这一瞬也必须能读到完整哨兵
    expect(probe.sentinelDuringSpawn).not.toBeNull();
    const mid = JSON.parse(probe.sentinelDuringSpawn!) as SentinelRecord;
    expect(mid.writer).toBe('main');
    expect(mid.phase).toBe('prepared');
    expect(mid.txnId).toBe('txn-powercut-1');
    expect(mid.targetVersion).toBe(NEW);
    expect(mid.snapshotPath).toBe(res.snapshotPath);
    expect(existsSync(mid.snapshotManifestPath)).toBe(true);
    expect(existsSync(mid.artifactPath)).toBe(true);

    // ② 改写完成后仍是**单个完整 JSON 对象**（替换而不是追加，不会拼出第二个顶层对象）
    const finalText = readFileSync(sentinelPath(dir), 'utf8');
    expect(finalText.trimStart().startsWith('{')).toBe(true);
    expect(finalText.trimEnd().endsWith('}')).toBe(true);
    expect(() => JSON.parse(finalText)).not.toThrow();
    const fin = await readSentinel(dir);
    expect(fin.status).toBe('ok');
    if (fin.status === 'ok') expect(fin.value.phase).toBe('watchdog-started');

    // ③ 不留原子写残骸；安装结果文件由 watchdog 单一写入，客户端绝不代写
    expect(readdirSync(updatesDir(dir)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    expect(existsSync(installResultPath(dir))).toBe(false);
  });

  it('原子写中途崩溃的形态：.tmp-* 残骸 + 旧哨兵完整 ⇒ 判定只认旧哨兵，残骸不影响事务', async () => {
    await makeRealSnapshot();
    const s = writeSentinel();
    const orphan = join(updatesDir(dir), `.tmp-9999-deadbeef.json`);
    writeAt(updatesDir(dir), '.tmp-9999-deadbeef.json', JSON.stringify(sentinel({
      txnId: 'txn-half', targetVersion: '9.9.9',
    })));
    ageHours(orphan, 2);

    const read = await readSentinel(dir);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.value.txnId).toBe(s.txnId);   // 绝不半路采纳残骸里的新事务
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.reason).toBe('RESULT_MISSING');
    expect(verdict.txnId).toBe(TXN);

    // 足够老的原子写残骸由 §7.9 保留策略清理，哨兵本身不动
    const report = await pruneRetainedDetailed(dir, DEFAULT_SNAPSHOT_KEEP, { currentVersion: NEW });
    expect(report.orphansRemoved.map((p) => p.replace(/\\/g, '/'))).toContain(orphan.replace(/\\/g, '/'));
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectRecoveryMediaIntact();   // 哨兵在场 ⇒ pending/ 一律不清
  });

  it('客户端不写 install-result.json：断电后 watchdog 是唯一写入方（§7.7 / 契约 §6）', async () => {
    const probe = txnFixture(() => {
      // spawn 时主进程尚未退出，此刻结果文件必然还不存在
      expect(existsSync(installResultPath(dir))).toBe(false);
    });
    const res = await runInstallTransaction(txnRequest(), probe.deps);
    expect(res.ok).toBe(true);
    expect(probe.quit).toBe(1);
    expect(existsSync(installResultPath(dir))).toBe(false);
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.reason).toBe('RESULT_MISSING');       // 没有 watchdog 结果 ⇒ 一律不算成功
  });
});
