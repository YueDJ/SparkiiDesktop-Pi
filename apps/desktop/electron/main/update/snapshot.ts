// 整 data\ 一致性快照（设计 §7.8 / G7 任务第 2 节）。
//
// 形态：文件级一致性复制 + 逐文件 SHA256 清单（manifest.json），先写
// snapshots/.tmp-<uuid>/ 再 rename 原子发布——任何中途失败都不会留下半个
// manifest.json，也不会叠加半份数据（同 txnId 重复调用直接幂等复用）。
//
// SQLite -wal / -shm 的处理（选定方案并说明理由）：
//   本模块**不**打开 better-sqlite3 连接做 VACUUM INTO / wal_checkpoint——
//   关库已由 §7.7 关机序列在快照之前完成（closeStores 先于 snapshotData）。
//   better-sqlite3 在连接 close() 时默认自动 checkpoint 并删除 -wal/-shm。
//   因此：
//   - 存在**非空** -wal ⇒ 判定「库未关 / checkpoint 未完成」的异常现场，返回
//     ok:false reason:'WAL_UNCHECKPOINTED' 并要求调用方先关库重跑（fail closed）。
//     理由：把主库与一个仍被活跃连接持有的 WAL 一起复制，恢复时可能出现
//     WAL 帧与主库页序不一致，比「拒绝快照」危险得多。
//   - 零字节 -wal 与任意 -shm 只是残留工件，**跳过复制**（-shm 是易失共享内存
//     镜像，不含持久数据；空 -wal 不含未合并帧）。
//   单测对三种形态（非空 wal 失败 / 空 wal 跳过 / shm 跳过）逐一覆盖。
//
// 硬性边界：只读 data\，只在 <dataDir>/updates/snapshots/ 下写；
// 默认排除 'updates'（否则快照套快照），该排除是无条件叠加的硬护栏。

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statfsSync } from 'node:fs';
import {
  copyFile as fsCopyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { updatesDir } from './dirs.js';

export const SNAPSHOTS_DIRNAME = 'snapshots';
export const SNAPSHOT_MANIFEST_FILENAME = 'manifest.json';
/** tmp 目录前缀：同 txnId 的原子发布载体，也是 pruneRetained 的孤儿清理对象。 */
export const SNAPSHOT_TMP_PREFIX = '.tmp-';

/** 磁盘预检余量比例：复制期间还可能有并发写入 / 文件系统元数据开销。 */
const SNAPSHOT_SPACE_FACTOR = 1.1;

export interface SnapshotResult {
  ok: boolean;
  txnId: string;
  snapshotPath: string | null;
  files: number;
  reason?: string;
  message?: string;
}

export interface SnapshotManifestEntry {
  /** 相对 dataDir 的路径，统一 '/' 分隔（跨平台可移植的恢复介质）。 */
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  txnId: string;
  createdAt: number;
  files: SnapshotManifestEntry[];
  /** 实际生效的排除根（含无条件叠加的 'updates'）。 */
  excluded: string[];
}

/** 可注入依赖（单测用固定实现替代真机磁盘 / 模拟复制中途失败）。 */
export interface SnapshotDeps {
  now?(): number;
  /** 目标路径所在卷的空闲字节；缺省 statfsSync，取不到 ⇒ 视为充足（不因平台差异误杀快照）。 */
  freeBytes?(path: string): number;
  /** 复制实现注入：单测用它模拟「拷贝中途抛错」。 */
  copyFileImpl?(src: string, dst: string): Promise<void>;
}

export function snapshotsRoot(dataDir: string): string {
  return join(updatesDir(dataDir), SNAPSHOTS_DIRNAME);
}
export function snapshotDir(dataDir: string, txnId: string): string {
  if (!isSafeTxnId(txnId)) throw new Error(`snapshotDir: unsafe txnId ${String(txnId)}`);
  return join(snapshotsRoot(dataDir), txnId);
}
export function isSafeTxnId(txnId: unknown): boolean {
  return typeof txnId === 'string' && /^[0-9A-Za-z._-]+$/.test(txnId);
}

function normalizeSeg(seg: string): string {
  return seg.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 流式 sha256（hex），避免把大文件整读进内存。 */
export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk as Buffer));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

