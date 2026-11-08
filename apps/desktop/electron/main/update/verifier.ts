// 验签与策略门禁（契约 §5 / 设计 §6.2 §6.3 §6.5 §6.6）。安全核心，最严格。
// 这是「清单 / 策略」数据的唯一对外 HTTP 入口。任何失败一律 fail closed + 写 update.verify-failed 审计。
//
// 签名方案（与 G1 发布侧 / 单测共享，见 signatureInput）：
//   .sig 文件是 JSON 文本 { kid, signature(base64) }；
//   被签名的消息 = Buffer.concat([ kid(utf8), 0x00, sha256(原始文件字节) ])；
//   Ed25519：crypto.sign(null, message, privateKeyPem) / crypto.verify(null, message, publicKeyPem, sig)。
//   签名覆盖原始字节，绝不做 JSON 归一化；kid 计入签名输入，换 kid 即验签失败。

import { createHash, verify } from 'node:crypto';
import { RELEASE_PUBLIC_KEYS } from './config.js';
import { assertMinSupportedVersion, compareVersions } from './decision.js';
// 版本段判据只有一处（dirs.ts，I-30）；这里曾留着自己的宽正则 `^[0-9A-Za-z.+-]+$`，
// 它**允许 `..`**，属 R2 · B2 点名的同一类漂移 ⇒ 改为直接调用 choke point。
import { ARTIFACT_NAME_CHARS, isSafeArtifactName, isSafeVersionSegment } from './dirs.js';
import { logUpdateEvent } from './audit.js';
import type {
  AuditLike, ChannelJson, LoggerLike, PublicKeyMap, ReleaseJson, SignatureEnvelope,
} from './types.js';

export const MANIFEST_MAX_BYTES = 256 * 1024;
export const CHANNEL_JSON = 'channel.json';
export const CHANNEL_SIG = 'channel.json.sig';
// 文件名段允许 `+`：带构建元数据的合法 semver（如 1.2.3+build.7）会推出
// `Sparkii-1.2.3+build.7-win-x64.exe`；原先此处与 local-artifacts 的名字判据都不含 `+`，
// 于是发布自检 OK 而客户端 100% 拒收（R8 · Major-2）。穿越仍由显式 `..` 判断挡住。
// 文件段的字符类**共享 dirs.ts 的 ARTIFACT_NAME_CHARS**（R11 · Minor：不用 `.source.slice()` 反推，
// 那种写法一旦有人调整锚点就会静默改变本正则的语义）。
export const RELEASE_PATH_RE = new RegExp(
  `^releases\\/[0-9A-Za-z.+-]+\\/[${ARTIFACT_NAME_CHARS}]+$`,
);

/** 被签名消息：kid(utf8) || 0x00 || sha256(原始字节)。验证方与签发方必须逐字节一致。 */
export function signatureInput(bytes: Buffer, kid: string): Buffer {
  return Buffer.concat([
    Buffer.from(kid, 'utf8'),
    Buffer.from([0x00]),
    createHash('sha256').update(bytes).digest(),
  ]);
}

export type VerifySigResult = { ok: true; kid: string } | { ok: false; reason: string };

/**
 * 验证一个 .sig 信封：解析 {kid,signature} → 按 kid 选公钥 → 校验 notBefore/notAfter → 验签。
 * 不提供任何「跳过验签」开关；keys 为空（占位）或 kid 不存在一律失败。
 */
