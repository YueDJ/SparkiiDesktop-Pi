// 本地 pending 伴生清单校验与 derived state 扫描（契约 §5 / 设计 §6.5）。
// 零网络：开机 / 关机重开时从 pending/<v>/ 的伴生清单推导「可安装」，
// 不重新下载、不依赖 update-state.json。坏包一律删除 + 写 update.verify-failed，不显示「可安装」。

import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logUpdateEvent } from './audit.js';
import { compareVersions } from './decision.js';
import { isSafeArtifactName, pendingRoot, pendingVersionDir, isSafeVersionSegment } from './dirs.js';
import { verifyArtifactBytes } from './downloader.js';
import type {
  AuditLike, ChannelJson, LocalUpdateInfo, LoggerLike, PublicKeyMap, ReleaseJson,
} from './types.js';
import { validateChannelPointer, verifySignatureEnvelope } from './verifier.js';

export interface ScanOptions {
  currentVersion: string;
  keys?: PublicKeyMap;
  lastSeenSequence: number | null;
  nonceFor(sequence: number): string | null;
  now(): number;
  audit?: AuditLike;
  logger?: LoggerLike;
}

export type VerifyCompanionResult =
  | { ok: true; release: ReleaseJson; channel: ChannelJson }
  | { ok: false; reason: string };

/** 包体名的形状判据：唯一权威在 dirs.ts（三处判据同源，R8 · Major-2 之后不再各自抄一份）。 */

const COMPANION = {
  release: 'release.json',
  releaseSig: 'release.json.sig',
  channel: 'channel.json',
  channelSig: 'channel.json.sig',
} as const;

/**
 * 校验单个 pending/<v>/ 目录的伴生清单（零网络）：
 * 指针形态/签名 → manifestSha256 → 清单签名 → sequence/publishedAt → expiresAt
 * → 包体 sha512/bytes → sequence 单调/nonce → version ≥ currentVersion。
 * 任一失败写 update.verify-failed 审计并返回失败（不在此删包，由 scanPending 统一删）。
 */
export async function verifyCompanion(
  pendingDir: string,
  opts: ScanOptions,
): Promise<VerifyCompanionResult> {
  const fail = async (reason: string): Promise<VerifyCompanionResult> => {
    await logUpdateEvent(opts.audit, 'update.verify-failed', { reason, dir: pendingDir }, opts.logger);
    return { ok: false, reason };
  };

  let channelBytes: Buffer, channelSigText: string, releaseBytes: Buffer, releaseSigText: string;
  try {
    [channelBytes, channelSigText, releaseBytes, releaseSigText] = await Promise.all([
      readFile(join(pendingDir, COMPANION.channel)),
      readFile(join(pendingDir, COMPANION.channelSig), 'utf8'),
      readFile(join(pendingDir, COMPANION.release)),
      readFile(join(pendingDir, COMPANION.releaseSig), 'utf8'),
    ]);
  } catch {
    return fail('POINTER_INVALID');
  }

  let channel: ChannelJson, release: ReleaseJson;
  try {
    channel = JSON.parse(channelBytes.toString('utf8')) as ChannelJson;
    release = JSON.parse(releaseBytes.toString('utf8')) as ReleaseJson;
  } catch {
    return fail('POINTER_INVALID');
  }

  // 指针形态：用固定占位 baseUrl 做纯形态 / path 校验（本地清单无远程 host）。
  // 相对 manifestPath 与 base 同源，host 校验不会误报；绝对 URL / .. / query 一律被 regex 拒绝。
  const pointer = validateChannelPointer(channel, 'http://localhost/');
  if (!pointer.ok) return fail(pointer.reason);
  // 指针签名 + 清单签名（覆盖原始字节，kid 计入签名输入）。
  if (!verifySignatureEnvelope(channelBytes, channelSigText, opts.keys).ok) {
    return fail('SIGNATURE_INVALID');
  }
  const actualSha256 = createHash('sha256').update(releaseBytes).digest('hex');
  if (actualSha256.toLowerCase() !== channel.manifestSha256.toLowerCase()) {
    return fail('MANIFEST_HASH_MISMATCH');
  }
  if (!verifySignatureEnvelope(releaseBytes, releaseSigText, opts.keys).ok) {
    return fail('SIGNATURE_INVALID');
  }
  if (release.sequence !== channel.sequence || release.publishedAt !== channel.publishedAt ||
      release.version !== channel.targetVersion) {
    return fail('POINTER_INVALID');
  }
  // 不变量 4 的落点之一：目录段必须等于清单版本。
  // 否则「在 pending 根（或任何别的目录）裸放一套真实签名的清单 + 包」就能被当成合法的
  // pending/<version>/ 送进安装事务 —— 签名有效不代表落点合法。
  const dirName = pendingDir.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (dirName !== release.version) {
    return fail('POINTER_INVALID');
  }
  const now = opts.now();
  const expiresAt = Date.parse(release.expiresAt);
  if (Number.isNaN(expiresAt) || now > expiresAt) return fail('EXPIRED');
  const last = opts.lastSeenSequence;
  if (last != null) {
    if (release.sequence < last) return fail('SEQUENCE_REGRESSION');
    if (release.sequence === last) {
      const bound = opts.nonceFor(release.sequence);
      if (bound == null || bound !== release.nonce) return fail('NONCE_MISMATCH');
    }
  }
  if (compareVersions(release.version, opts.currentVersion) < 0) {
    return fail('VERSION_BLOCKED');
  }

  // 包体名必须是纯文件名片段：伴生清单虽已验签，也不允许把 pending/ 之外的路径当安装包执行
  // （不变量 4：安装路径只认 pending/<version>/ 下通过校验的那一个文件）。
  // ⚠ 字符集本身**不挡 `..`**（点是合法字符），也不挡 Windows 保留设备名（`CON.exe` 是设备不是文件），
  // 所以判据收敛在 dirs.ts 的 isSafeArtifactName 一处，与 verifier.deriveLatestYml、发布脚本同一口径。
  if (!isSafeArtifactName(release.artifact?.name)) {
    return fail('ARTIFACT_INVALID');
  }

  // 包体 sha512 / bytes 双校验。
  const artifactPath = join(pendingDir, release.artifact.name);
  const artifact = await verifyArtifactBytes(artifactPath, release.artifact.sha512, release.artifact.bytes);
  if (!artifact.ok) return fail(artifact.reason);

  return { ok: true, release, channel };
}

