// 下载计划 / 迁移 / 校验（契约 §5 / 设计 §6.5）。
// - planDownload：磁盘预检、pending/<v>/ 准备、.part 命名、字节上限。
// - finalizeDownload：从 updater 缓存迁移并落下伴生清单，迁移前后各验一次 sha512/bytes。
// - verifyArtifactBytes：流式 sha512 + size 双校验。
// - cancelDownload：只清 .part，绝不丢已完成的包。

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile, mkdir, readdir, rename, rm, statfs, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { logUpdateEvent } from './audit.js';
import { pendingVersionDir } from './dirs.js';
import type { AuditLike, LoggerLike, ReleaseJson, UpdateProgress } from './types.js';

export const PART_SUFFIX = '.part';

/**
 * 磁盘预检余量（§7.6「预检 bytes × 2 + 余量」）：除包体外还要留出
 * updater 缓存 / pending 迁移副本与安装期临时空间的余量。
 */
export const DISK_PRECHECK_SLACK_BYTES = 256 * 1024 * 1024;

export interface DownloadPlanOptions {
  dataDir: string;
  release: ReleaseJson;
  /** 注入的空闲磁盘字节数（单测用）；缺省用 statfs(dataDir) 实测。 */
  freeDiskBytes?: number;
}

export interface DownloadPlan {
  ok: boolean;
  reason?: string;
  version: string;
  artifactName: string;
  pendingDir: string;
  partPath: string;
  finalPath: string;
  bytesCap: number;
  expectedSha512: string;
  minFreeDiskBytes: number;
  freeDiskBytes: number;
}

/** 下载进度累加器（流式下载与单测共用，便于断言百分比 / 字节累加）。 */
export class ProgressAccumulator {
  bytesDownloaded = 0;
  constructor(readonly bytesTotal: number) {}
  add(n: number): void {
    this.bytesDownloaded = Math.min(this.bytesDownloaded + n, Number.MAX_SAFE_INTEGER);
  }
  percent(): number {
    if (this.bytesTotal <= 0) return 0;
    return Math.min(100, Math.floor((this.bytesDownloaded / this.bytesTotal) * 100));
  }
  snapshot(savePath: string | null): UpdateProgress {
    return {
      percent: this.percent(),
      bytesDownloaded: this.bytesDownloaded,
      bytesTotal: this.bytesTotal,
      savePath,
    };
  }
}

/** 流式 sha512(base64) + size 双校验。 */
export async function verifyArtifactBytes(
  filePath: string,
  expectedSha512: string,
  expectedBytes: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let bytes = 0;
  const hash = createHash('sha512');
  try {
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      hash.update(buf);
    }
  } catch {
    return { ok: false, reason: 'ARTIFACT_INVALID' };
  }
  if (bytes !== expectedBytes) return { ok: false, reason: 'ARTIFACT_INVALID' };
  if (hash.digest('base64') !== expectedSha512) return { ok: false, reason: 'ARTIFACT_INVALID' };
  return { ok: true };
}

async function freeBytes(dataDir: string): Promise<number> {
  try {
    const st = await statfs(dataDir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY; // 取不到时把判定交给上层（不因 statfs 失败误放行由调用方控制）
  }
}

/**
 * 磁盘预检 + 目标目录准备。字节上限恒为 artifact.bytes。
 * 预检不足返回 ok:false（reason REQUIRES_UNMET），由服务层拒绝下载。
 */
export async function planDownload(opts: DownloadPlanOptions): Promise<DownloadPlan> {
  const release = opts.release;
  const version = release.version;
  const artifactName = release.artifact.name;
  const bytesCap = release.artifact.bytes;
  const expectedSha512 = release.artifact.sha512;
  const minFreeDiskBytes = Number.isFinite(release.requires?.minFreeDiskBytes)
    ? release.requires.minFreeDiskBytes
    : 0;
  const pendingDir = pendingVersionDir(opts.dataDir, version);
  const plan: DownloadPlan = {
    ok: true,
    version,
    artifactName,
    pendingDir,
    partPath: join(pendingDir, `${artifactName}${PART_SUFFIX}`),
    finalPath: join(pendingDir, artifactName),
    bytesCap,
    expectedSha512,
    minFreeDiskBytes,
    freeDiskBytes: opts.freeDiskBytes ?? await freeBytes(opts.dataDir),
  };
  // 预检（§7.6）：空闲需同时满足清单下限与「bytes × 2 + 余量」，取更严的一个。
  const requiredBytes = Math.max(minFreeDiskBytes, bytesCap * 2 + DISK_PRECHECK_SLACK_BYTES);
  if (plan.freeDiskBytes < requiredBytes) {
    plan.ok = false;
    plan.reason = 'REQUIRES_UNMET';
    return plan;
  }
  await mkdir(pendingDir, { recursive: true });
  return plan;
}

export interface FinalizeOptions {
  dataDir: string;
  plan: DownloadPlan;
  cachedFilePath: string;       // updater 下载缓存中的文件（已由 executor.download 终检过）
  releaseBytes: Buffer;
  releaseSigText: string;
  channelBytes: Buffer;
  channelSigText: string;
  audit?: AuditLike;
  logger?: LoggerLike;
}

export type FinalizeResult =
  | { ok: true; artifactPath: string }
  | { ok: false; reason: string };

async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (err) {
    // 跨卷时 rename 报 EXDEV → 退化为 copy + unlink。
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(src, dst);
      await rm(src, { force: true });
    } else {
      throw err;
    }
  }
}