interface WalkFile {
  relPath: string;   // '/' 分隔
  absPath: string;
  bytes: number;
  mtimeMs: number;
}

interface WalkOutcome {
  files: WalkFile[];
  /** 存在非空 -wal ⇒ 库未关 / checkpoint 未完成，调用方必须 fail closed。 */
  walDirty: boolean;
  /** 跳过的非普通文件（socket / fifo / symlink 等）计数，仅供诊断。 */
  skippedSpecial: number;
}

async function walkDataDir(
  root: string,
  excludedTopLevel: Set<string>,
  relPrefix = '',
  acc?: WalkOutcome,
): Promise<WalkOutcome> {
  const out = acc ?? { files: [] as WalkFile[], walDirty: false, skippedSpecial: 0 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // data 目录不存在 ⇒ 空快照（合法：全新安装前触发快照时目录可能为空）
  }
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (relPrefix === '' && excludedTopLevel.has(normalizeSeg(entry.name))) continue;
    const abs = join(root, entry.name);
    if (entry.isSymbolicLink()) { out.skippedSpecial += 1; continue; } // 防环，绝不跟随符号链接
    if (entry.isDirectory()) { await walkDataDir(abs, excludedTopLevel, rel, out); continue; }
    if (!entry.isFile()) { out.skippedSpecial += 1; continue; }
    const st = await stat(abs);
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('-shm')) continue;              // 易失共享内存镜像，不含持久数据
    if (lower.endsWith('-wal')) {
      if (st.size > 0) out.walDirty = true;            // 非空 WAL：异常现场，见文件头说明
      continue;                                        // 空 WAL 不携带未合并帧
    }
    out.files.push({ relPath: rel, absPath: abs, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

async function tryReadManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    const text = await readFile(join(dir, SNAPSHOT_MANIFEST_FILENAME), 'utf8');
    const parsed = JSON.parse(text) as SnapshotManifest;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function defaultFreeBytes(path: string): number {
  try {
    const st = statfsSync(path);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY; // statfs 不可用 ⇒ 不因平台差异误杀快照
  }
}

/**
 * 整 data\ 一致性快照。成功 ⇒ <dataDir>/updates/snapshots/<txnId>/（含 manifest.json）；
 * 空间不足 ⇒ reason 'REQUIRES_UNMET'（调用方据此中止关机序列，见 G7 任务第 2 节）；
 * 中途任何失败 ⇒ tmp 目录清理 + reason 'SNAPSHOT_FAILED'，绝不留下半个 manifest.json。
 */
export async function snapshotDataDirWithDeps(
  dataDir: string,
  txnId: string,
  excludeRel: string[],
  deps: SnapshotDeps = {},
): Promise<SnapshotResult> {
  const now = deps.now?.() ?? Date.now();
  const fail = (reason: string, message: string): SnapshotResult =>
    ({ ok: false, txnId, snapshotPath: null, files: 0, reason, message });

  if (!isSafeTxnId(txnId)) return fail('SNAPSHOT_FAILED', `txnId 形态非法：${String(txnId)}`);
  const root = snapshotsRoot(dataDir);
  const finalDir = join(root, txnId);

  // 幂等：完整快照（manifest 可读）直接复用，绝不叠加半份数据。
  const existing = await tryReadManifest(finalDir);
  if (existing) {
    return {
      ok: true, txnId, snapshotPath: finalDir, files: existing.files.length,
      message: '快照已存在（幂等复用）',
    };
  }
  // finalDir 存在但 manifest 不可读：正常流程不可能（rename 只携带完整目录），
  // 视为陈旧残留，只清自己拥有的 snapshots/<txnId> 后重建。
  await rm(finalDir, { recursive: true, force: true });

  // 预扫描（不写任何东西）：收集文件 + WAL 脏检查 + 空间需求。
  const excluded = new Set<string>(['updates']);          // 无条件硬护栏：快照永不套快照
  for (const seg of excludeRel ?? []) excluded.add(normalizeSeg(seg));
  const walk = await walkDataDir(dataDir, excluded);
  if (walk.walDirty) {
    return fail(
      'WAL_UNCHECKPOINTED',
      '存在非空 SQLite -wal：关机序列未先关库或 checkpoint 未完成，拒绝做快照（§7.8 必须先关库再备份）',
    );
  }
  const totalBytes = walk.files.reduce((s, f) => s + f.bytes, 0);
  const needBytes = Math.ceil(totalBytes * SNAPSHOT_SPACE_FACTOR);
  const free = deps.freeBytes ? deps.freeBytes(dataDir) : defaultFreeBytes(dataDir);
  if (free < needBytes) {
    return fail('REQUIRES_UNMET', `磁盘空间不足：需要约 ${needBytes} 字节，空闲 ${free}`);
  }

  const tmpDir = join(root, `${SNAPSHOT_TMP_PREFIX}${randomUUID()}`);
  const copy = deps.copyFileImpl ?? fsCopyFile;
  try {
    await mkdir(tmpDir, { recursive: true });
    const manifestEntries: SnapshotManifestEntry[] = [];
    for (const f of walk.files) {
      const dst = join(tmpDir, ...f.relPath.split('/'));
      await mkdir(dirname(dst), { recursive: true });
      await copy(f.absPath, dst);
      // m8：哈希/字节/时间一律取**拷贝后的 dst**，不取源路径。原先 hashFileSha256(f.absPath)
      // 与 copy 之间有一个窗口：源在这期间被写者改动 ⇒ manifest 记的哈希 ≠ 快照里的字节
      // （恢复时 fail-safe 拒绝，但快照内部不一致）。dst 在 tmp 目录里、发布前无人可写，
      // 因此「记录的就是快照实际持有的字节」。
      const dstStat = await stat(dst);
      manifestEntries.push({
        path: f.relPath, sha256: await hashFileSha256(dst), bytes: dstStat.size, mtimeMs: dstStat.mtimeMs,
      });
    }
    const manifest: SnapshotManifest = {
      schemaVersion: 1, txnId, createdAt: now, files: manifestEntries, excluded: [...excluded],
    };
    await writeFile(join(tmpDir, SNAPSHOT_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
    try {
      await rename(tmpDir, finalDir);                      // 原子发布
    } catch (err) {
      // 并发重入：另一份完整快照已抢先落地 ⇒ 幂等复用，清掉自己的 tmp。
      const raced = await tryReadManifest(finalDir);
      if (raced) {
        await rm(tmpDir, { recursive: true, force: true });
        return { ok: true, txnId, snapshotPath: finalDir, files: raced.files.length, message: '快照已存在（并发复用）' };
      }
      throw err;
    }
  } catch (err) {
    // 中途失败：删除半份 tmp。finalDir 要么从未出现、要么是先前完整快照。
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return fail('SNAPSHOT_FAILED', `快照复制失败：${String(err)}`);
  }
  return { ok: true, txnId, snapshotPath: finalDir, files: walk.files.length };
}

/** 契约 §6 导出形状（不带注入依赖的生产入口）；installer.ts 原样再导出。 */
export async function snapshotDataDir(
  dataDir: string,
  txnId: string,
  excludeRel: string[],
): Promise<SnapshotResult> {
  return snapshotDataDirWithDeps(dataDir, txnId, excludeRel, {});
}

/** 读取某快照目录的 manifest（installer 的定位 / 恢复复用）。 */
export async function readSnapshotManifest(
  dataDir: string,
  txnId: string,
): Promise<SnapshotManifest | null> {
  if (!isSafeTxnId(txnId)) return null;
  return tryReadManifest(snapshotDir(dataDir, txnId));
}
