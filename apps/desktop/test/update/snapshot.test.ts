// G7c · B③「整 data\ 快照完整性」的直接测试证据（契约 §9 验收映射 → test/update/snapshot.test.ts）。
//
// 判据来源（逐条对到用例，见每条 it 的注释）：
//   设计稿 §7.8「快照范围：整个 data\，含 audit.db / -wal / -shm、sessions.db、errors.db、
//   settings.json、keyring/（DPAPI 密钥）、logs/、tasks/、pi-agent/」＋「必须先关库再备份」；
//   设计稿 §7.7 步骤 5「对 entire data\ 做快照，逐文件记录 SHA256」；
//   接口契约 §1.9 目录布局 `updates/snapshots/<txnId>/…`、§6 snapshotDataDir 签名、§9 B③。
// 被测代码（**只读，本次未改动任何产品代码**）：
//   apps/desktop/electron/main/update/snapshot.ts
//
// WAL/-shm 依据的是 snapshot.ts 里**实现实际选定的那一种**处理（不是测试方便的那种）：
//   snapshot.ts:16-18（文件头方案说明）与 snapshot.ts:136-141（walkDataDir 的判定代码）——
//   零字节 -wal 与任意 -shm **跳过复制**（空 WAL 不含未合并帧、-shm 是易失共享内存镜像），
//   非空 -wal ⇒ walDirty=true，snapshot.ts:202-207 fail closed 返回 WAL_UNCHECKPOINTED，
//   要求调用方先关库重跑（§7.8「必须先关库再备份」）。
//   本文件对这三种形态分别断言，绝不为了测试好看把实现改成「一并复制」或「自行 checkpoint」。
//
// 现场：全部 mkdtempSync(join(tmpdir(),'sparkii-snapshot-*'))，afterEach 删除。
// 绝不碰真实 %LOCALAPPDATA%\SparkiiDesktop\data、绝不执行安装器、绝不写注册表。

import { createHash } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SNAPSHOTS_DIRNAME, SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_TMP_PREFIX,
  hashFileSha256, isSafeTxnId, readSnapshotManifest, snapshotDataDir,
  snapshotDataDirWithDeps, snapshotDir, snapshotsRoot,
} from '../../electron/main/update/snapshot.js';
import type { SnapshotDeps, SnapshotManifest } from '../../electron/main/update/snapshot.js';

const TXN = 'txn-1';

/**
 * §7.8 点名的全部形态（key 为相对 dataDir 的 '/' 分隔路径，value 为内容）。
 * 其中 `updates/…` 与 `exclude-me/…` 是**必须被排除**的，0 字节的 -wal 与非空 -shm
 * 是**必须被跳过复制**的；其余 10 项即「应入册集合」。
 */
const PLANTED: Record<string, string> = {
  'audit.db': 'SQLITE-AUDIT-BYTES',
  'audit.db-wal': '',                                    // 零字节 WAL：跳过复制（snapshot.ts:138-140）
  'audit.db-shm': 'SHM-VOLATILE-MIRROR',                 // -shm：易失镜像，跳过复制（snapshot.ts:137）
  'sessions.db': 'SQLITE-SESSIONS',
  'errors.db': 'SQLITE-ERRORS',
  'settings.json': '{"update":{"autoCheck":false}}',
  'keyring/master.enc': 'DPAPI-CIPHER-BLOB',             // keyring/ 里的 .enc（DPAPI 密钥）
  'keyring/index.json': '{"version":1}',
  'logs/app.log': 'line-1\nline-2\n',
  'logs/nested/rotate-1.log': 'rotated',
  'tasks/task-1.json': '{"state":"running"}',
  'pi-agent/bin/pi.exe': 'PI-BINARY-BYTES',
  'exclude-me/secret.bin': 'must-not-enter-snapshot',    // 显式 excludeRel
  'updates/update-state.json': '{"seq":11}',             // 以下整棵 updates/ 子树必须被硬护栏排除
  'updates/pending/0.2.0/Sparkii-0.2.0-win-x64.exe': 'NSIS-FAKE',
  'updates/snapshots/txn-old/manifest.json': '{"schemaVersion":1}',
  'updates/snapshots/txn-old/settings.json': 'ancient',
};

