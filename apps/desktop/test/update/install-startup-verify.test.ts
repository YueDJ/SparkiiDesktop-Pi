// G7b · 启动自检 / 保留策略 / 快照回灌单测（设计 §7.7 结果回传与恢复、§7.8、§7.9）。
//
// 现场同样是 mkdtempSync 临时目录：绝不跑安装器、绝不写注册表、绝不碰真实
// %LOCALAPPDATA%\SparkiiDesktop\data。
// verifyStartup 的分支表（交接文件第 97 行要求）：成功 / 版本不符 / result 缺失 /
// 过期残留幂等 / 旧包不被误删。pruneRetained 与 recoverFromSnapshot 属同一套「事后处置」
// 语义（§7.9 保留 + §7.7 恢复介质），一并在此覆盖；契约 §9 的 power-cut 注入矩阵未在本文件
// 展开（不在 G7b 交付清单内，见返回报告）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { pendingVersionDir } from '../../electron/main/update/dirs.js';
import {
  DEFAULT_SNAPSHOT_KEEP, INSTALL_RESULT_FILENAME, SENTINEL_FILENAME,
  appendClientAuditChain, auditChainPath, installResultPath, pruneRetained,
  pruneRetainedDetailed, readAuditChain, recoverFromSnapshot, recoverFromSnapshotDetailed,
  sentinelPath, verifyAuditChain, verifyStartup, verifyStartupWith,
} from '../../electron/main/update/installer.js';
import type { InstallResultRecord, SentinelRecord } from '../../electron/main/update/installer.js';

const HOUR = 3_600_000;
const TTL = 30 * 60_000;
const OLD = '0.1.0';
const NEW = '0.2.0';
const NAME = 'Sparkii-0.2.0-win-x64.exe';
const PKG_SHA = createHash('sha512').update('pkg').digest('base64');

let root: string;   // mkdtemp 根：dataDir 是它的子目录，便于测「越界写入」而不触碰系统临时目录本体
let dir: string;    // == <root>/data，即注入的 SPARKII_DATA_DIR

function updatesRoot(): string {
  return join(dir, 'updates');
}

function plantPending(version: string, name = NAME): string {
  const p = join(pendingVersionDir(dir, version), name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'pkg');
  writeFileSync(join(dirname(p), 'release.json'), '{}');
  return p;
}

/** m11：按精确字节数种一个「安装包」，用于字节上限判定。 */
function plantSizedPending(version: string, bytes: number): string {
  const p = join(pendingVersionDir(dir, version), NAME);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'A'.repeat(bytes));
  return p;
}

function sentinel(over: Partial<SentinelRecord> = {}): SentinelRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    txnId: 'txn-1',
    phase: 'watchdog-started',
    fromVersion: OLD,
    targetVersion: NEW,
    packageSha512: PKG_SHA,
    artifactPath: join(pendingVersionDir(dir, NEW), NAME),
    installDir: 'D:\\software\\SparkiiPi',
    snapshotPath: join(updatesRoot(), 'snapshots', 'txn-1'),
    snapshotManifestPath: join(updatesRoot(), 'snapshots', 'txn-1', 'manifest.json'),
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
  mkdirSync(updatesRoot(), { recursive: true });
  writeFileSync(sentinelPath(dir), JSON.stringify(record, null, 2), 'utf8');
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
  mkdirSync(updatesRoot(), { recursive: true });
  writeFileSync(installResultPath(dir), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** 手写一份完整快照（目录 + manifest.json + 逐文件 sha256）。 */
function plantSnapshot(txnId: string, files: Record<string, string>, createdAt: number): string {
  const base = join(updatesRoot(), 'snapshots', txnId);
  mkdirSync(base, { recursive: true });
  const entries = Object.entries(files).map(([rel, content]) => {
    const target = join(base, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return { path: rel, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, mtimeMs: createdAt };
  });
  writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, txnId, createdAt, files: entries, excluded: ['updates'],
  }), 'utf8');
  return base;
}

function ageHours(path: string, hours = 1): void {
  const t = new Date(Date.now() - hours * HOUR);
  utimesSync(path, t, t);
}

function snapshotDirNames(): string[] {
  const base = join(updatesRoot(), 'snapshots');
  return existsSync(base) ? readdirSync(base) : [];
}