export function verifySignatureEnvelope(
  bytes: Buffer,
  sigText: string,
  keys?: PublicKeyMap,
): VerifySigResult {
  const map = keys ?? RELEASE_PUBLIC_KEYS;
  let env: SignatureEnvelope;
  try {
    env = JSON.parse(sigText) as SignatureEnvelope;
  } catch {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
  if (!env || typeof env.kid !== 'string' || typeof env.signature !== 'string' || !env.signature) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
  const entry = map[env.kid];
  if (!entry || typeof entry.pem !== 'string') {
    return { ok: false, reason: 'SIGNATURE_INVALID' }; // kid 不匹配 / 无对应公钥
  }
  const now = Date.now();
  const notBefore = Date.parse(entry.notBefore);
  const notAfter = Date.parse(entry.notAfter);
  if (Number.isNaN(notBefore) || Number.isNaN(notAfter) || now < notBefore || now > notAfter) {
    return { ok: false, reason: 'SIGNATURE_INVALID' }; // 密钥不在有效期内
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(env.signature, 'base64');
  } catch {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
  try {
    const ok = verify(null, signatureInput(bytes, env.kid), entry.pem, sig);
    if (!ok) return { ok: false, reason: 'SIGNATURE_INVALID' };
  } catch {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
  return { ok: true, kid: env.kid };
}

export type PointerResult = { ok: true } | { ok: false; reason: string };

/** 指针（channel.json）的全部形态校验 + 与 baseUrl 同 host/port/scheme。 */
export function validateChannelPointer(ch: ChannelJson, baseUrl: string): PointerResult {
  if (!ch || ch.schemaVersion !== 1 || ch.product !== 'Sparkii' ||
      ch.channel !== 'stable' || ch.platform !== 'win-x64') {
    return { ok: false, reason: 'POINTER_INVALID' };
  }
  if (!Number.isInteger(ch.sequence) || ch.sequence < 0) {
    return { ok: false, reason: 'POINTER_INVALID' };
  }
  if (typeof ch.targetVersion !== 'string' || !isSafeVersionSegment(ch.targetVersion)) {
    return { ok: false, reason: 'POINTER_INVALID' };
  }
  if (typeof ch.manifestSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(ch.manifestSha256)) {
    return { ok: false, reason: 'POINTER_INVALID' };
  }
  if (typeof ch.publishedAt !== 'string' || Number.isNaN(Date.parse(ch.publishedAt))) {
    return { ok: false, reason: 'POINTER_INVALID' };
  }
  for (const p of [ch.manifestPath, ch.signaturePath]) {
    if (typeof p !== 'string' || !RELEASE_PATH_RE.test(p)) {
      return { ok: false, reason: 'POINTER_INVALID' };
    }
    // 显式禁用 .. / 绝对 / query / fragment / 反斜杠（regex 已排除，这里再兜一层）。
    if (p.includes('..') || p.startsWith('/') || p.includes('?') ||
        p.includes('#') || p.includes(':') || p.includes('\\')) {
      return { ok: false, reason: 'POINTER_INVALID' };
    }
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  for (const p of [ch.manifestPath, ch.signaturePath]) {
    const joined = new URL(p, base);
    if (joined.protocol !== base.protocol || joined.hostname !== base.hostname ||
        joined.port !== base.port) {
      return { ok: false, reason: 'POINTER_INVALID' }; // host / port / scheme 不一致
    }
  }
  return { ok: true };
}

export interface VerifyOptions {
  baseUrl: string;                       // 已归一化，以 / 结尾
  now(): number;
  currentVersion: string;
  lastSeenSequence: number | null;
  nonceFor(sequence: number): string | null; // 本地绑定的 (sequence → nonce)
  keys?: PublicKeyMap;                   // 单测注入离线测试公钥；缺省用编译期 RELEASE_PUBLIC_KEYS
  fetchFn?: typeof fetch;               // 缺省用全局 fetch（单测仍走真实 loopback 服务）
  audit?: AuditLike;
  logger?: LoggerLike;
  requestTimeoutMs?: number;
  allowDowngradeConfirmed?: boolean;    // allowDowngrade 的二次确认标记
  osBuild?: string;
  freeDiskBytes?: number;
}

export interface VerifySuccess {
  ok: true;
  releaseBytes: Buffer;
  release: ReleaseJson;
  channel: ChannelJson;
  channelBytes: Buffer;
  releaseSigText: string;
  channelSigText: string;
}
export type VerifyOutcome = VerifySuccess | { ok: false; reason: string };

async function fetchBytes(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  let res: Response;
  try {
    // 无 query、无自定义 header、无 UA 注入、无设备 ID；不跟随重定向。
    res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  // redirect:'manual' 下 3xx 也是非 200 → 直接拒绝（maxRedirects=0 语义）。
  if (res.status !== 200) return { ok: false, reason: 'NETWORK' };
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader && Number(lenHeader) > MANIFEST_MAX_BYTES) {
    return { ok: false, reason: 'NETWORK' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  if (bytes.length > MANIFEST_MAX_BYTES) return { ok: false, reason: 'NETWORK' };
  return { ok: true, bytes };
}

/**
 * 唯一的清单 / 策略 HTTP 入口。按 §6.3 第 3 条顺序逐项验签，任一失败 fail closed + 写审计。
 */
export async function fetchAndVerify(opts: VerifyOptions): Promise<VerifyOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 8000;
  const fail = async (reason: string): Promise<VerifyOutcome> => {
    await logUpdateEvent(opts.audit, 'update.verify-failed', { reason }, opts.logger);
    return { ok: false, reason };
  };

  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    return fail('INVALID_BASE_URL');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return fail('INVALID_BASE_URL');
  }
  // 拼接四个 URL，并校验与 baseUrl 同 origin。
  let channelUrl: URL, channelSigUrl: URL;
  try {
    channelUrl = new URL(CHANNEL_JSON, base);
    channelSigUrl = new URL(CHANNEL_SIG, base);
  } catch {
    return fail('INVALID_BASE_URL');
  }
  if ([channelUrl, channelSigUrl].some((u) =>
      u.protocol !== base.protocol || u.hostname !== base.hostname || u.port !== base.port)) {
    return fail('POINTER_INVALID');
  }

  // ①② 取指针及其签名（原始字节）。
  const channelRes = await fetchBytes(channelUrl.href, fetchFn, timeoutMs);
  if (!channelRes.ok) return fail(channelRes.reason);
  const channelSigRes = await fetchBytes(channelSigUrl.href, fetchFn, timeoutMs);
  if (!channelSigRes.ok) return fail(channelSigRes.reason);
  const channelBytes = channelRes.bytes;
  const channelSigText = channelSigRes.bytes.toString('utf8');

  // Ⅰ 指针形态（先解析用于读取字段；签名在下面用原始字节复验，绝不重新序列化）。
  let channel: ChannelJson;
  try {
    channel = JSON.parse(channelBytes.toString('utf8')) as ChannelJson;
  } catch {
    return fail('POINTER_INVALID');
  }
  const pointer = validateChannelPointer(channel, opts.baseUrl);
  if (!pointer.ok) return fail(pointer.reason);

  // Ⅱ 指针签名（kid 计入签名输入，覆盖原始字节）。
  const pointerSig = verifySignatureEnvelope(channelBytes, channelSigText, opts.keys);
  if (!pointerSig.ok) return fail(pointerSig.reason);

  // ③④ 取清单及其签名；URL 由已验证形态的 manifestPath / signaturePath 派生。
  let releaseUrl: URL, releaseSigUrl: URL;
  try {
    releaseUrl = new URL(channel.manifestPath, base);
    releaseSigUrl = new URL(channel.signaturePath, base);
  } catch {
    return fail('POINTER_INVALID');
  }
  if ([releaseUrl, releaseSigUrl].some((u) =>
      u.protocol !== base.protocol || u.hostname !== base.hostname || u.port !== base.port)) {
    return fail('POINTER_INVALID');
  }
  const releaseRes = await fetchBytes(releaseUrl.href, fetchFn, timeoutMs);
  if (!releaseRes.ok) return fail(releaseRes.reason);
  const releaseSigRes = await fetchBytes(releaseSigUrl.href, fetchFn, timeoutMs);
  if (!releaseSigRes.ok) return fail(releaseSigRes.reason);
  const releaseBytes = releaseRes.bytes;
  const releaseSigText = releaseSigRes.bytes.toString('utf8');

  // Ⅲ 实收 release.json 字节 sha256 == manifestSha256（原始字节，先验后解析）。
  const actualSha256 = createHash('sha256').update(releaseBytes).digest('hex');
  if (actualSha256.toLowerCase() !== channel.manifestSha256.toLowerCase()) {
    return fail('MANIFEST_HASH_MISMATCH');
  }
  // Ⅳ 清单签名（覆盖原始字节）。
  const releaseSig = verifySignatureEnvelope(releaseBytes, releaseSigText, opts.keys);
  if (!releaseSig.ok) return fail(releaseSig.reason);

  let release: ReleaseJson;
  try {
    release = JSON.parse(releaseBytes.toString('utf8')) as ReleaseJson;
  } catch {
    return fail('POINTER_INVALID');
  }
  if (!release || release.schemaVersion !== 2 || release.product !== 'Sparkii' ||
      release.channel !== 'stable' || release.platform !== 'win-x64') {
    return fail('POINTER_INVALID');
  }
  if (typeof release.artifact?.name !== 'string' || !Number.isFinite(release.artifact?.bytes) ||
      typeof release.artifact?.sha512 !== 'string') {
    return fail('ARTIFACT_INVALID');
  }

  // Ⅴ sequence / publishedAt 一致。
  if (release.sequence !== channel.sequence || release.publishedAt !== channel.publishedAt ||
      release.version !== channel.targetVersion) {
    return fail('POINTER_INVALID');
  }

  // Ⅵ now <= expiresAt 且 publishedAt 合理窗口。
  const now = opts.now();
  const expiresAt = Date.parse(release.expiresAt);
  const publishedAt = Date.parse(release.publishedAt);
  const FIVE_MIN = 5 * 60 * 1000;
  const YEAR = 366 * 24 * 3600 * 1000;
  if (Number.isNaN(expiresAt) || now > expiresAt) return fail('EXPIRED');
  if (Number.isNaN(publishedAt) || publishedAt > now + FIVE_MIN || publishedAt < now - YEAR) {
    return fail('EXPIRED');
  }

  // Ⅶ sequence 单调 + 同 sequence 的 nonce 绑定（防重放）。
  const last = opts.lastSeenSequence;
  if (last != null) {
    if (release.sequence < last) return fail('SEQUENCE_REGRESSION');
    if (release.sequence === last) {
      const bound = opts.nonceFor(release.sequence);
      if (bound == null || bound !== release.nonce) return fail('NONCE_MISMATCH');
    }
  }

  // Ⅷ version >= currentVersion（除非 allowDowngrade + 二次确认）。
  if (compareVersions(release.version, opts.currentVersion) < 0) {
    if (!(release.allowDowngrade === true && opts.allowDowngradeConfirmed === true)) {
      return fail('VERSION_BLOCKED');
    }
  }

  // Ⅸ minSupportedVersion 硬闸门。
  const minGate = assertMinSupportedVersion(opts.currentVersion, release);
  if (!minGate.ok) return fail(minGate.reason);

  // Ⅹ requires 预检。
  const req = release.requires;
  if (!req || typeof req.minOSBuild !== 'string' || !Number.isFinite(req.minFreeDiskBytes)) {
    return fail('REQUIRES_UNMET');
  }
  if (opts.osBuild != null && compareVersions(opts.osBuild, req.minOSBuild) < 0) {
    return fail('REQUIRES_UNMET');
  }
  if (opts.freeDiskBytes != null && opts.freeDiskBytes < req.minFreeDiskBytes) {
    return fail('REQUIRES_UNMET');
  }

  return {
    ok: true,
    releaseBytes,
    release,
    channel,
    channelBytes,
    releaseSigText,
    channelSigText,
  };
}

export type DeriveResult =
  | { ok: true; yml: string; artifactUrl: string }
  | { ok: false; reason: string };

/** 从我们生成的固定格式 yml 里回读字段（deriveLatestYml 的逐字段比对用，不引入 yaml 依赖）。 */
function readBackYml(yml: string): Record<string, string | undefined> {
  const grab = (re: RegExp): string | undefined => {
    const m = re.exec(yml);
    return m ? m[1] : undefined;
  };
  return {
    version: grab(/^version:\s*(\S+)\s*$/m),
    path: grab(/^path:\s*(\S+)\s*$/m),
    sha512: grab(/^sha512:\s*(\S+)\s*$/m),
    size: grab(/^size:\s*(\d+)\s*$/m),
    releaseDate: grab(/^releaseDate:\s*'([^']*)'\s*$/m),
    fileUrl: grab(/^\s+-\s*url:\s*(\S+)\s*$/m),
    fileSha512: grab(/^\s+sha512:\s*(\S+)\s*$/m),
    fileSize: grab(/^\s+size:\s*(\d+)\s*$/m),
  };
}

/**
 * 从「已验签」release.json 派生 latest.yml（§5.2 定案 A / §6.5）。
 * 字段只来自 release；files[0].url 由 baseUrl + releases/<v>/<name> 拼成绝对远程 URL。
 * 派生后立即回读逐字段比对，不一致即失败。yml 不写 releaseNotes。
 */
export function deriveLatestYml(release: ReleaseJson, baseUrl: string): DeriveResult {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  const version = release.version;
  const name = release.artifact?.name;
  if (typeof version !== 'string' || !isSafeVersionSegment(version) || !isSafeArtifactName(name)) {
    return { ok: false, reason: 'ARTIFACT_INVALID' };
  }
  const sha512 = release.artifact.sha512;
  const size = release.artifact.bytes;
  const releaseDate = release.publishedAt;
  let artifactUrl: string;
  try {
    artifactUrl = new URL(`releases/${version}/${name}`, base).href;
  } catch {
    return { ok: false, reason: 'ARTIFACT_INVALID' };
  }
  if (new URL(artifactUrl).origin !== base.origin) {
    return { ok: false, reason: 'ARTIFACT_INVALID' };
  }
  // 若 release 自带 artifact.url，校验其与 baseUrl 同 host/port/scheme（§6.5）；
  // 派生 yml 的 files[0].url 始终由 baseUrl + 版本 + 文件名重建，不采信该字段的路径。
  if (typeof release.artifact.url === 'string' && release.artifact.url) {
    let declared: URL;
    try {
      declared = new URL(release.artifact.url, base);
    } catch {
      return { ok: false, reason: 'ARTIFACT_INVALID' };
    }
    if (declared.origin !== base.origin) {
      return { ok: false, reason: 'ARTIFACT_INVALID' }; // host / port / scheme 不一致
    }
  }

  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactUrl}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `size: ${size}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  // §6.5 派生后回读逐字段比对。
  const rb = readBackYml(yml);
  const ok =
    rb.version === version &&
    rb.path === name &&
    rb.sha512 === sha512 &&
    rb.fileSha512 === sha512 &&
    rb.size === String(size) &&
    rb.fileSize === String(size) &&
    rb.releaseDate === releaseDate &&
    rb.fileUrl === artifactUrl;
  if (!ok) return { ok: false, reason: 'ARTIFACT_INVALID' };

  return { ok: true, yml, artifactUrl };
}