/** 应入册的 10 项（§7.8 点名形态去掉易失 WAL/-shm、去掉两个排除根后的精确清单）。 */
const EXPECTED_IN = [
  'audit.db',
  'errors.db',
  'keyring/index.json',
  'keyring/master.enc',
  'logs/app.log',
  'logs/nested/rotate-1.log',
  'pi-agent/bin/pi.exe',
  'sessions.db',
  'settings.json',
  'tasks/task-1.json',
].sort();

/** 与被测模块无关的独立遍历：用于「条目数 = 真实文件数」的交叉核对，不是拿实现自证。 */
function walkAllFiles(base: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(base, entry.name);
    if (entry.isDirectory()) out.push(...walkAllFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 在 dataDir 之下按 '/' 分隔相对路径落一个文件（自动建父目录）。 */
function plant(rel: string, content: string | Buffer): string {
  const target = join(dir, ...rel.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function plantFixtures(): void {
  for (const [rel, content] of Object.entries(PLANTED)) plant(rel, content);
}

function bytesOf(paths: string[]): number {
  return paths.reduce((sum, rel) => sum + statSync(join(dir, ...rel.split('/'))).size, 0);
}

/**
 * 预置在 `updates/snapshots/txn-old/` 里的一份**历史快照**，只用来验证「快照套快照」被拦住；
 * 它不是本次调用的产物，所以断言产物集合时必须把它当基线排除掉。
 */
const BASELINE_SNAPSHOT = 'txn-old';

/** 快照根目录下的**全部**条目（含 .tmp-* 载体与历史 txn-old）。 */
function snapshotRootEntries(): string[] {
  return existsSync(snapshotsRoot(dir)) ? readdirSync(snapshotsRoot(dir)) : [];
}

/** 本次/历次调用真正产生的条目（排除预置基线），用于「不可见 / 无残骸」断言。 */
function producedEntries(): string[] {
  return snapshotRootEntries().filter((n) => n !== BASELINE_SNAPSHOT);
}

/** 未被清理的 .tmp-* 载体（半份快照的暴露形态）。 */
function tmpCarriers(): string[] {
  return snapshotRootEntries().filter((n) => n.startsWith(SNAPSHOT_TMP_PREFIX));
}

/** 快照目录里的递归文件清单（'/' 分隔相对路径）。 */
function filesUnder(base: string, prefix = ''): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(base, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function snapshot(
  txnId = TXN,
  excludeRel: string[] = ['exclude-me'],
  deps: SnapshotDeps = {},
) {
  return snapshotDataDirWithDeps(dir, txnId, excludeRel, deps);
}

/** 取回已发布快照的 manifest（不存在即直接失败，绝不用 optional 兜底把断言变恒真）。 */
async function manifestOf(txnId = TXN): Promise<SnapshotManifest> {
  const manifest = await readSnapshotManifest(dir, txnId);
  if (!manifest) throw new Error(`manifest 缺失：${snapshotDir(dir, txnId)}`);
  return manifest;
}

function entryPaths(manifest: SnapshotManifest): string[] {
  return manifest.files.map((f) => f.path).sort();
}

let dir: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-snapshot-'));
  dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  plantFixtures();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('B③ 快照范围：§7.8 点名的每一项都逐文件入册', () => {
  it('逐文件 SHA256 + bytes + 相对路径清单精确覆盖 audit.db/sessions.db/errors.db/settings.json/keyring/*.enc/logs/tasks/pi-agent/bin', async () => {
    const res = await snapshot();
    expect(res.ok).toBe(true);
    const manifest = await manifestOf();

    expect(entryPaths(manifest)).toEqual(EXPECTED_IN);
    for (const entry of manifest.files) {
      const source = PLANTED[entry.path];
      expect(source).toBeTypeOf('string');
      expect(entry.sha256).toBe(sha256(source));                    // 设计 §7.7 步骤 5「逐文件记录 SHA256」
      expect(entry.bytes).toBe(Buffer.byteLength(source, 'utf8'));  // 字节数同列，恢复时可判形态
      expect(entry.mtimeMs).toBe(statSync(join(dir, ...entry.path.split('/'))).mtimeMs);
    }
  });

  it('清单不是纸面账：快照目录里确实有同内容副本，路径与 manifest 逐字对应', async () => {
    await snapshot();
    const manifest = await manifestOf();
    const base = snapshotDir(dir, TXN);
    const copied = filesUnder(base);
    expect(copied).toEqual([...EXPECTED_IN, SNAPSHOT_MANIFEST_FILENAME].sort());
    for (const entry of manifest.files) {
      const copy = join(base, ...entry.path.split('/'));
      expect(existsSync(copy)).toBe(true);
      expect(readFileSync(copy, 'utf8')).toBe(PLANTED[entry.path]);
      // manifest 描述的是**副本**而不是仅描述源文件：损坏副本必须能被 hashFileSha256 抓出来
      expect(await hashFileSha256(copy)).toBe(entry.sha256);
    }
  });

  it('条目数与磁盘真实文件数逐字一致（不是「大概齐」）', async () => {
    await snapshot();
    const manifest = await manifestOf();
    const realFiles = walkAllFiles(dir)
      .filter((rel) => rel.split('/')[0] !== 'updates')                    // 硬护栏排除根
      .filter((rel) => rel.split('/')[0] !== 'exclude-me')                 // 显式 excludeRel
      .filter((rel) => !/-wal$|-shm$/i.test(rel.split('/').pop() ?? ''))    // 易失 WAL/-shm 跳过复制
      .sort();
    expect(manifest.files.length).toBe(realFiles.length);
    expect(manifest.files.length).toBe(EXPECTED_IN.length);
    expect(entryPaths(manifest)).toEqual(realFiles);
  });

  it('嵌套在别的目录里的 updates 段不被误排除（排除只作用于顶层，实现的实际选择）', async () => {
    plant('work/updates/notes.md', 'nested-updates');
    await snapshot();
    const manifest = await manifestOf();
    expect(entryPaths(manifest)).toContain('work/updates/notes.md');
    // 但真正的 <dataDir>/updates 仍然一律不进（否则就是快照套快照）
    expect(entryPaths(manifest).some((p) => p.split('/')[0] === 'updates')).toBe(false);
  });

  it('manifest.json 的 path 是相对 dataDir 的 "/" 分隔形式（跨平台可移植的恢复介质）', async () => {
    await snapshot();
    const manifest = await manifestOf();
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const entry of manifest.files) {
      expect(entry.path).not.toContain('\\');
      expect(entry.path.startsWith('/')).toBe(false);
      expect(/^[A-Za-z]:/.test(entry.path)).toBe(false);
      expect(entry.path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')).toBe(true);
      expect(entry.path.split('/')[0]).not.toBe('updates');
      // 逐段拼回 dataDir 之下确实存在（相对路径可移植，不绑死当前平台的分隔符）
      expect(existsSync(join(dir, ...entry.path.split('/')))).toBe(true);
    }
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.txnId).toBe(TXN);
  });

  it('契约 §1.9 目录布局：快照只落在 <dataDir>/updates/snapshots/<txnId>/ 之下', async () => {
    const res = await snapshot();
    expect(snapshotsRoot(dir)).toBe(join(dir, 'updates', SNAPSHOTS_DIRNAME));
    expect(res.snapshotPath).toBe(snapshotDir(dir, TXN));
    expect(existsSync(join(snapshotDir(dir, TXN), SNAPSHOT_MANIFEST_FILENAME))).toBe(true);
  });
});

describe('B③ 排除项：快照永不套快照', () => {
  it('updates（含 updates/snapshots）绝不进快照，且该排除是无条件叠加的硬护栏', async () => {
    await snapshot();
    const manifest1 = await manifestOf();
    expect(manifest1.files.some((f) => f.path.startsWith('updates'))).toBe(false);
    expect(manifest1.excluded).toContain('updates');
    expect(existsSync(join(snapshotDir(dir, TXN), 'updates'))).toBe(false);
    // 预置的历史快照 updates/snapshots/txn-old/** 也不得被吸进新快照
    expect(entryPaths(manifest1).some((p) => p.includes(BASELINE_SNAPSHOT))).toBe(false);

    // 第二次为另一个事务做快照：上一次的快照产物（就在 updates/snapshots 下）依然不进清单
    const res2 = await snapshot('txn-2', []);
    expect(res2.ok).toBe(true);
    const manifest2 = await manifestOf('txn-2');
    expect(manifest2.files.some((f) => f.path.startsWith('updates'))).toBe(false);
    expect(manifest2.excluded).toEqual(['updates']);   // 不传 excludeRel 也只叠加这一个硬护栏
    // excludeRel 是「在硬护栏之上再叠加」：不传时 exclude-me 就正常入册，证明两者互不遮蔽
    expect(entryPaths(manifest2)).toEqual([...EXPECTED_IN, 'exclude-me/secret.bin'].sort());
    expect(entryPaths(manifest1)).toEqual(EXPECTED_IN);
    // 两份快照彼此独立，且目录内部都不含任何 updates/ 或 snapshots/ 段（快照套快照被彻底挡住）
    for (const txn of [TXN, 'txn-2']) {
      const inside = filesUnder(snapshotDir(dir, txn));
      expect(inside.some((p) => p.split('/').includes('updates'))).toBe(false);
      expect(inside.some((p) => p.split('/').includes(SNAPSHOTS_DIRNAME))).toBe(false);
    }
  });

  it('显式 excludeRel 被尊重，且大小写与结尾分隔符被归一（normalizeSeg）', async () => {
    const res = await snapshot(TXN, ['Exclude-ME/']);
    expect(res.ok).toBe(true);
    const manifest = await manifestOf();
    expect(entryPaths(manifest).some((p) => p.startsWith('exclude-me'))).toBe(false);
    expect(manifest.excluded).toContain('exclude-me');
    expect(manifest.excluded).toContain('updates');
    // 源文件仍在（只读，不删）——直接查磁盘，不再用夹具自证（R6 · 恒真断言）
    expect(existsSync(join(dir, 'exclude-me', 'secret.bin'))).toBe(true);
  });

  it('快照全程只读 data\\：不改动、不删除任何现有文件，也不在 updates/snapshots 之外写盘', async () => {
    const before = new Map<string, string>();
    for (const rel of walkAllFiles(dir)) before.set(rel, sha256(readFileSync(join(dir, ...rel.split('/')), 'utf8')));
    const dataRootEntriesBefore = readdirSync(dir).sort();

    await snapshot();

    for (const [rel, digest] of before) {
      expect(existsSync(join(dir, ...rel.split('/')))).toBe(true);
      expect(sha256(readFileSync(join(dir, ...rel.split('/')), 'utf8'))).toBe(digest);
    }
    // dataDir 顶层目录集合未变（快照产物只能出现在已存在的 updates/snapshots 之下）
    expect(readdirSync(dir).sort()).toEqual(dataRootEntriesBefore);
    // 除 updates/snapshots/<txnId>/ 之外没有任何新增落盘
    const added = walkAllFiles(dir).filter((rel) => !before.has(rel));
    expect(added.every((rel) => rel.startsWith(`updates/${SNAPSHOTS_DIRNAME}/${TXN}/`))).toBe(true);
    expect(added).toContain(`updates/${SNAPSHOTS_DIRNAME}/${TXN}/${SNAPSHOT_MANIFEST_FILENAME}`);
  });
});

describe('WAL / -shm：断言与 snapshot.ts 实际选择一致（依据 snapshot.ts:16-18、136-141、202-207）', () => {
  it('零字节 -wal 与任意 -shm 被跳过复制，主库本体照常入册（snapshot.ts:137-140）', async () => {
    expect(statSync(join(dir, 'audit.db-wal')).size).toBe(0);
    expect(statSync(join(dir, 'audit.db-shm')).size).toBeGreaterThan(0);

    const res = await snapshot();
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    const manifest = await manifestOf();
    expect(entryPaths(manifest).some((p) => /-wal$|-shm$/i.test(p))).toBe(false);
    expect(entryPaths(manifest)).toContain('audit.db');            // 关库后的主库才是恢复依据
    expect(res.files).toBe(EXPECTED_IN.length);
  });

  it('非空 -wal ⇒ fail closed 返回 WAL_UNCHECKPOINTED，绝不产出半份快照、绝不改动 data\\', async () => {
    writeFileSync(join(dir, 'audit.db-wal'), 'UNMERGED-WAL-FRAMES', 'utf8');   // 库未关 / checkpoint 未完成
    const res = await snapshot();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('WAL_UNCHECKPOINTED');
    expect(res.snapshotPath).toBeNull();
    expect(res.files).toBe(0);
    expect(res.message).toContain('非空');
    // snapshot.ts:202-207 的早退发生在任何写入之前：连 snapshots/ 载体都不该出现
    expect(existsSync(snapshotDir(dir, TXN))).toBe(false);
    expect(producedEntries()).toEqual([]);
    expect(readFileSync(join(dir, 'audit.db-wal'), 'utf8')).toBe('UNMERGED-WAL-FRAMES');
  });

  it('深层目录里的非空 -wal 同样触发 WAL_UNCHECKPOINTED（判定不限于 data 根）', async () => {
    plant('sessions/sub/chat.db-wal', 'DIRTY');
    const res = await snapshot();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('WAL_UNCHECKPOINTED');
  });
});

describe('原子性：中途失败既不留半个 manifest.json，也不把 .tmp-* 载体暴露成成品', () => {
  it('copyFileImpl 在第 3 个文件抛错 ⇒ SNAPSHOT_FAILED，正式快照目录不可见、无残骸', async () => {
    const attempted: string[] = [];
    const res = await snapshot(TXN, ['exclude-me'], {
      copyFileImpl: async (src, dst) => {
        attempted.push(src);
        if (attempted.length === 3) throw new Error('ENOSPC: simulated power loss mid-copy');
        // m8 起，快照对 dst 做哈希 / stat ⇒ 注入的复制实现必须真的写出 dst（与生产实现同形）。
        await copyFile(src, dst);
      },
    });
    expect(attempted.length).toBe(3);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SNAPSHOT_FAILED');
    expect(res.snapshotPath).toBeNull();
    expect(res.files).toBe(0);

    // ① 正式快照目录从未出现（rename 只携带完整目录）
    expect(existsSync(snapshotDir(dir, TXN))).toBe(false);
    // ② 半份载体被清理：snapshots/ 下既没有 txnId 也没有 .tmp-*
    expect(producedEntries()).toEqual([]);
    // ③ 没有任何 .tmp-* 载体残留 ⇒ 磁盘上不存在「manifest 写了、数据没复制完」的半成品
    expect(tmpCarriers()).toEqual([]);
    expect(existsSync(join(snapshotsRoot(dir), SNAPSHOT_TMP_PREFIX + 'anything'))).toBe(false);
  });

  it('第一个文件就抛错同样不留任何成品，且不写 manifest', async () => {
    const res = await snapshot(TXN, ['exclude-me'], {
      copyFileImpl: async () => { throw new Error('EPERM'); },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SNAPSHOT_FAILED');
    expect(existsSync(snapshotDir(dir, TXN))).toBe(false);
    expect(producedEntries()).toEqual([]);
  });

  it('成功路径不留 .tmp-* 载体：snapshots/ 下只有 txnId 一份成品', async () => {
    await snapshot();
    expect(producedEntries()).toEqual([TXN]);
    expect(filesUnder(snapshotDir(dir, TXN))).toContain(SNAPSHOT_MANIFEST_FILENAME);
  });

  // m8（审核报告 §4 Minor）：原先 copy(src,dst) 之后对 **源** 做哈希 —— 拷贝与哈希之间
  // 源被写者改动，清单就会记下「不是快照里那份字节」的哈希（恢复时 fail-safe 拒绝，
  // 但快照内部不一致）。现在哈希/字节/时间一律取 dst；把实现改回 hash(src) 这条用例即红。
  it('m8：拷贝完成后源文件被改 ⇒ 清单哈希与字节取快照内的 dst，而非源路径', async () => {
    const original = PLANTED['settings.json']!;
    const res = await snapshot(TXN, ['exclude-me'], {
      copyFileImpl: async (src, dst) => {
        await copyFile(src, dst);
        if (src.replace(/\\/g, '/').endsWith('/settings.json')) {
          writeFileSync(src, 'MUTATED-AFTER-COPY', 'utf8');
        }
      },
    });
    expect(res.ok).toBe(true);
    const manifest = await readSnapshotManifest(dir, TXN);
    const entry = manifest!.files.find((f) => f.path === 'settings.json')!;
    const expectedSha = createHash('sha256').update(original).digest('hex');
    const mutatedSha = createHash('sha256').update('MUTATED-AFTER-COPY').digest('hex');
    expect(entry.sha256).toBe(expectedSha);
    expect(entry.sha256).not.toBe(mutatedSha);
    expect(entry.bytes).toBe(Buffer.byteLength(original));
    // 快照里实际持有的也是原字节（与清单一致）——这是「记录的就是快照本身」的直接证据。
    expect(readFileSync(join(snapshotDir(dir, TXN), 'settings.json'), 'utf8')).toBe(original);
  });

  it('并发抢先发布：另一份完整快照先落地 ⇒ 幂等复用它的 manifest，清掉自己的载体（snapshot.ts:232-241）', async () => {
    let raced = false;
    const res = await snapshot(TXN, ['exclude-me'], {
      copyFileImpl: async (src, dst) => {
        if (!raced) {
          raced = true;
          // 在第一次复制的缝隙里，模拟另一个进程完成了同 txnId 的原子发布
          const raceDir = snapshotDir(dir, TXN);
          mkdirSync(raceDir, { recursive: true });
          writeFileSync(join(raceDir, 'race-only.txt'), 'winner', 'utf8');
          writeFileSync(join(raceDir, SNAPSHOT_MANIFEST_FILENAME), JSON.stringify({
            schemaVersion: 1, txnId: TXN, createdAt: 123,
            files: [{ path: 'race-only.txt', sha256: sha256('winner'), bytes: 5, mtimeMs: 1 }],
            excluded: ['updates'],
          }), 'utf8');
        }
        await copyFile(src, dst);
      },
    });
    expect(res.ok).toBe(true);
    expect(res.snapshotPath).toBe(snapshotDir(dir, TXN));
    expect(res.message).toContain('并发复用');
    const manifest = await manifestOf();
    expect(entryPaths(manifest)).toEqual(['race-only.txt']);   // 抢先进的那份被原样复用，未被叠加/覆盖
    expect(producedEntries()).toEqual([TXN]);               // 自己的 .tmp-* 已清理
  });
});

describe('幂等：同一 txnId 重复调用不叠加半份', () => {
  it('第二次调用直接复用已存在的完整快照，磁盘产物一字不变', async () => {
    const first = await snapshot(TXN, ['exclude-me'], { now: () => 1_700_000_000_000 });
    expect(first.ok).toBe(true);
    const base = snapshotDir(dir, TXN);
    const filesBefore = filesUnder(base);
    const manifestBefore = JSON.stringify(await manifestOf());

    const second = await snapshot(TXN, ['exclude-me'], { now: () => 1_900_000_000_000 });
    expect(second.ok).toBe(true);
    expect(second.files).toBe(EXPECTED_IN.length);
    expect(second.message).toContain('幂等复用');
    expect(filesUnder(base)).toEqual(filesBefore);
    // 复用而非重做：连 createdAt 都保持第一次的值（没有半份叠加、没有重新复制）
    expect(JSON.stringify(await manifestOf())).toBe(manifestBefore);
    expect(producedEntries()).toEqual([TXN]);
  });

  it('陈旧残留（有目录但 manifest 不可读）被清掉重建，不与新快照混合（snapshot.ts:194-196）', async () => {
    const stale = snapshotDir(dir, TXN);
    mkdirSync(join(stale, 'leftover'), { recursive: true });
    writeFileSync(join(stale, 'leftover', 'half.bin'), 'half', 'utf8');

    const res = await snapshot();
    expect(res.ok).toBe(true);
    expect(filesUnder(stale)).toEqual([...EXPECTED_IN, SNAPSHOT_MANIFEST_FILENAME].sort());
    expect(filesUnder(stale).some((p) => p.startsWith('leftover/'))).toBe(false);
  });

  it('manifest 不可解析（JSON 损坏）时同样按陈旧残留重建，而不是当成完整快照复用', async () => {
    const base = snapshotDir(dir, TXN);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, SNAPSHOT_MANIFEST_FILENAME), '{ this is not json', 'utf8');
    const res = await snapshot();
    expect(res.ok).toBe(true);
    const manifest = await manifestOf();
    expect(entryPaths(manifest)).toEqual(EXPECTED_IN);
  });
});

describe('空间预检：SNAPSHOT_SPACE_FACTOR 的可判定阈值（snapshot.ts:37、208-213）', () => {
  /** 应入册文件的总字节数：实现按 ceil(total × 1.1) 预检，测试用同一表达式钉死阈值。 */
  function totalInSnapshotBytes(): number {
    return bytesOf(EXPECTED_IN);
  }

  it('空闲恰好等于 ceil(total × 1.1) ⇒ 通过（阈值不是「严格大于」）', async () => {
    const need = Math.ceil(totalInSnapshotBytes() * 1.1);
    const res = await snapshot(TXN, ['exclude-me'], { freeBytes: () => need });
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('空闲比 ceil(total × 1.1) 少 1 字节 ⇒ ok:false + reason REQUIRES_UNMET，且完全不写盘', async () => {
    const need = Math.ceil(totalInSnapshotBytes() * 1.1);
    const res = await snapshot(TXN, ['exclude-me'], { freeBytes: () => need - 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('REQUIRES_UNMET');        // 契约 §1.11 的稳定错误码，调用方据此中止关机序列
    expect(res.snapshotPath).toBeNull();
    expect(res.files).toBe(0);
    expect(res.message).toContain(String(need));
    expect(producedEntries()).toEqual([]);
    expect(existsSync(snapshotDir(dir, TXN))).toBe(false);
  });

  it('预检比例确实带余量，不是 1.0×（空闲 = 1.05× 总量仍判不足）', async () => {
    const total = totalInSnapshotBytes();
    const at105 = await snapshot(TXN, ['exclude-me'], { freeBytes: () => Math.ceil(total * 1.05) });
    expect(at105.ok).toBe(false);
    expect(at105.reason).toBe('REQUIRES_UNMET');
  });

  it('freeBytes 收到的是快照目标所在卷（dataDir），且注入缺失时不因平台差异误杀快照', async () => {
    const seen: string[] = [];
    const res = await snapshot(TXN, ['exclude-me'], {
      freeBytes: (path) => { seen.push(path); return Number.MAX_SAFE_INTEGER; },
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([dir]);
    // 不注入 freeBytes ⇒ 走真实 statfsSync；本机临时目录卷显然放得下这几 KB（snapshot.ts:158-165）
    const plain = await snapshot('txn-nofree', ['exclude-me']);
    expect(plain.ok).toBe(true);
  });
});

describe('入口形态与路径护栏（契约 §6 / §1.9）', () => {
  it('契约导出 snapshotDataDir(dataDir, txnId, excludeRel) 走真实磁盘且形状一致', async () => {
    const res = await snapshotDataDir(dir, 'shutdown-1700000000000', ['updates']);
    expect(Object.keys(res).sort()).toEqual(expect.arrayContaining(['ok', 'txnId', 'snapshotPath', 'files']));
    expect(res.ok).toBe(true);
    expect(res.txnId).toBe('shutdown-1700000000000');
    // 这里只传硬护栏 ['updates'] ⇒ exclude-me 正常入册，比默认现场多 1 项
    expect(res.files).toBe(EXPECTED_IN.length + 1);
    expect(existsSync(join(res.snapshotPath ?? '', SNAPSHOT_MANIFEST_FILENAME))).toBe(true);
  });

  it('main/index.ts 的生产调用形态 snapshotDataDir(dataDir, `shutdown-<Date.now()>`, ["updates"]) 可用', async () => {
    const txnId = `shutdown-${Date.now()}`;
    expect(isSafeTxnId(txnId)).toBe(true);
    const res = await snapshotDataDir(dir, txnId, ['updates']);
    expect(res.ok).toBe(true);
    expect(snapshotRootEntries()).toContain(txnId);
  });

  it('txnId 形态非法 ⇒ SNAPSHOT_FAILED 且绝不写到 dataDir 之外', async () => {
    const res = await snapshot('../../evil');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SNAPSHOT_FAILED');
    expect(res.snapshotPath).toBeNull();
    expect(producedEntries()).toEqual([]);
    expect(existsSync(join(root, 'evil'))).toBe(false);
    // snapshots/ 之下只剩预置的 txn-old 基线：没有新载体，也没有被写到 dataDir 之外
    expect(filesUnder(snapshotsRoot(dir)).every((p) => p.startsWith(`${BASELINE_SNAPSHOT}/`))).toBe(true);
  });

  it('snapshotDir 对非法 txnId 直接抛错；readSnapshotManifest 返回 null 而不是猜测', () => {
    expect(() => snapshotDir(dir, '../x')).toThrow(/unsafe txnId/);
    expect(isSafeTxnId('a/b')).toBe(false);
    expect(isSafeTxnId(42 as unknown)).toBe(false);
    expect(isSafeTxnId('install-3f9a-abc12345')).toBe(true);
  });

  it('readSnapshotManifest 对未发布的 txnId 返回 null（半份快照绝不被当恢复介质）', async () => {
    expect(await readSnapshotManifest(dir, 'never-made')).toBeNull();
    await snapshot();
    expect((await manifestOf()).files.length).toBe(EXPECTED_IN.length);
  });

  it('空 dataDir ⇒ 合法的空快照（全新安装前触发快照时目录可能为空，snapshot.ts:126）', async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const res = await snapshot();
    expect(res.ok).toBe(true);
    expect(res.files).toBe(0);
    const manifest = await manifestOf();
    expect(manifest.files).toEqual([]);
    expect(manifest.excluded).toContain('updates');
  });

  it('dataDir 根本不存在 ⇒ 空快照而不是崩溃，且只创建 updates/snapshots 载体、不伪造任何 data 文件', async () => {
    const missing = join(root, 'nope');
    const res = await snapshotDataDirWithDeps(missing, TXN, ['updates']);
    expect(res.ok).toBe(true);
    expect(res.files).toBe(0);
    expect((await readSnapshotManifest(missing, TXN))?.files).toEqual([]);
    // 唯一出现的新目录是 updates/；data 根下没有任何伪造文件
    expect(readdirSync(missing).sort()).toEqual(['updates']);
    expect(filesUnder(join(missing, 'updates'))
      .filter((p) => !p.startsWith(`snapshots/${TXN}/`))).toEqual([]);
  });

  it('createdAt 取自可注入时钟（恢复时靠它判断快照新旧，installer.ts 的复用三步判定依赖该字段）', async () => {
    await snapshot(TXN, ['exclude-me'], { now: () => 1_700_000_111_000 });
    const manifest = await manifestOf();
    expect(manifest.createdAt).toBe(1_700_000_111_000);
    expect(manifest.schemaVersion).toBe(1);
  });

  it('hashFileSha256 与独立 node:crypto 结果逐字一致（清单哈希可信）', async () => {
    const target = join(dir, 'settings.json');
    expect(await hashFileSha256(target)).toBe(sha256(PLANTED['settings.json']));
    await expect(hashFileSha256(join(dir, 'missing-file.bin'))).rejects.toThrow();
  });

  it('SNAPSHOT_TMP_PREFIX 是快照载体的唯一前缀，也是 pruneRetained 清理孤儿的依据', () => {
    expect(SNAPSHOT_TMP_PREFIX).toBe('.tmp-');
    expect(SNAPSHOT_MANIFEST_FILENAME).toBe('manifest.json');
    expect(SNAPSHOTS_DIRNAME).toBe('snapshots');
  });
});

// 上面注入的 copyFileImpl 需要的真实复制实现（并发用例里先制造竞争再走真复制）。
