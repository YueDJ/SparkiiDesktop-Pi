// G7b · 安装事务单测（契约 §9 映射 B①「关机顺序 / 安装事务」，设计 §7.7）。
//
// 现场：mkdtempSync 系统临时目录 + 假依赖（假注册表文本、假 spawn、注入时钟）。
// 绝不真 spawn 任何东西、绝不跑 NSIS /S、绝不写注册表、绝不碰真实
// %LOCALAPPDATA%\SparkiiDesktop\data —— 所有落盘都发生在临时目录内。
//
// 覆盖交接文件的 6 条要求：
//   ① 成功链路 + 严格顺序 verifyArtifactBytes → resolveInstallDirectory → runOnce → 快照
//      → 写哨兵 → spawn → quitApp
//   ② sha512 不符 ⇒ ARTIFACT_INVALID 且没有调用 runOnce
//   ③ controller 缺失 ⇒ INSTALL_BLOCKED
//   ④ watchdog 缺件 ⇒ 不留下孤儿哨兵且 isUpdatingRef 被撤销
//   ⑤ /D= 参数位置与不加引号
//   ⑥ 快照失败 ⇒ 不写哨兵
// 另加：不重复整份快照（复用关库钩子产物）、expiresAt 取 min、runOnce 抛错、
//      无 pid 的 spawn 视为失败、artifactPath 形态门禁、请求形态门禁。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuditThrottle } from '../../electron/main/update/audit.js';
import { pendingVersionDir } from '../../electron/main/update/dirs.js';
import { createShutdownController } from '../../electron/main/update-bootstrap.js';
import {
  DEFAULT_SNAPSHOT_KEEP, INSTALL_RESULT_FILENAME, SENTINEL_FILENAME,
  auditChainPath, assertInstallDirAnchored, deployedWatchdogPath, installResultPath, isPathInside,
  locateWatchdogBinary,
  resolveInstallDirectoryWith,
  runInstallTransaction, sentinelPath, snapshotDataDir, verifyAuditChain,
  watchdogBinaryCandidatePaths,
} from '../../electron/main/update/installer.js';
import type {
  InstallDeps, InstallRequest, SpawnOptionsLike, SpawnedChildLike,
} from '../../electron/main/update/installer.js';
import type { ChannelJson, ReleaseJson } from '../../electron/main/update/types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const VERSION = '0.2.0';
const NAME = 'Sparkii-0.2.0-win-x64.exe';
/** 本机实测形态（task0-results D-2）：InstallLocation 为空，只能靠 UninstallString 回退。 */
const REG_TEXT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop',
  '    DisplayName    REG_SZ    Sparkii',
  '    InstallLocation    REG_SZ    ',
  '    UninstallString    REG_SZ    "D:\\software\\SparkiiPi\\Uninstall Sparkii.exe" /currentuser',
  '',
].join('\r\n');
const EXPECTED_DIR = 'D:\\software\\SparkiiPi';

/** 排空 microtask 队列：blocked() 请求退出走的是 queueMicrotask，同步断言看不到。 */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

let dir: string;
let artifact: Buffer;
let sha512: string;

function makeRelease(over: Partial<ReleaseJson> = {}): ReleaseJson {
  return {
    schemaVersion: 2, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
    sequence: 11, nonce: 'nonce-A',
    publishedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 72 * HOUR).toISOString(),
    version: VERSION, minSupportedVersion: '0.1.0',
    rollback: false, allowDowngrade: false, mandatory: false, mandatoryAfter: null,
    rollout: { percentage: 100, salt: 's' },
    releaseNotes: { summary: '安装事务', highlights: ['B 关'] },
    artifact: { name: NAME, bytes: artifact.length, sha512, url: `releases/${VERSION}/${NAME}` },
    requires: { minOSBuild: '10.0.0', minFreeDiskBytes: 0 },
    ...over,
  } as ReleaseJson;
}

function req(over: Partial<InstallRequest> = {}): InstallRequest {
  return {
    dataDir: dir,
    currentVersion: '0.1.0',
    targetVersion: VERSION,
    artifactPath: join(pendingVersionDir(dir, VERSION), NAME),
    packageSha512: sha512,
    resourcePath: join(dir, 'resources'),
    appId: 'com.sparkii.desktop',
    now: () => NOW,
    ...over,
  };
}

interface Recorder {
  steps: string[];
  spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptionsLike }>;
  unref: number;
  runOnce: number;
  quit: number;
  sentinelAbsentAtRunOnce: boolean | null;
}

/** 一整套假依赖：默认「全部成功」，用例只覆盖自己要改的那一项。 */
function fakes(extra: Partial<InstallDeps> = {}) {
  const rec: Recorder = {
    steps: [], spawnCalls: [], unref: 0, runOnce: 0, quit: 0, sentinelAbsentAtRunOnce: null,
  };
  // B1：载体是独立镜像名的可执行文件（只判存在性，绝不执行）。
  const watchdog = join(dir, 'sparkii-update-watchdog.exe');
  writeFileSync(watchdog, '// 测试用 watchdog 载体占位（locateWatchdogBinary 只判存在性）\n', 'utf8');
  const deps: InstallDeps = {
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    quitApp: () => { rec.quit += 1; },
    isUpdatingRef: { value: true },
    shutdownController: {
      runOnce: async () => {
        rec.runOnce += 1;
        // 硬证据：runOnce 被调用时哨兵绝不可能已经存在（§7.7「先关库、再写哨兵」）
        rec.sentinelAbsentAtRunOnce = !existsSync(sentinelPath(dir));
        return [];
      },
      hasRun: () => true,
    },
    release: makeRelease(),
    readRegistry: async () => REG_TEXT,
    txnId: 'txn-1',
    pid: 4321,
    execPath: 'D:\\software\\SparkiiPi\\Sparkii.exe',   // 必须落在注册表指向的安装目录内（不变量 4）
    watchdogPath: watchdog,
    spawn: (cmd, args, opts): SpawnedChildLike => {
      rec.spawnCalls.push({ cmd, args, opts });
      return { pid: 900001, unref: () => { rec.unref += 1; }, on: () => undefined };
    },
    trace: (step) => { rec.steps.push(step); },
    ...extra,
  };
  return { deps, rec, watchdog };
}

function readSentinelFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(sentinelPath(dir), 'utf8')) as Record<string, unknown>;
}

/** 伪造一份「关库钩子已产出的完整快照」（main/index.ts snapshotData 的形状）。 */
function plantHookSnapshot(txnId: string, createdAt: number): string {
  const hookDir = join(dir, 'updates', 'snapshots', txnId);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, txnId, createdAt, files: [], excluded: ['updates'],
  }), 'utf8');
  return hookDir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sparkii-install-txn-'));
  const pending = pendingVersionDir(dir, VERSION);
  mkdirSync(pending, { recursive: true });
  artifact = Buffer.from(`NSIS-FAKE-BYTES-${VERSION}-`.repeat(4));
  sha512 = createHash('sha512').update(artifact).digest('base64');
  writeFileSync(join(pending, NAME), artifact);
  // data 根下放一份真实文件：让快照有内容可复制（空间预检与 manifest 才有意义）。
  writeFileSync(join(dir, 'settings.json'), '{"update":{"autoCheck":false}}', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInstallTransaction 成功链路（①）', () => {
  it('顺序严格为 verifyArtifactBytes → resolveInstallDirectory → runOnce → 快照 → 写哨兵 → spawn → quitApp', async () => {
    const { deps, rec } = fakes();
    const result = await runInstallTransaction(req(), deps);

    expect(result.ok).toBe(true);
    expect(result.txnId).toBe('txn-1');
    expect(result.watchdogPid).toBe(900001);
    expect(result.installDir).toBe(EXPECTED_DIR);
    expect(typeof result.snapshotPath).toBe('string');
    expect(rec.steps).toEqual([
      'verify-artifact', 'resolve-install-dir', 'shutdown-runOnce', 'snapshot',
      'sentinel-write', 'locate-watchdog', 'deploy-watchdog', 'spawn-watchdog',
      'sentinel-phase', 'quit-app',
    ]);
    expect(rec.steps.indexOf('resolve-install-dir')).toBeLessThan(rec.steps.indexOf('shutdown-runOnce'));
    expect(rec.steps.indexOf('shutdown-runOnce')).toBeLessThan(rec.steps.indexOf('snapshot'));
    expect(rec.steps.indexOf('locate-watchdog')).toBeLessThan(rec.steps.indexOf('deploy-watchdog'));
    expect(rec.steps.indexOf('deploy-watchdog')).toBeLessThan(rec.steps.indexOf('spawn-watchdog'));
    expect(rec.sentinelAbsentAtRunOnce).toBe(true);
    expect(rec.runOnce).toBe(1);
    expect(rec.quit).toBe(1);
    expect(rec.unref).toBe(1);
    // 事务成功后 isUpdating 必须仍为 true（更新退出语义交给 before-quit 守卫）
    expect(deps.isUpdatingRef?.value).toBe(true);
  });

  it('哨兵落盘字段齐全，phase 最终为 watchdog-started，expiresAt = min(release.expiresAt, now+30min)', async () => {
    const { deps } = fakes();
    await runInstallTransaction(req(), deps);
    const sentinel = readSentinelFile();
    expect(sentinel.schemaVersion).toBe(1);
    expect(sentinel.writer).toBe('main');
    expect(sentinel.txnId).toBe('txn-1');
    expect(sentinel.phase).toBe('watchdog-started');
    expect(sentinel.fromVersion).toBe('0.1.0');
    expect(sentinel.targetVersion).toBe(VERSION);
    expect(sentinel.packageSha512).toBe(sha512);
    expect(sentinel.installDir).toBe(EXPECTED_DIR);
    expect(sentinel.artifactPath).toBe(join(pendingVersionDir(dir, VERSION), NAME));
    expect(isAbsolute(String(sentinel.snapshotPath))).toBe(true);
    expect(String(sentinel.snapshotManifestPath).endsWith('manifest.json')).toBe(true);
    expect(existsSync(join(String(sentinel.snapshotPath), 'manifest.json'))).toBe(true);
    expect(sentinel.watchdogPid).toBe(900001);
    expect(sentinel.resultPath).toBe(installResultPath(dir));
    // B1：哨兵里的 watchdogPath 是**部署到 $INSTDIR 之外**的独立载体绝对路径。
    expect(String(sentinel.watchdogPath).endsWith('sparkii-update-watchdog.exe')).toBe(true);
    expect(String(sentinel.watchdogPath)).toBe(join(dir, 'updates', 'watchdog', 'sparkii-update-watchdog.exe'));
    expect(isPathInside(String(sentinel.watchdogPath), EXPECTED_DIR)).toBe(false);
    // 30min 上限生效（清单还有 72h）
    expect(sentinel.expiresAt).toBe(NOW + 30 * 60_000);
    expect(sentinel.createdAt).toBe(NOW);
  });

  it('release 先到期时 expiresAt 取 release.expiresAt（不是 +30min）', async () => {
    const soon = new Date(NOW + 5 * 60_000).toISOString();
    const { deps } = fakes({ release: makeRelease({ expiresAt: soon }) });
    await runInstallTransaction(req(), deps);
    expect(readSentinelFile().expiresAt).toBe(Date.parse(soon));
  });

  it('哨兵落在 <dataDir>/updates/ 之下，且本模块绝不代写 install-result.json（写入方唯一）', async () => {
    const { deps } = fakes();
    await runInstallTransaction(req(), deps);
    expect(sentinelPath(dir)).toBe(join(dir, 'updates', SENTINEL_FILENAME));
    expect(installResultPath(dir)).toBe(join(dir, 'updates', INSTALL_RESULT_FILENAME));
    expect(existsSync(join(dir, 'updates', 'pending-update.json'))).toBe(true);
    expect(existsSync(installResultPath(dir))).toBe(false);
  });

  it('复用关库钩子已产出的快照，不重复整份快照（依据：manifest.createdAt 晚于事务起点）', async () => {
    // 忠实模拟 main/index.ts 的 snapshotData 钩子：它在 §7.7 序列第 ⑥ 步（closeStores 之后）
    // 用真实时钟调 snapshotDataDir(dataDir, 'shutdown-<Date.now()>', ['updates'])。
    const hookTxn = (): string => `shutdown-${Date.now()}`;
    let hookDir = '';
    const { deps, rec } = fakes({
      shutdownController: {
        runOnce: async () => {
          rec.runOnce += 1;
          rec.sentinelAbsentAtRunOnce = !existsSync(sentinelPath(dir));
          const res = await snapshotDataDir(dir, hookTxn(), ['updates']);
          expect(res.ok).toBe(true);
          hookDir = res.snapshotPath ?? '';
          return [];
        },
        hasRun: () => true,
      },
    });
    const result = await runInstallTransaction(req(), deps);

    expect(result.ok).toBe(true);
    expect(hookDir).not.toBe('');
    expect(result.snapshotPath).toBe(hookDir);
    // 关键：没有再为本事务复制第二份整目录
    expect(existsSync(join(dir, 'updates', 'snapshots', 'txn-1'))).toBe(false);
    expect(readdirSync(join(dir, 'updates', 'snapshots')).length).toBe(1);
    const sentinel = readSentinelFile();
    expect(sentinel.snapshotPath).toBe(hookDir);
    expect(sentinel.snapshotManifestPath).toBe(join(hookDir, 'manifest.json'));
  });

  it('陈旧快照（createdAt 早于事务起点）不复用，改为补做一次', async () => {
    plantHookSnapshot('shutdown-1', 1);
    const { deps } = fakes();
    const result = await runInstallTransaction(req(), deps);
    expect(result.snapshotPath).toBe(join(dir, 'updates', 'snapshots', 'txn-1'));
    expect(existsSync(join(dir, 'updates', 'snapshots', 'txn-1', 'manifest.json'))).toBe(true);
  });

  it('同 txnId 重入时幂等复用已有快照，不重复复制', async () => {
    const txnDir = plantHookSnapshot('txn-1', 1);
    writeFileSync(join(txnDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, txnId: 'txn-1', createdAt: 1,
      files: [{ path: 'settings.json', sha256: 'x', bytes: 1, mtimeMs: 1 }],
      excluded: ['updates'],
    }), 'utf8');
    const { deps } = fakes();
    const result = await runInstallTransaction(req(), deps);
    expect(result.snapshotPath).toBe(txnDir);
    const manifest = JSON.parse(readFileSync(join(txnDir, 'manifest.json'), 'utf8')) as { files: unknown[] };
    expect(manifest.files.length).toBe(1);   // 复用 ⇒ 没被整份重做覆盖
  });

  it('审计链写入 install-start 且链自证完好', async () => {
    const { deps } = fakes();
    await runInstallTransaction(req(), deps);
    const verdict = await verifyAuditChain(dir);
    expect(verdict.ok).toBe(true);
    expect(verdict.count).toBeGreaterThanOrEqual(1);
    expect(existsSync(auditChainPath(dir))).toBe(true);
  });
});