beforeEach(() => {
  resetAuditThrottle();                        // 审计按「类型+天」限流：逐用例复位才可比对
  root = mkdtempSync(join(tmpdir(), 'sparkii-startup-verify-'));
  dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('无待处理事务', () => {
  it('契约 §1.9 目录布局：哨兵与结果文件都在 <dataDir>/updates/ 之下', () => {
    expect(sentinelPath(dir)).toBe(join(dir, 'updates', SENTINEL_FILENAME));
    expect(installResultPath(dir)).toBe(join(dir, 'updates', INSTALL_RESULT_FILENAME));
  });

  it('哨兵不在 ⇒ 逐字返回 {ok:true,pending:false,txnId:null,targetVersion:null,message:无待处理事务}', async () => {
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict).toEqual({
      ok: true, pending: false, txnId: null, targetVersion: null, message: '无待处理事务',
    });
    // 零写盘：连 updates/ 都不该被创建
    expect(existsSync(updatesRoot())).toBe(false);
    expect(existsSync(auditChainPath(dir))).toBe(false);
  });

  it('哨兵不在但残留 install-result.json：不改判、不删任何东西（无事务可归属）', async () => {
    mkdirSync(updatesRoot(), { recursive: true });
    writeFileSync(installResultPath(dir), JSON.stringify(result()), 'utf8');
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.message).toBe('无待处理事务');
    expect(existsSync(installResultPath(dir))).toBe(true);
  });

  it('契约入口与注入入口对同一现场结论一致', async () => {
    writeSentinel();
    const plain = await verifyStartup(dir, OLD);
    const injected = await verifyStartupWith(dir, OLD, { now: () => Date.now() });
    expect(injected.reason).toBe(plain.reason);
  });
});

describe('成功分支（清事务记录 + 保留当前版本包）', () => {
  beforeEach(() => {
    plantPending(NEW);
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    writeSentinel();
    writeResult();
    plantSnapshot('s-old', { 'settings.json': 'a' }, Date.now() - 10 * HOUR);
    plantSnapshot('s-mid', { 'settings.json': 'b' }, Date.now() - 5 * HOUR);
    plantSnapshot('txn-1', { 'settings.json': 'c' }, Date.now() - HOUR);
  });

  it('currentVersion === targetVersion 且 result.ok ⇒ INSTALL_OK，哨兵与结果文件被清', async () => {
    const verdict = await verifyStartupWith(dir, NEW, { audit: { append: vi.fn(async () => undefined) } });
    expect(verdict.ok).toBe(true);
    expect(verdict.pending).toBe(false);
    expect(verdict.reason).toBe('INSTALL_OK');
    expect(verdict.txnId).toBe('txn-1');
    expect(verdict.targetVersion).toBe(NEW);
    expect(verdict.message).toContain('升级完成');
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(existsSync(installResultPath(dir))).toBe(false);
  });

  it('保留当前版本包，删除旧版本包（§7.9）', async () => {
    await verifyStartupWith(dir, NEW);
    expect(existsSync(join(pendingVersionDir(dir, NEW), NAME))).toBe(true);
    expect(existsSync(pendingVersionDir(dir, OLD))).toBe(false);
  });

  it('快照只保留最近 keep 份（默认 DEFAULT_SNAPSHOT_KEEP）', async () => {
    await verifyStartupWith(dir, NEW);
    const kept = snapshotDirNames().filter((n) => !n.startsWith('.tmp-')).sort();
    expect(kept.length).toBe(DEFAULT_SNAPSHOT_KEEP);
    expect(kept).toContain('txn-1');       // 最新
    expect(kept).toContain('s-mid');       // 次新
    expect(kept).not.toContain('s-old');   // 最旧被清
  });

  it('opts.keep 可覆盖保留份数', async () => {
    await verifyStartupWith(dir, NEW, { keep: 1 });
    const kept = snapshotDirNames().filter((n) => !n.startsWith('.tmp-'));
    expect(kept).toEqual(['txn-1']);
  });

  it('写 update.completed 与 update.cleanup 审计（AuditStore 注入 + 本地链）', async () => {
    const append = vi.fn(async () => undefined);
    await verifyStartupWith(dir, NEW, { audit: { append } });
    const actions = append.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('update.completed');
    expect(actions).toContain('update.cleanup');
    const chainActions = (await readAuditChain(dir)).map((r) => r.event.action);
    expect(chainActions).toContain('update.completed');
    expect(chainActions).toContain('update.cleanup');
    expect((await verifyAuditChain(dir)).ok).toBe(true);
  });

  it('清掉足够老的 .part 与 .tmp-* 孤儿，保留在途的（§7.9）', async () => {
    const stalePart = join(pendingVersionDir(dir, NEW), 'Sparkii.part');
    writeFileSync(stalePart, 'partial');
    ageHours(stalePart, 2);
    const freshPart = join(pendingVersionDir(dir, NEW), 'fresh.part');
    writeFileSync(freshPart, 'partial');
    const staleTmp = join(updatesRoot(), 'snapshots', '.tmp-abort');
    mkdirSync(staleTmp, { recursive: true });
    writeFileSync(join(staleTmp, 'x'), 'half', 'utf8');
    ageHours(staleTmp, 2);
    const freshTmp = join(updatesRoot(), 'snapshots', '.tmp-inflight');
    mkdirSync(freshTmp, { recursive: true });

    await verifyStartupWith(dir, NEW);
    expect(existsSync(stalePart)).toBe(false);
    expect(existsSync(freshPart)).toBe(true);      // 可能是进行中的下载，不动
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);       // 可能是进行中的快照，不动
  });

  it('成功后二次调用 ⇒ 回到「无待处理事务」（幂等）', async () => {
    await verifyStartupWith(dir, NEW);
    expect((await verifyStartup(dir, NEW)).message).toBe('无待处理事务');
  });
});