/**
 * 扫描 pending 下的各版本目录，逐条校验伴生清单。
 * 校验通过 → 生成 LocalUpdateInfo(valid:true)；不通过 → 删除整个坏包目录 + 写审计，不显示「可安装」。
 * 全程零网络、不读 update-state.json（derived state）。
 */
export async function scanPending(dataDir: string, opts: ScanOptions): Promise<LocalUpdateInfo[]> {
  const root = pendingRoot(dataDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: LocalUpdateInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = entry.name;
    // R3 · Major：目录名不是合法版本段 ⇒ 这不是本模块写下的包目录（遗留 `0.2.0.tmp`、
    // `Thumbs.db`、用户手工放的文件夹都可能出现在 pending 根下）。这里**既不抛错也不删除**：
    // 抛错会让整次扫描失败（startupScan / 手动检查被一个无关目录拖下水，更新静默失效），
    // 删除则是在动一个我们无法证明属于更新链路的路径。跳过，交给「只处理自己形态」的原则。
    if (!isSafeVersionSegment(version)) continue;
    const pendingDir = pendingVersionDir(dataDir, version);
    const verdict = await verifyCompanion(pendingDir, opts);
    if (!verdict.ok) {
      // 删不掉的坏包**不能谎报已清理**，也绝不能让一次 rm 异常把整扫抛穿调用方
      // （startupScan / 手动检查会被一个坏目录拖下水，R13 · Major-1 的同型问题）。
      let removed = false;
      try {
        await rm(pendingDir, { recursive: true, force: true });
        removed = true;
      } catch { /* 保留现场，审计里如实记 removed:false */ }
      await logUpdateEvent(opts.audit, 'update.verify-failed', {
        reason: verdict.reason, dir: pendingDir, removed,
      }, opts.logger);
      continue;
    }
    const { release } = verdict;
    result.push({
      version: release.version,
      sequence: release.sequence,
      nonce: release.nonce,
      artifactPath: join(pendingDir, release.artifact.name),
      bytes: release.artifact.bytes,
      sha512: release.artifact.sha512,
      expiresAt: release.expiresAt,
      valid: true,
    });
  }
  return result;
}

/**
 * 删除指定版本的 pending 目录（包 + 伴生清单）。
 * 返回 `true` 表示"该版本目录下已无残留"（含本来就不存在）；`false` 表示形态非法或**真没删掉**，
 * 调用方必须据此给结构化拒绝，不能报"已清理"（R13 · Major-1：原先这里吞异常、门面照样回 ok）。
 */
export async function clearPending(dataDir: string, version: string): Promise<boolean> {
  // 与 pendingVersionDir 同一判据（dirs.ts 是唯一的 choke point）：非法形态一律不删。
  if (!isSafeVersionSegment(version)) return false;
  try {
    await rm(pendingVersionDir(dataDir, version), { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
}