/** 删除坏包（缓存 .part / 目标 / 已迁移文件）并写 update.verify-failed。 */
async function rejectBad(
  paths: string[],
  audit: AuditLike | undefined,
  logger: LoggerLike | undefined,
): Promise<void> {
  // 清理是尽力而为：**单个删不掉绝不能把这次调用整体抛出去**——那会盖掉真正的失败原因
  // （调用方正在返回 ARTIFACT_INVALID / DOWNLOAD_FAILED）。删不掉的如实镜像到日志。
  for (const p of paths) {
    try {
      await rm(p, { force: true });
    } catch (err) {
      try { logger?.warn(`[update] 坏包清理失败（保留现场，不影响判定）：${p}：${String(err)}`); } catch { /* 日志失败不改变判定 */ }
    }
  }
  await logUpdateEvent(audit, 'update.verify-failed', { reason: 'ARTIFACT_INVALID' }, logger);
}

/**
 * 迁移前、迁移后各验一次 sha512/bytes；两次都通过才落伴生清单并标记可安装。
 * 任一次失败 → 删除坏包 + 写审计 + 返回失败，绝不把坏包留在 pending/。
 */
export async function finalizeDownload(opts: FinalizeOptions): Promise<FinalizeResult> {
  const { plan } = opts;
  const bad = [opts.cachedFilePath, plan.partPath, plan.finalPath];

  // 迁移前校验（缓存文件）。
  const pre = await verifyArtifactBytes(opts.cachedFilePath, plan.expectedSha512, plan.bytesCap);
  if (!pre.ok) {
    await rejectBad(bad, opts.audit, opts.logger);
    return { ok: false, reason: pre.reason };
  }

  await mkdir(plan.pendingDir, { recursive: true });
  try {
    await moveFile(opts.cachedFilePath, plan.finalPath);
  } catch {
    await rejectBad(bad, opts.audit, opts.logger);
    return { ok: false, reason: 'DOWNLOAD_FAILED' };
  }

  // 迁移后校验（目标文件）。
  const post = await verifyArtifactBytes(plan.finalPath, plan.expectedSha512, plan.bytesCap);
  if (!post.ok) {
    await rejectBad(bad, opts.audit, opts.logger);
    return { ok: false, reason: post.reason };
  }

  // 落下伴生清单（已验签原始字节 + .sig 文本），供关机重开 derived state 扫描。
  try {
    await writeFile(join(plan.pendingDir, 'release.json'), opts.releaseBytes);
    await writeFile(join(plan.pendingDir, 'release.json.sig'), opts.releaseSigText, 'utf8');
    await writeFile(join(plan.pendingDir, 'channel.json'), opts.channelBytes);
    await writeFile(join(plan.pendingDir, 'channel.json.sig'), opts.channelSigText, 'utf8');
    // 清掉可能残留的 .part。
    await rm(plan.partPath, { force: true });
  } catch {
    await rejectBad(bad, opts.audit, opts.logger);
    return { ok: false, reason: 'DOWNLOAD_FAILED' };
  }

  return { ok: true, artifactPath: plan.finalPath };
}

/**
 * 取消下载：仅删除 .part 临时文件，回 available；绝不删除已完成的包或其伴生清单。
 * 返回被清理的 .part 数。
 */
export async function cancelDownload(dataDir: string, version: string): Promise<number> {
  const dir = pendingVersionDir(dataDir, version);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (name.endsWith(PART_SUFFIX)) {
      // 「取消」与「清理」都是尽力而为：删不掉不能把异常抛穿门面（R13 · Major-1 同型），
      // 但计数只记真的删掉的那些——谎报已清理等于让运维以为残留已清干净。
      try {
        await rm(join(dir, name), { force: true });
        removed += 1;
      } catch { /* 保留现场，计数不动 */ }
    }
  }
  return removed;
}

/** 供 executor / 单测生成随机的 .part 路径前缀（唯一性）。 */
export function uniquePartTag(): string {
  return randomUUID();
}