describe('失败态：旧包与快照一律不动，给出可执行恢复路径', () => {
  function expectUntouched(): void {
    expect(existsSync(join(pendingVersionDir(dir, NEW), NAME))).toBe(true);
    expect(existsSync(join(pendingVersionDir(dir, OLD), 'Sparkii-0.1.0-win-x64.exe'))).toBe(true);
    expect(existsSync(join(updatesRoot(), 'snapshots', 'txn-1', 'manifest.json'))).toBe(true);
  }

  beforeEach(() => {
    plantPending(NEW);
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    plantSnapshot('txn-1', { 'settings.json': 'c' }, Date.now() - HOUR);
  });

  it('版本不符（result.ok 但运行版本仍是旧版）⇒ VERSION_MISMATCH，全部保留', async () => {
    writeSentinel();
    writeResult();
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.ok).toBe(false);
    expect(verdict.pending).toBe(true);
    expect(verdict.reason).toBe('VERSION_MISMATCH');
    expect(verdict.message).toContain('安装目录');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expect(existsSync(installResultPath(dir))).toBe(true);
    expectUntouched();
  });

  it('result.ok === false ⇒ INSTALL_FAILED，退出码与 watchdog 原因进消息', async () => {
    writeSentinel();
    writeResult({ ok: false, exitCode: 3, reason: 'SPAWN_FAILED' });
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.reason).toBe('INSTALL_FAILED');
    expect(verdict.message).toContain('exitCode=3');
    expect(verdict.message).toContain('SPAWN_FAILED');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectUntouched();
  });

  it('watchdog 提前退出（exitCode=null）⇒ 文案区分「安装未执行」而不是「安装器返回失败」', async () => {
    writeSentinel();
    writeResult({ ok: false, exitCode: null, reason: 'INSTALLER_HASH_MISMATCH' });
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.reason).toBe('INSTALL_FAILED');
    expect(verdict.message).toContain('安装未执行');
    expect(verdict.message).toContain('INSTALLER_HASH_MISMATCH');
    expect(verdict.message).not.toContain('安装器返回失败');
  });

  it('result 文件缺失（未过期）⇒ RESULT_MISSING，不删任何东西、不幂等清哨兵', async () => {
    writeSentinel();
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.reason).toBe('RESULT_MISSING');
    expect(verdict.pending).toBe(true);
    expect(verdict.message).toContain('安装结果文件缺失');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectUntouched();
  });

  it('结果文件属于别的事务 ⇒ 陈旧结果本身绝不作为成功依据', async () => {
    writeSentinel({ txnId: 'txn-2', targetVersion: NEW, packageSha512: PKG_SHA });
    writeResult({ targetVersion: '9.9.9', packageSha512: 'other-sha' });
    // 版本证据不存在（仍在旧版）⇒ 保持现场，RESULT_MISSING
    const stale = await verifyStartup(dir, OLD);
    expect(stale.reason).toBe('RESULT_MISSING');
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain('不匹配');
    expectUntouched();
    // 版本证据独立成立（运行版本已是 NEW）⇒ 收敛为成功收尾，
    // 但依据只能是 app 版本，不是那份陈旧结果（陈旧结果仍被忽略，也不被删除）。
    const byVersion = await verifyStartup(dir, NEW);
    expect(byVersion.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(byVersion.pending).toBe(false);
    expect(byVersion.message).not.toContain('9.9.9');
    expect(existsSync(sentinelPath(dir))).toBe(false);        // 幂等清理只清哨兵
    expect(existsSync(installResultPath(dir))).toBe(true);    // 结果归 watchdog 单写，我们不越权删
    expectUntouched();
  });

  it('结果文件的 writer 不是 watchdog ⇒ 结果不可用（写入方唯一性）', async () => {
    writeSentinel();
    mkdirSync(updatesRoot(), { recursive: true });
    writeFileSync(installResultPath(dir), JSON.stringify({ ...result(), writer: 'customInstall' }), 'utf8');
    // 无版本证据时：结果被判不可用，且不因此判成功
    const noVersion = await verifyStartup(dir, OLD);
    expect(noVersion.reason).toBe('RESULT_MISSING');
    expect(noVersion.message).toContain("writer 非 'watchdog'");
    expectUntouched();
    // 有版本证据时：按残留收敛（pending:false 不再报失败），但**不宣称安装已验证成功**，
    // 也不把那份伪造结果当依据。
    const withVersion = await verifyStartup(dir, NEW);
    expect(withVersion.reason).toBe('RESULT_MISSING_BUT_VERSION_OK');
    expect(withVersion.pending).toBe(false);
    expect(withVersion.ok).toBe(false);
    expect(withVersion.message).toContain('未宣称安装已验证成功');
    expect(withVersion.message).not.toContain('customInstall');
    expectUntouched();
  });

  it('哨兵 JSON 损坏 ⇒ SENTINEL_INVALID，保留线索且不删包', async () => {
    mkdirSync(updatesRoot(), { recursive: true });
    writeFileSync(sentinelPath(dir), '{ this is not json', 'utf8');
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.reason).toBe('SENTINEL_INVALID');
    expect(verdict.txnId).toBeNull();
    expect(verdict.message).toContain('无法解析');
    expect(existsSync(sentinelPath(dir))).toBe(true);
    expectUntouched();
  });

  it('哨兵字段非法（schemaVersion 非 1）⇒ 同样 SENTINEL_INVALID', async () => {
    writeSentinel({ schemaVersion: 2 } as Partial<SentinelRecord>);
    expect((await verifyStartup(dir, NEW)).reason).toBe('SENTINEL_INVALID');
    expectUntouched();
  });
});