describe('spawn 参数（⑤）', () => {
  const deployed = (): string => join(dir, 'updates', 'watchdog', 'sparkii-update-watchdog.exe');

  it('args 逐字按契约 §6：--updated --force-run /S /D=<dir>，/D= 是最后一个且不加引号', async () => {
    const { deps, rec } = fakes();
    await runInstallTransaction(req(), deps);
    expect(rec.spawnCalls.length).toBe(1);
    const call = rec.spawnCalls[0]!;
    // B1：cmd 是部署到 $INSTDIR 之外的独立载体，不再是 Electron 主程序。
    expect(call.cmd).toBe(deployed());
    expect(call.cmd.endsWith('sparkii-update-watchdog.exe')).toBe(true);
    expect(isPathInside(call.cmd, EXPECTED_DIR)).toBe(false);
    expect(call.args).toEqual([
      '--parent-pid', '4321',
      '--sentinel', sentinelPath(dir),
      '--result', installResultPath(dir),
      '--timeout-ms', '60000',
      '--installer', join(pendingVersionDir(dir, VERSION), NAME),
      '--',
      '--updated',
      '--force-run',
      '/S',
      `/D=${EXPECTED_DIR}`,
    ]);
    // M1：两个 NSIS 旗标必须在 `--` 之后、`/D=` 之前。
    const dd = call.args.indexOf('--');
    expect(call.args.slice(dd + 1, dd + 3)).toEqual(['--updated', '--force-run']);
    expect(call.args.at(-1)).toBe(`/D=${EXPECTED_DIR}`);
    expect(call.args.at(-2)).toBe('/S');
    // 不加引号：任何参数都不得包含双引号（NSIS 会把 " 当路径字符）
    for (const a of call.args) expect(a.includes('"')).toBe(false);
  });

  it('安装目录含空格时 /D= 仍不加引号、仍在最后', async () => {
    const spaced = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop',
      '    InstallLocation    REG_SZ    D:\\My Programs\\Sparkii Pi',
      '',
    ].join('\r\n');
    const { deps, rec } = fakes({
      readRegistry: async () => spaced,
      // 含空格目录也必须与运行位置一致，否则会被不变量 4 的门禁拦下
      execPath: 'D:\\My Programs\\Sparkii Pi\\Sparkii.exe',
    });
    const result = await runInstallTransaction(req(), deps);
    expect(result.installDir).toBe('D:\\My Programs\\Sparkii Pi');
    const last = rec.spawnCalls[0]!.args.at(-1)!;
    expect(last).toBe('/D=D:\\My Programs\\Sparkii Pi');
    expect(last.startsWith('/D=')).toBe(true);
    expect(last.includes('"')).toBe(false);
  });

  it('detached / stdio ignore / 不继承 ELECTRON_RUN_AS_NODE（SEA 载体不需要）', async () => {
    let seen: SpawnOptionsLike | null = null;
    const { deps } = fakes({
      spawn: (_cmd, _args, opts) => {
        seen = opts;
        return { pid: 7, unref: () => undefined, on: () => undefined };
      },
    });
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      await runInstallTransaction(req(), deps);
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
    expect(seen).not.toBeNull();
    expect(seen!.detached).toBe(true);
    expect(seen!.stdio).toBe('ignore');
    expect(seen!.windowsHide).toBe(true);
    // 载体是独立 node.exe 派生体：再带 ELECTRON_RUN_AS_NODE 只会误导（B1）
    expect(seen!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('watchdog 无 pid ⇒ 视为拉起失败：回收哨兵，并因序列已不可逆而请求退出', async () => {
    const { deps, rec } = fakes({ spawn: () => ({ unref: () => undefined }) });
    const result = await runInstallTransaction(req(), deps);
    // R1 · B-1：库已关 / 池已停 ⇒ 不能把控制权交回运行态（那会留下僵尸进程）
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED', quitRequested: true });
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(deps.isUpdatingRef?.value).toBe(true);
    await flush();
    expect(rec.quit).toBe(1);
  });

  it('B1：载体部署失败（目标位置被目录占住）⇒ 回收哨兵、不 spawn、请求退出', async () => {
    // 让 copyFile 的目标路径本身是个目录 ⇒ 部署必失败（不依赖平台特有的文件占用）。
    mkdirSync(join(dir, 'updates', 'watchdog', 'sparkii-update-watchdog.exe'), { recursive: true });
    const { deps, rec } = fakes();
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED', quitRequested: true });
    expect(rec.spawnCalls).toHaveLength(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(deps.isUpdatingRef?.value).toBe(true);   // 序列已跑完 ⇒ 只能退出
    await flush();
    expect(rec.quit).toBe(1);
  });

  it('spawn 同步抛错 ⇒ 回收哨兵、请求退出（不回到运行态）、INSTALL_BLOCKED', async () => {
    const { deps, rec } = fakes({
      spawn: () => { throw new Error('ENOENT node'); },
    });
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(result.quitRequested).toBe(true);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(deps.isUpdatingRef?.value).toBe(true);
    await flush();
    expect(rec.quit).toBe(1);
  });

  it('quitApp 抛错不改变事务成功判定（watchdog 已 detached，安装继续进行）', async () => {
    const { deps, rec } = fakes({
      quitApp: () => { throw new Error('app.quit unavailable'); },
    });
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(true);
    // I-88：用例名原先写着「watchdog 已 detached」而正文只断 result.ok（R15b 域3 第五种假象），
    // 现在把名字里承诺的那件事真的钉住。
    expect(rec.spawnCalls, 'watchdog 必须真的被拉起一次').toHaveLength(1);
    expect(rec.spawnCalls[0]?.opts.detached).toBe(true);
  });
});

describe('失败分支一律不进入关机动作、不留后产物', () => {
  it('事务中止时 INSTALL_FAILED 也进 AuditStore，不再只有链上有（I-83 / R20 · Major）', async () => {
    resetAuditThrottle();   // 限流键是模块级；本用例断言的是"这次中止真的落库"，先清干净
    writeFileSync(join(pendingVersionDir(dir, VERSION), NAME), Buffer.from('TAMPERED-BYTES'));
    const audit = { append: vi.fn(async () => ({})) };
    const { deps } = fakes({ audit });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'ARTIFACT_INVALID' });
    const calls = audit.append.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.some((c) => c[0].action === 'update.failed'
      && String(c[0].payloadSummary).includes('INSTALL_TRANSACTION')), JSON.stringify(calls)).toBe(true);
    expect(readFileSync(auditChainPath(dir), 'utf8')).toContain('update.failed');
  });

  it('② sha512 不符 ⇒ ARTIFACT_INVALID，且没有调用 runOnce / 不写哨兵', async () => {
    writeFileSync(join(pendingVersionDir(dir, VERSION), NAME), Buffer.from('TAMPERED-BYTES'));
    const { deps, rec } = fakes();
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'ARTIFACT_INVALID' });
    expect(rec.runOnce).toBe(0);
    expect(rec.spawnCalls.length).toBe(0);
    expect(rec.quit).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(deps.isUpdatingRef?.value).toBe(false);
    // 包体不删（失败后仍可重跑），只是绝不进入安装
    expect(existsSync(join(pendingVersionDir(dir, VERSION), NAME))).toBe(true);
  });

  it('包体字节数与清单不符也判 ARTIFACT_INVALID（bytes 与 sha512 双检）', async () => {
    const { deps, rec } = fakes({
      release: makeRelease({
        artifact: { name: NAME, bytes: artifact.length + 1, sha512, url: `releases/${VERSION}/${NAME}` },
      }),
    });
    const result = await runInstallTransaction(req(), deps);
    expect(result.reason).toBe('ARTIFACT_INVALID');
    expect(rec.runOnce).toBe(0);
  });

  it('③ shutdownController 缺失 ⇒ INSTALL_BLOCKED（fail closed，不跳过关机序列）', async () => {
    const { deps, rec } = fakes({ shutdownController: undefined });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED' });
    expect(rec.spawnCalls.length).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(deps.isUpdatingRef?.value).toBe(false);
  });

  it('runOnce 抛错且已进入 stopPool ⇒ 现场不可逆：保持 isUpdating 并请求退出（I-33 / R1 · B-1，真控制器）', async () => {
    const calls: string[] = [];
    // 用**真的** createShutdownController：progress() 的语义只能在真实记录进入顺序时才有意义，
    // 假控制器直接返回 [] 会让「不可逆」分支永远走不到（R3 · Blocker-2 指出的正是这种覆盖空洞）。
    const controller = createShutdownController({
      abortPendingApprovals: async () => { calls.push('abort'); return 0; },
      stopPool: async () => { calls.push('stopPool'); throw new Error('pool stop failed'); },
      stopDocumentParse: async () => { calls.push('docParse'); },
      disposeReviewer: async () => { calls.push('reviewer'); },
      closeStores: async () => { calls.push('closeStores'); },
      snapshotData: async () => { calls.push('snapshot'); },
      now: () => NOW,
    });
    const { deps, rec } = fakes({ shutdownController: controller });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED', quitRequested: true });
    expect(deps.isUpdatingRef?.value).toBe(true);            // 池已停 ⇒ 不许回到普通退出语义
    expect(controller.progress()).toContain('stopPool');
    expect(calls).toEqual(['abort', 'stopPool']);            // 抛错后绝不继续往下拆
    await new Promise((resolve) => setTimeout(resolve, 0));  // blocked() 用 queueMicrotask 请求退出
    expect(rec.quit).toBe(1);
    expect(rec.spawnCalls.length).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('不可逆失败之后用户立刻再点一次「安装」⇒ §7.7 序列不会被跑第二遍（I-40 端到端）', async () => {
    let stopCount = 0;
    const controller = createShutdownController({
      abortPendingApprovals: async () => 0,
      stopPool: async () => { stopCount += 1; throw new Error('pool stop failed'); },
      stopDocumentParse: async () => undefined,
      disposeReviewer: async () => undefined,
      closeStores: async () => undefined,
      snapshotData: async () => undefined,
      now: () => NOW,
    });
    const { deps, rec } = fakes({ shutdownController: controller });
    const first = await runInstallTransaction(req(), deps);
    expect(first.quitRequested).toBe(true);
    expect(stopCount).toBe(1);
    // 第二次尝试：守卫之外还有这条门（IPC 直接再调 installUpdate），必须也撞在拒绝上。
    const second = await runInstallTransaction(req(), deps);
    expect(second.ok).toBe(false);
    expect(stopCount).toBe(1);                              // 序列一步都没有重复执行
    expect(deps.isUpdatingRef?.value).toBe(true);           // 仍然坚持「这是更新退出」
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rec.quit).toBe(2);                               // 两次都请求退出，没有回到运行态
    expect(rec.spawnCalls.length).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('runOnce 在第一步就抛错（尚未拆掉运行态）⇒ 可撤销：回到普通退出语义，不请求退出', async () => {
    const controller = createShutdownController({
      abortPendingApprovals: async () => { throw new Error('gate unavailable'); },
      stopPool: async () => undefined,
      stopDocumentParse: async () => undefined,
      disposeReviewer: async () => undefined,
      closeStores: async () => undefined,
      snapshotData: async () => undefined,
      now: () => NOW,
    });
    const { deps, rec } = fakes({ shutdownController: controller });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED' });
    expect(deps.isUpdatingRef?.value).toBe(false);
    // 待审批提案是「显式过期」而非破坏：库、池、快照现场都还在 ⇒ 判为可撤销是有意选择（见契约 I-33 备注）
    expect(controller.progress()).toEqual(['abortPendingApprovals']);
    expect(rec.quit).toBe(0);
    expect(rec.spawnCalls.length).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('安装目录解析失败（注册表不可用）⇒ INSTALL_BLOCKED，且不进入关机序列', async () => {
    const { deps, rec } = fakes({ readRegistry: async () => null });
    const result = await runInstallTransaction(req(), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.runOnce).toBe(0);
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('④ watchdog 缺件 ⇒ 删除刚写的哨兵（无孤儿哨兵），序列已跑完故请求退出而非回到运行态', async () => {
    const { deps, rec } = fakes({ watchdogPath: join(dir, 'no-such-watchdog.exe') });
    const result = await runInstallTransaction(req(), deps);
    // R1 · B-1：runOnce 已经关库 / 停池，把控制权交回运行态会留下僵尸进程 ⇒ 必须退出。
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED', quitRequested: true });
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(rec.spawnCalls.length).toBe(0);
    expect(deps.isUpdatingRef?.value).toBe(true);          // 序列已完成，不撤销
    await flush();                                          // blocked() 用 microtask 请求退出
    expect(rec.quit).toBe(1);
    expect(existsSync(join(dir, 'updates'))).toBe(true);   // 快照等已落盘产物保留
  });

  it('resourcePath 下没有 watchdog 且无开发态候选时（注入不存在路径）⇒ 无孤儿哨兵', async () => {
    const { deps } = fakes({ watchdogPath: join(dir, 'deep', 'missing', 'sparkii-update-watchdog.exe') });
    const result = await runInstallTransaction(req(), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('⑥ 快照空间不足 ⇒ 原样返回 REQUIRES_UNMET、不写哨兵，并要求退出（序列已不可逆）', async () => {
    const { deps, rec } = fakes({ snapshotDeps: { freeBytes: () => 0 } });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'REQUIRES_UNMET', quitRequested: true });
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(rec.spawnCalls.length).toBe(0);
    expect(deps.isUpdatingRef?.value).toBe(true);
    await flush();
    expect(rec.quit).toBe(1);
  });

  it('⑥ 快照复制中途失败 ⇒ SNAPSHOT_FAILED、不写哨兵、不留半份快照目录', async () => {
    const { deps } = fakes({
      snapshotDeps: { copyFileImpl: async () => { throw new Error('EIO'); } },
    });
    const result = await runInstallTransaction(req(), deps);
    // 快照失败发生在 runOnce 之后 ⇒ 现场不可逆，同样要求退出（R1 · B-1）
    expect(result).toEqual({ ok: false, reason: 'SNAPSHOT_FAILED', quitRequested: true });
    expect(existsSync(sentinelPath(dir))).toBe(false);
    expect(existsSync(join(dir, 'updates', 'snapshots', 'txn-1'))).toBe(false);
  });

  it('⑥ 存在非空 -wal（库未关）⇒ WAL_UNCHECKPOINTED，绝不带未 checkpoint 的库做快照', async () => {
    writeFileSync(join(dir, 'audit.db-wal'), 'dirty-wal-bytes');
    const { deps } = fakes();
    const result = await runInstallTransaction(req(), deps);
    // 关库钩子之后仍有非空 -wal ⇒ 快照不可信；序列已不可逆，同样只能退出（R1 · B-1）
    expect(result).toEqual({ ok: false, reason: 'WAL_UNCHECKPOINTED', quitRequested: true });
    expect(existsSync(sentinelPath(dir))).toBe(false);
  });

  it('artifactPath 不在 pending/<targetVersion>/ 之下 ⇒ INSTALL_BLOCKED（不变量 4）', async () => {
    const outside = join(dir, 'Sparkii-outside.exe');
    writeFileSync(outside, artifact);
    const { deps, rec } = fakes();
    const result = await runInstallTransaction(req({ artifactPath: outside }), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED' });
    expect(rec.runOnce).toBe(0);
  });

  it('artifactPath 指到别的版本目录 ⇒ INSTALL_BLOCKED', async () => {
    const other = join(pendingVersionDir(dir, '9.9.9'), NAME);
    mkdirSync(join(other, '..'), { recursive: true });
    writeFileSync(other, artifact);
    const { deps } = fakes();
    const result = await runInstallTransaction(req({ artifactPath: other }), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
  });

  it('artifactPath 落在 pending/<version> 的更深子目录 ⇒ INSTALL_BLOCKED', async () => {
    const nested = join(pendingVersionDir(dir, VERSION), 'sub', NAME);
    mkdirSync(join(nested, '..'), { recursive: true });
    writeFileSync(nested, artifact);
    const { deps } = fakes();
    const result = await runInstallTransaction(req({ artifactPath: nested }), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
  });

  it('targetVersion 形态非法（路径穿越）⇒ INSTALL_BLOCKED 且绝不写盘', async () => {
    const { deps } = fakes();
    const result = await runInstallTransaction(req({ targetVersion: '../../escape' }), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(existsSync(join(dir, '..', '..', 'escape'))).toBe(false);
  });

  it('release.version 与 targetVersion 不一致 ⇒ INSTALL_BLOCKED（只消费已验签清单）', async () => {
    const { deps, rec } = fakes({ release: makeRelease({ version: '0.9.9' }) });
    const result = await runInstallTransaction(req(), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.runOnce).toBe(0);
  });

  it('channel.targetVersion 与 release 不一致 ⇒ INSTALL_BLOCKED', async () => {
    const channel: ChannelJson = {
      schemaVersion: 1, product: 'Sparkii', channel: 'stable', platform: 'win-x64',
      sequence: 11, targetVersion: '0.3.0', manifestPath: 'releases/0.2.0/release.json',
      manifestSha256: 'x'.repeat(64), signaturePath: 'p', publishedAt: new Date(NOW).toISOString(),
    };
    const { deps } = fakes({ channel });
    const result = await runInstallTransaction(req(), deps);
    expect(result.reason).toBe('INSTALL_BLOCKED');
  });

  it('缺少 release ⇒ INSTALL_BLOCKED（绝不「无清单也照装」）', async () => {
    const { deps } = fakes({ release: undefined });
    const result = await runInstallTransaction(req(), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED' });
  });

  it('dataDir 非绝对路径 ⇒ INSTALL_BLOCKED，且不在 cwd 造出 updates/ 目录', async () => {
    const before = existsSync(join(process.cwd(), 'updates'));
    const { deps } = fakes();
    const result = await runInstallTransaction(req({ dataDir: 'relative-data-dir' }), deps);
    expect(result).toEqual({ ok: false, reason: 'INSTALL_BLOCKED' });
    expect(existsSync(join(process.cwd(), 'updates'))).toBe(before);
  });
});

describe('注入缝的默认行为（生产路径不得因缺注入而放行）', () => {
  it('不注入 readRegistry 时走真实只读 reg query：未知 appId ⇒ null（读不写）', async () => {
    const value = await resolveInstallDirectoryWith('com.sparkii.not-installed-for-test', { platform: 'win32' });
    expect(value).toBeNull();
  });

  it('注入 execPath / pid 后 --parent-pid 随之变化；spawn 的 cmd 仍是独立载体（不是 Electron 主程序）', async () => {
    // execPath 必须与注册表目录**精确相等**才过得了不变量 4 的锚点门（R8 · Major-3 之后子目录不再算相符）。
    // B1：execPath 只用于「运行位置锚定」；watchdog 的 cmd 是部署出去的独立镜像，
    // 这正是它不会被 NSIS 两个 kill 点按镜像名/路径杀掉的原因。
    const { deps, rec } = fakes({ execPath: 'D:\\software\\SparkiiPi\\Sparkii.exe', pid: 12 });
    await runInstallTransaction(req(), deps);
    expect(rec.spawnCalls[0]!.cmd).not.toBe('D:\\software\\SparkiiPi\\Sparkii.exe');
    expect(rec.spawnCalls[0]!.cmd.endsWith('sparkii-update-watchdog.exe')).toBe(true);
    expect(rec.spawnCalls[0]!.args).toContain('12');
  });

  it('注册表目录与运行位置不符 ⇒ 进入关机序列之前就 fail closed（R2 · B3 / 不变量 4）', async () => {
    const { deps, rec } = fakes({ execPath: 'E:\\elsewhere\\Sparkii.exe' });
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.spawnCalls).toHaveLength(0);                // 绝不 spawn
    expect(rec.runOnce).toBe(0);                           // 绝不进入半关机现场
    expect(rec.quit).toBe(0);
  });

  it('拿不到运行位置（execPath 空）⇒ 同样 fail closed，不猜目录', async () => {
    const { deps, rec } = fakes({ execPath: '' });
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.spawnCalls).toHaveLength(0);
    expect(rec.runOnce).toBe(0);
  });

  it('assertInstallDirAnchored：只认精确相等；子孙 / 旁支 / 换盘符一律拒绝（R8 · Major-3）', async () => {
    const dir = 'D:\\software\\SparkiiPi';
    expect(assertInstallDirAnchored(dir, `${dir}\\Sparkii.exe`).ok).toBe(true);
    // 大小写与尾分隔符归一后仍算相等。
    expect(assertInstallDirAnchored('D:\\a\\', 'D:\\A\\Sparkii.exe').ok).toBe(true);
    // 以下三条是本次收紧的核心：候选是运行位置的**祖先**在旧判据里会通过，
    // 而那正是同用户可写的 HKCU 值能造出来的形态（盘根 / 主目录 / 上一层都算），必须拒。
    const mismatch = assertInstallDirAnchored(dir, `${dir}\\resources\\app.asar`);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe('INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION');
    expect(assertInstallDirAnchored(dir, 'D:\\software\\SparkiiPi\\Nested\\Sparkii.exe').ok).toBe(false);
    expect(assertInstallDirAnchored(dir, 'D:\\software\\SparkiiPiOther\\Sparkii.exe').ok).toBe(false);
    expect(assertInstallDirAnchored(dir, 'C:\\software\\SparkiiPi\\Sparkii.exe').ok).toBe(false);
    expect(assertInstallDirAnchored(dir, undefined).ok).toBe(false);
  });

  it('assertInstallDirAnchored：盘根 / UNC 根 / 用户主目录即便与运行位置相等也拒绝（R8 · Major-3）', async () => {
    // 这三条走的是 run === cand 之后的第二道兜底 ⇒ 先构造「真相等」的形态，再要求被拦。
    const drive = assertInstallDirAnchored('C:\\', 'C:\\Sparkii.exe');
    expect(drive.ok).toBe(false);
    expect(drive.reason).toBe('INSTALL_DIR_TOO_BROAD');
    const unc = assertInstallDirAnchored('\\\\fs\\share', '\\\\fs\\share\\Sparkii.exe');
    expect(unc.ok).toBe(false);
    expect(unc.reason).toBe('INSTALL_DIR_TOO_BROAD');
    const home = String(process.env.USERPROFILE ?? process.env.HOME ?? '');
    if (home) {
      const broad = assertInstallDirAnchored(home, `${home}\\Sparkii.exe`);
      expect(broad.ok).toBe(false);
      expect(broad.reason).toBe('INSTALL_DIR_TOO_BROAD');
      // 主目录下面一层的正常安装目录不受影响（证明这条不是「把 LOCALAPPDATA 整片误杀」）。
      expect(assertInstallDirAnchored(`${home}\\AppData\\Local\\Programs\\Sparkii`,
        `${home}\\AppData\\Local\\Programs\\Sparkii\\Sparkii.exe`).ok).toBe(true);
    }
  });

  it('assertInstallDirAnchored：四种"看着不同其实同一路径"的写法必须仍判相等（R14 · Minor：探针此前无单测）', async () => {
    const dir = 'D:\\software\\SparkiiPi';
    const exe = `${dir}\\Sparkii.exe`;
    const base = assertInstallDirAnchored(dir, exe);
    expect(base.ok).toBe(true);
    // ① 正斜杠形态的候选目录
    expect(assertInstallDirAnchored('D:/software/SparkiiPi', exe).ok).toBe(true);
    // ② 候选带尾分隔符 + 运行位置整体大写
    expect(assertInstallDirAnchored(`${dir}\\`, 'D:\\SOFTWARE\\SPARKIIPI\\Sparkii.exe').ok).toBe(true);
    // ③ `\\?\` 命名空间前缀：**不许**被当成"同一路径"。它绕过 Win32 路径解析，
    //    与规范化后的普通路径永不相等 ⇒ fail closed（宁可拒装也不认一个无法比较的目录）。
    const namespaceForm = assertInstallDirAnchored(`\\\\?\\${dir}`, exe);
    expect(namespaceForm.ok).toBe(false);
    expect(namespaceForm.reason).toBe('INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION');
    // ④ 8.3 短名形态（`D:\SOFTWARE\SPARKI~1`）：短名与长名在字符串层不相等 ⇒ 同样 fail closed。
    //    这是**已知的保守面**：真机上若有用户以短名启动，会被拒自管安装并得到人工确认提示（M-11）。
    const shortName = assertInstallDirAnchored('D:\\software\\SPARKI~1', exe);
    expect(shortName.ok).toBe(false);
    expect(shortName.reason).toBe('INSTALL_DIR_MISMATCH_WITH_RUNNING_LOCATION');
  });

  it('HKCU 指向盘根时事务在任何关机动作之前就 blocked（R8 · Major-3 的接线面）', async () => {
    // 攻击形态：同用户可写的 HKCU 值填 `C:\`。旧判据认为「候选是运行位置的祖先 ⇒ 相符」而放行，
    // 于是升级会被写到盘根；现在锚点判据必须把它挡在 runOnce / spawn 之前。
    const rootText = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.sparkii.desktop',
      '    DisplayName    REG_SZ    Sparkii',
      '    InstallLocation    REG_SZ    C:\\',
      '',
    ].join('\r\n');
    const { deps, rec } = fakes({ readRegistry: async () => rootText, execPath: 'C:\\Sparkii.exe' });
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.runOnce).toBe(0);
    expect(rec.spawnCalls).toHaveLength(0);
    expect(rec.steps.filter((s) => /snapshot|sentinel|watchdog|quit-app/.test(s))).toHaveLength(0);
    // 未拆机 ⇒ 撤销「正在更新」，普通退出语义恢复，不留僵尸门。
    expect(deps.isUpdatingRef?.value).toBe(false);
  });

  it('DEFAULT_SNAPSHOT_KEEP 是正数（成功自检后的保留份数）', () => {
    expect(DEFAULT_SNAPSHOT_KEEP).toBeGreaterThan(0);
  });
});

describe('临时文件卫生', () => {
  it('哨兵原子写入不留 .tmp-* 残骸', async () => {
    const { deps } = fakes();
    await runInstallTransaction(req(), deps);
    const leftovers = readdirSync(join(dir, 'updates')).filter((n) => n.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('哨兵路径被普通文件占用（原子写必失败）⇒ INSTALL_BLOCKED 而非假成功', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(sentinelPath(dir), 'SENTINEL-PATH-IS-A-PLAIN-FILE');
    // rename(tmp, 已存在的普通文件) 在 Windows 上会成功覆盖，因此这里改成让目标成为目录：
    // 目录场景 rename 必失败（EISDIR/ENOTEMPTY），验证「写不进即中止」。
    rmSync(sentinelPath(dir), { force: true });
    mkdirSync(sentinelPath(dir), { recursive: true });
    const { deps, rec } = fakes();
    const result = await runInstallTransaction(req(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INSTALL_BLOCKED');
    expect(rec.spawnCalls.length).toBe(0);
  });
});

describe('watchdog 载体定位（候选顺序 ①resourcePath/scripts ②resourcePath ③开发态相对本模块）', () => {
  const EXE = 'sparkii-update-watchdog.exe';

  it('① 优先命中 <resourcePath>/scripts/sparkii-update-watchdog.exe', () => {
    const res = join(dir, 'resources');
    mkdirSync(join(res, 'scripts'), { recursive: true });
    const first = join(res, 'scripts', EXE);
    writeFileSync(first, 'PE-PLACEHOLDER', 'utf8');
    writeFileSync(join(res, EXE), 'PE-PLACEHOLDER', 'utf8');
    expect(locateWatchdogBinary(res)).toBe(first);
  });

  it('① 缺件时退到 <resourcePath>/sparkii-update-watchdog.exe；事务部署到 $INSTDIR 之外', async () => {
    const res = join(dir, 'resources2');
    mkdirSync(res, { recursive: true });
    const second = join(res, EXE);
    writeFileSync(second, 'PE-PLACEHOLDER', 'utf8');
    expect(locateWatchdogBinary(res)).toBe(second);
    // 事务侧：resourcePath 命中即可，不需要 deps.watchdogPath 注入
    const { deps, rec } = fakes({ watchdogPath: undefined });
    const result = await runInstallTransaction(req({ resourcePath: res }), deps);
    expect(result.ok).toBe(true);
    const deployed = join(dir, 'updates', 'watchdog', EXE);
    expect(rec.spawnCalls[0]!.cmd).toBe(deployed);
    expect(readSentinelFile().watchdogPath).toBe(deployed);
    expect(existsSync(deployed)).toBe(true);
  });

  it('候选顺序逐字为 ①②，其后才是开发态相对路径；名称恒为独立镜像名', () => {
    const res = join(dir, 'resources3');
    const candidates = watchdogBinaryCandidatePaths(res);
    expect(candidates.slice(0, 2)).toEqual([
      join(res, 'scripts', EXE),
      join(res, EXE),
    ]);
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.every((c) => c.endsWith(EXE))).toBe(true);
    // B1 的硬判据：镜像名 ≠ Sparkii.exe（tasklist 分支按 IMAGENAME 匹配）
    expect(candidates.every((c) => !/[\\/]Sparkii\.exe$/i.test(c))).toBe(true);
  });

  it('开发态候选指向仓库内 build/watchdog 产物（只判存在，绝不执行）', () => {
    const candidates = watchdogBinaryCandidatePaths(join(dir, 'no-such-resources'));
    const devCandidate = candidates.find((c) => c.replace(/\\/g, '/').includes('/build/watchdog/'));
    expect(devCandidate).toBeTruthy();
    expect(isAbsolute(devCandidate!)).toBe(true);
    expect(devCandidate!.endsWith(`${EXE}`)).toBe(true);
    // 产物可能未构建（CI 干净检出）；存在时 locator 必须认得它。
    if (existsSync(devCandidate!)) {
      expect(locateWatchdogBinary(join(dir, 'no-such-resources'))).toBe(devCandidate);
    }
  });

  it('部署路径必须避开安装目录：dataDir 落在 $INSTDIR 内 ⇒ fail closed（两条候选都在树内）', () => {
    // 常规：dataDir 在 %LOCALAPPDATA%，天然在安装目录之外。
    expect(deployedWatchdogPath(dir, EXPECTED_DIR)).toBe(join(dir, 'updates', 'watchdog', EXE));
    // 现场异常：dataDir 被指到 $INSTDIR 之下 ⇒ 首选与 <appDataRoot>/runtime 兜底都仍在树内
    // ⇒ 返回 null（调用方 INSTALL_BLOCKED），绝不带着必被 NSIS 杀掉的载体进入安装。
    expect(deployedWatchdogPath(join(EXPECTED_DIR, 'data'), EXPECTED_DIR)).toBeNull();
    expect(deployedWatchdogPath(join(EXPECTED_DIR, 'a', 'data'), join(EXPECTED_DIR, 'a'))).toBeNull();
    // 安装目录为空（解析失败）时也走 dataDir 首选。
    expect(deployedWatchdogPath(dir, null)).toBe(join(dir, 'updates', 'watchdog', EXE));
  });

  it('isPathInside / deployedWatchdogPath：大小写、尾分隔符、.. 与同前缀旁支（审核要求的三维）', () => {
    // ① win32 大小写不敏感
    expect(isPathInside('D:\\SOFTWARE\\SPARKIIPI\\x', 'D:\\software\\SparkiiPi')).toBe(true);
    // ② 尾分隔符归一
    expect(isPathInside('D:\\software\\SparkiiPi\\x\\', 'D:\\software\\SparkiiPi\\')).toBe(true);
    // ③ `..` 由 resolve 折叠后再判：折叠后仍在安装目录内 ⇒ 部署位置仍被拒
    expect(deployedWatchdogPath('D:\\software\\SparkiiPi\\a\\..\\data', EXPECTED_DIR)).toBeNull();
    expect(deployedWatchdogPath('D:\\SOFTWARE\\SPARKIIPI\\data', 'D:\\software\\SparkiiPi')).toBeNull();
    // ④ 同前缀旁支不是"在里面"（避免 SPARKIIPIOTHER 被误判）
    expect(isPathInside('D:\\software\\SparkiiPiOther\\x', EXPECTED_DIR)).toBe(false);
    expect(isPathInside('D:\\software\\SparkiiPi-ev\\x', EXPECTED_DIR)).toBe(false);
  });

  it('resourcePath 为空串时仍走候选列表，绝不返回相对路径', () => {
    const candidates = watchdogBinaryCandidatePaths('');
    expect(candidates.every((c) => isAbsolute(c))).toBe(true);
  });

  it('asar 内的候选不可执行 ⇒ 跳过（existsSync 会为 true，但 detached 子进程读不到）', () => {
    const asarResult = join(dir, 'app.asar', 'resources');
    mkdirSync(join(asarResult, 'scripts'), { recursive: true });
    writeFileSync(join(asarResult, 'scripts', EXE), 'PE-PLACEHOLDER', 'utf8');
    const found = locateWatchdogBinary(asarResult);
    // 允许 null（开发态产物可能未构建）；绝不允许返回 asar 内路径。
    if (found) expect(found.replace(/\\/g, '/')).not.toContain('app.asar/resources');
    // 显式 override 指向 asar 内也照样拒绝 ⇒ 事务 fail closed，不留孤儿哨兵
    expect(locateWatchdogBinary(asarResult, join(asarResult, 'scripts', EXE))).toBeNull();
  });

  it('app.asar.unpacked 下的候选是真目录 ⇒ 接受', () => {
    const unpacked = join(dir, 'app.asar.unpacked', 'resources');
    mkdirSync(unpacked, { recursive: true });
    const target = join(unpacked, EXE);
    writeFileSync(target, 'PE-PLACEHOLDER', 'utf8');
    expect(locateWatchdogBinary(unpacked)).toBe(target);
  });
});