describe('过期残留的幂等清理', () => {
  beforeEach(() => {
    plantPending(NEW);
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    plantSnapshot('txn-1', { 'settings.json': 'c' }, Date.now() - HOUR);
  });

  it('哨兵过期 + 无结果 ⇒ 只清哨兵本身，包与快照全留，并写 update.cleanup', async () => {
    const expired = writeSentinel({ expiresAt: Date.now() - 1 });
    const append = vi.fn(async () => undefined);
    const verdict = await verifyStartupWith(dir, OLD, { audit: { append } });
    expect(verdict.reason).toBe('SENTINEL_EXPIRED');
    expect(verdict.pending).toBe(false);
    expect(verdict.txnId).toBe(expired.txnId);
    expect(verdict.message).toContain('过期');
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(existsSync(join(pendingVersionDir(dir, NEW), NAME))).toBe(true);
    expect(existsSync(join(pendingVersionDir(dir, OLD), 'Sparkii-0.1.0-win-x64.exe'))).toBe(true);
    expect(existsSync(join(updatesRoot(), 'snapshots', 'txn-1', 'manifest.json'))).toBe(true);
    expect((await readAuditChain(dir)).some((r) => r.event.scope === 'expired-sentinel')).toBe(true);
  });

  it('二次调用不再提示（幂等）', async () => {
    writeSentinel({ expiresAt: Date.now() - 1 });
    await verifyStartup(dir, OLD);
    const again = await verifyStartup(dir, OLD);
    expect(again.message).toBe('无待处理事务');
    expect(again.ok).toBe(true);
  });

  it('phase 仍为 prepared 的过期残留（watchdog 从未拉起）同样被清', async () => {
    writeSentinel({ phase: 'prepared', expiresAt: Date.now() - 1 });
    expect((await verifyStartup(dir, OLD)).reason).toBe('SENTINEL_EXPIRED');
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('过期但有终局失败结果 ⇒ 优先报告失败并保留哨兵（不清线索）', async () => {
    writeSentinel({ expiresAt: Date.now() - 1 });
    writeResult({ ok: false, exitCode: 2, reason: 'PARENT_TIMEOUT' });
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.reason).toBe('INSTALL_FAILED');
    expect(existsSync(sentinelPath(dir))).toBe(true);
  });

  it('过期 + 结果明确成功 + 版本已到位 ⇒ 仍判成功（TTL 不覆盖既成事实）', async () => {
    writeSentinel({ expiresAt: Date.now() - 1 });
    writeResult();
    const verdict = await verifyStartup(dir, NEW);
    expect(verdict.reason).toBe('INSTALL_OK');
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });
});

describe('pruneRetained / pruneRetainedDetailed（§7.9）', () => {
  it('哨兵在场 ⇒ 一律不清 pending/，reason=SENTINEL_PRESENT', async () => {
    plantPending(NEW);
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    const stalePart = join(pendingVersionDir(dir, NEW), 'x.part');
    writeFileSync(stalePart, 'p');
    ageHours(stalePart, 3);
    writeSentinel();
    const report = await pruneRetainedDetailed(dir, 5, { currentVersion: NEW });
    expect(report.pendingSkipped).toBe(true);
    expect(report.reason).toBe('SENTINEL_PRESENT');
    expect(existsSync(pendingVersionDir(dir, OLD))).toBe(true);
    expect(existsSync(stalePart)).toBe(true);   // .part 也在 pending/ 内 ⇒ 同样不动
  });

  it('currentVersion 未知 ⇒ 不清 pending/（无法判定哪份是当前版本包）', async () => {
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    const report = await pruneRetainedDetailed(dir, 5, {});
    expect(report.pendingSkipped).toBe(true);
    expect(report.reason).toBe('CURRENT_VERSION_UNKNOWN');
    expect(existsSync(pendingVersionDir(dir, OLD))).toBe(true);
  });

  it('哨兵 JSON 损坏也算「在场」：状态不明绝不删旧包（fail closed）', async () => {
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    mkdirSync(updatesRoot(), { recursive: true });
    writeFileSync(sentinelPath(dir), 'garbage', 'utf8');
    const report = await pruneRetainedDetailed(dir, 5, { currentVersion: NEW });
    expect(report.pendingSkipped).toBe(true);
    expect(existsSync(pendingVersionDir(dir, OLD))).toBe(true);
  });

  it('哨兵在场时仍保留它引用的那份快照（即使超出 keep）', async () => {
    writeSentinel({ txnId: 'txn-old' });
    plantSnapshot('txn-old', { 'settings.json': 'a' }, Date.now() - 100 * HOUR);
    plantSnapshot('s1', { 'settings.json': 'b' }, Date.now() - HOUR);
    plantSnapshot('s2', { 'settings.json': 'c' }, Date.now() - 2 * HOUR);
    const report = await pruneRetainedDetailed(dir, 1, {});
    expect(report.snapshotsKept).toContain('txn-old');
    expect(existsSync(join(updatesRoot(), 'snapshots', 'txn-old', 'manifest.json'))).toBe(true);
    expect(report.snapshotsRemoved).toEqual(['s2']);
  });

  it('没有 manifest.json 的目录按 mtime 参与排序，不会被当作可用快照留下', async () => {
    plantSnapshot('s-new', { 'settings.json': 'a' }, Date.now());
    const broken = join(updatesRoot(), 'snapshots', 's-broken');
    mkdirSync(broken, { recursive: true });
    ageHours(broken, 50);                       // 够老 ⇒ 排序落在最后，keep=1 时被清
    const report = await pruneRetainedDetailed(dir, 1, {});
    expect(report.snapshotsKept).toContain('s-new');
    expect(report.snapshotsRemoved).toContain('s-broken');
  });

  it('契约导出 pruneRetained(dataDir, keep) 返回 Promise<void> 且不抛错', async () => {
    plantPending(OLD, 'Sparkii-0.1.0-win-x64.exe');
    plantSnapshot('s1', { 'settings.json': 'a' }, Date.now() - HOUR);
    await expect(pruneRetained(dir, 3)).resolves.toBeUndefined();
    expect(existsSync(auditChainPath(dir))).toBe(true);
  });

  it('updates/ 根下足够老的 .tmp-*.json 原子写残骸被清', async () => {
    mkdirSync(updatesRoot(), { recursive: true });
    const orphan = join(updatesRoot(), '.tmp-1234-abc.json');
    writeFileSync(orphan, '{}', 'utf8');
    ageHours(orphan, 2);
    const report = await pruneRetainedDetailed(dir, 1, {});
    expect(report.orphansRemoved.map((p) => p.replace(/\\/g, '/'))).toContain(orphan.replace(/\\/g, '/'));
    expect(existsSync(orphan)).toBe(false);
  });

  // ── m11 字节上限（§7.9「总容量上限（如 1.5× 包体）」）────────────────────────
  it('m11：超上限时先驱逐最旧的失败残留，再驱逐旧快照；当前版本包与最新快照永不驱逐', async () => {
    const currentPkg = plantSizedPending(NEW, 1000);
    const failedNewer = plantSizedPending('0.3.0', 1000);
    const failedOlder = plantSizedPending(OLD, 1000);
    // 年龄：0.1.0 最旧 → 0.3.0 → 0.2.0（当前）
    ageHours(dirname(failedOlder), 3);
    ageHours(dirname(failedNewer), 1);
    const sOld = plantSnapshot('s-old', { 'settings.json': 'x'.repeat(300) }, Date.now() - 3 * HOUR);
    const sNew = plantSnapshot('s-new', { 'settings.json': 'y'.repeat(300) }, Date.now());

    const report = await pruneRetainedDetailed(dir, 10, { currentVersion: NEW, byteCapOnly: true, limitBytes: 900 });

    expect(report.byteCapBytes).toBe(900);
    expect(report.byteCapApplied).toBe(true);
    expect(report.bytesBefore!).toBeGreaterThan(900);
    // 顺序：最旧失败包 → 次旧失败包 → 最旧快照；最新快照被保护 ⇒ 到此停止（可能仍高于上限）
    expect(report.evictedForCap).toEqual(['pending/0.1.0', 'pending/0.3.0', 'snapshots/s-old']);
    // 当前版本包、最新快照仍在
    expect(existsSync(currentPkg)).toBe(true);
    expect(existsSync(sNew)).toBe(true);
    expect(existsSync(sOld)).toBe(false);
    expect(report.bytesAfter!).toBeLessThan(report.bytesBefore!);
    // 审计留痕
    expect((await readAuditChain(dir)).some((r) => r.event.action === 'update.cleanup')).toBe(true);
  });

  it('m11 承重不变量：哨兵在场 ⇒ pending/ 一律不驱逐（即使远超上限）', async () => {
    writeSentinel();
    const currentPkg = plantSizedPending(NEW, 1000);
    const oldPkg = plantSizedPending(OLD, 1000);
    const report = await pruneRetainedDetailed(dir, 5, { currentVersion: NEW, limitBytes: 1 });
    expect(report.pendingSkipped).toBe(true);
    expect(report.evictedForCap.filter((l) => l.startsWith('pending/'))).toEqual([]);
    expect(existsSync(currentPkg)).toBe(true);
    expect(existsSync(oldPkg)).toBe(true);
  });

  it('m11 承重不变量：byteCapOnly 模式下哨兵在场同样不驱逐 pending', async () => {
    writeSentinel();
    const oldPkg = plantSizedPending(OLD, 1000);
    const report = await pruneRetainedDetailed(dir, 5, {
      currentVersion: NEW, byteCapOnly: true, limitBytes: 1,
    });
    expect(report.pendingSkipped).toBe(true);
    expect(report.evictedForCap.filter((l) => l.startsWith('pending/'))).toEqual([]);
    expect(existsSync(oldPkg)).toBe(true);
  });

  it('m11 承重不变量：哨兵引用的那一份快照永不驱逐', async () => {
    writeSentinel({ txnId: 'txn-old' });
    const protectedSnap = plantSnapshot('txn-old', { 'settings.json': 'z'.repeat(500) }, Date.now() - 5 * HOUR);
    const middle = plantSnapshot('s-middle', { 'settings.json': 'm'.repeat(500) }, Date.now() - 2 * HOUR);
    const newest = plantSnapshot('s-newest', { 'settings.json': 'n'.repeat(500) }, Date.now());
    const report = await pruneRetainedDetailed(dir, 10, { limitBytes: 1 });
    expect(report.evictedForCap).toContain('snapshots/s-middle');
    expect(report.evictedForCap).not.toContain('snapshots/txn-old');
    expect(report.evictedForCap).not.toContain('snapshots/s-newest');
    expect(existsSync(protectedSnap)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(middle)).toBe(false);
  });

  it('m11：byteCapOnly 不按数量清旧包（失败现场的常规回滚介质保留）', async () => {
    const oldPkg = plantSizedPending(OLD, 1000);
    const currentPkg = plantSizedPending(NEW, 1000);
    // 常规 prune(keep=0, currentVersion=NEW) 会删掉 0.1.0；byteCapOnly + 远高于总量的上限 ⇒ 一个不删。
    const report = await pruneRetainedDetailed(dir, 0, {
      currentVersion: NEW, byteCapOnly: true, limitBytes: 10_000_000,
    });
    expect(report.evictedForCap).toEqual([]);
    expect(existsSync(oldPkg)).toBe(true);
    expect(existsSync(currentPkg)).toBe(true);
  });

  it('m11：未显式给 limitBytes 时按 1.5× 包体（当前版本包的最大文件）计算', async () => {
    const MiB = 1024 * 1024;
    plantSizedPending(NEW, 2 * MiB);
    plantSizedPending(OLD, 2 * MiB);
    const report = await pruneRetainedDetailed(dir, 5, { currentVersion: NEW, byteCapOnly: true });
    expect(report.byteCapBytes).toBe(3 * MiB);       // 2 MiB × 1.5
    expect(report.evictedForCap).toContain('pending/0.1.0');
    expect(existsSync(join(dir, 'updates', 'pending', OLD))).toBe(false);
    expect(existsSync(join(dir, 'updates', 'pending', NEW))).toBe(true);
  });

  it('m11：包体参考小于 1 MiB（合成 / 损坏现场）⇒ 不据它设上限，避免清空恢复介质', async () => {
    plantSizedPending(NEW, 1000);
    plantSizedPending(OLD, 1000);
    const report = await pruneRetainedDetailed(dir, 5, { currentVersion: NEW, byteCapOnly: true });
    expect(report.byteCapBytes).toBeUndefined();
    expect(report.evictedForCap).toEqual([]);
    expect(existsSync(join(dir, 'updates', 'pending', OLD))).toBe(true);
  });

  it('m11：过期事务的启动自检会触发字节上限清理（失败累积不再无限增长）', async () => {
    const MiB = 1024 * 1024;
    // 当前运行版本是 OLD（不命中也 target）⇒ 走④过期分支；0.2.0 是一次失败的下载残留。
    const currentPkg = plantSizedPending(OLD, 2 * MiB);
    const failedPkg = plantSizedPending(NEW, 2 * MiB);
    writeSentinel({ expiresAt: Date.now() - HOUR });
    const verdict = await verifyStartup(dir, OLD);
    expect(verdict.reason).toBe('SENTINEL_EXPIRED');
    expect(verdict.message).toContain('字节上限');
    expect(existsSync(failedPkg)).toBe(false);
    expect(existsSync(currentPkg)).toBe(true);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });
});

describe('recoverFromSnapshot（§7.7 恢复介质 / 只覆盖不删除）', () => {
  it('按 manifest 逐文件回灌；快照里没有的文件保持现状（绝不删除）', async () => {
    writeFileSync(join(dir, 'settings.json'), 'NEWER-BUT-WRONG', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'not-in-snapshot', 'utf8');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'a.log'), 'log-a', 'utf8');
    const base = plantSnapshot('txn-1', { 'settings.json': 'OLD-GOOD', 'logs/a.log': 'log-a-old' }, Date.now());

    const report = await recoverFromSnapshotDetailed(dir, 'txn-1');
    expect(report.ok).toBe(true);
    expect(report.restored).toBe(2);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('OLD-GOOD');
    expect(readFileSync(join(dir, 'logs', 'a.log'), 'utf8')).toBe('log-a-old');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('not-in-snapshot');   // 未被删
    expect(existsSync(base)).toBe(true);                                            // 快照本身保留
  });

  it('快照文件与 manifest 不符 ⇒ 不回灌该文件，整体判 RECOVER_HASH_MISMATCH', async () => {
    writeFileSync(join(dir, 'settings.json'), 'CURRENT', 'utf8');
    const base = plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    writeFileSync(join(base, 'settings.json'), 'CORRUPTED-IN-SNAPSHOT', 'utf8');

    const report = await recoverFromSnapshotDetailed(dir, 'txn-1');
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('RECOVER_HASH_MISMATCH');
    expect(report.mismatched).toBe(1);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('CURRENT');   // 目标不被脏数据覆盖
  });

  it('manifest 里的越界路径（..）⇒ 拒绝，目录外没有任何写入', async () => {
    const base = plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    const escaped = join(dirname(dir), 'sparkii-escape-victim.txt');
    writeFileSync(escaped, 'do-not-touch', 'utf8');
    const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string; bytes: number; mtimeMs: number }>;
    };
    manifest.files.push({
      path: '../sparkii-escape-victim.txt',
      sha256: createHash('sha256').update('evil').digest('hex'),
      bytes: 3, mtimeMs: 1,
    });
    writeFileSync(join(base, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const report = await recoverFromSnapshotDetailed(dir, 'txn-1');
    expect(report.refused).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('RECOVER_PATH_REFUSED');
    expect(readFileSync(escaped, 'utf8')).toBe('do-not-touch');
    rmSync(escaped, { force: true });
  });

  it('manifest 里的 updates/ 路径 ⇒ 拒绝（回灌不得复活旧哨兵 / 旧状态）', async () => {
    const base = plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as { files: unknown[] };
    manifest.files.push({ path: 'updates/pending-update.json', sha256: 'x', bytes: 1, mtimeMs: 1 });
    writeFileSync(join(base, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    const report = await recoverFromSnapshotDetailed(dir, 'txn-1');
    expect(report.refused).toBe(1);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('快照目录缺文件 ⇒ RECOVER_SOURCE_MISSING；已复制成功的仍保留', async () => {
    writeFileSync(join(dir, 'settings.json'), 'CURRENT', 'utf8');
    const base = plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    rmSync(join(base, 'settings.json'), { force: true });
    const report = await recoverFromSnapshotDetailed(dir, 'txn-1');
    expect(report.missing).toBe(1);
    expect(report.reason).toBe('RECOVER_SOURCE_MISSING');
    expect(report.ok).toBe(false);
  });

  it('复制实现抛错 ⇒ RECOVER_COPY_FAILED（注入缝，单测仍不碰真机）', async () => {
    plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    const report = await recoverFromSnapshotDetailed(dir, 'txn-1', {
      copyFileImpl: async () => { throw new Error('EBUSY'); },
    });
    expect(report.failed).toBe(1);
    expect(report.reason).toBe('RECOVER_COPY_FAILED');
    expect(report.ok).toBe(false);
  });

  it('txnId 形态非法 / 读不到 manifest ⇒ 明确 reason，不写盘', async () => {
    expect(await recoverFromSnapshot(dir, '../../etc')).toEqual({ ok: false, reason: 'TXNID_INVALID' });
    expect(await recoverFromSnapshot(dir, 'nope')).toEqual({ ok: false, reason: 'SNAPSHOT_MISSING' });
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('成功回灌写 update.rolledBack（审计注入 + 本地链）', async () => {
    plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    const append = vi.fn(async () => undefined);
    const report = await recoverFromSnapshotDetailed(dir, 'txn-1', { audit: { append } });
    expect(report.ok).toBe(true);
    expect((append.mock.calls[0]![0] as { action: string }).action).toBe('update.rolledBack');
    expect((await readAuditChain(dir)).some((r) => r.event.action === 'update.rolledBack')).toBe(true);
  });

  it('契约导出 recoverFromSnapshot 只返回 {ok,reason}', async () => {
    plantSnapshot('txn-1', { 'settings.json': 'GOOD' }, Date.now());
    const out = await recoverFromSnapshot(dir, 'txn-1');
    expect(Object.keys(out).sort()).toEqual(['ok', 'reason']);
    expect(out.ok).toBe(true);
    expect(out.reason).toBeUndefined();
  });
});

describe('审计链与安装事务的联动（链不被事务自身写坏）', () => {
  it('verifyStartup 的写入始终让链保持自洽', async () => {
    await appendClientAuditChain(dir, { action: 'update.install-start', txnId: 'txn-1' });
    plantPending(NEW);
    writeSentinel();
    writeResult();
    plantSnapshot('txn-1', { 'settings.json': 'c' }, Date.now());
    await verifyStartup(dir, NEW);
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(true);
    expect(verdict.count).toBeGreaterThanOrEqual(3);
  });
});
