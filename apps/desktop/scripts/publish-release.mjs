import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex, sha512Base64, signBytes, signatureEnvelope } from './sign-release.mjs';

// 发布侧（设计稿 §8 / §6 的服务端实现）。
//
// 【m3 · 当前实现边界（如实描述）】本脚本**只做本地落盘**：
//   - 不包含 SSH / SCP 上传，也不做远端回读校验（设计 §8.2 步骤 4–6 的「上传到服务器」与
//     「远端哈希 / 签名回读」本轮**未实现**）；
//   - 产物写到 --out-dir（默认 out/release-source），随后由操作者**人工**把该目录内容
//     上传到 Web 服务器对应的 /sparkii-updates/ 目录，并按 docs/operations/update-service.md
//     的人工规程完成回读与指针切换确认。
//   安全性不依赖上传动作：客户端对任一缺失 / 签名不符 / 清单哈希不一致一律 fail closed
//   （当作「无更新」并静默退避）。但「上传是否成功」目前只能人工确认——这是已登记的缺口。
//
// 【单一逻辑指针 = 两个物理文件；非原子窗口由客户端 fail closed 覆盖】（§8.2 / Minor·5）
// 静态文件托管没有任何事务能力：channel.json 与 channel.json.sig 是两个独立文件，上传之间存在
// 毫秒级不匹配窗口。本工具不声称原子性——安全性由客户端 fail closed 保证：任一文件缺失、指针签名
// 不匹配、清单哈希不一致，客户端一律当作「无更新」并按 §7.10 静默退避，绝不放行未验签内容。
// 因此发布顺序是硬约束：版本目录整套文件先全部原子落盘，最后才切换这一组指针文件（§8.2 步骤 6）。
// 服务器绝不产出 / 上传 latest.yml（客户端从已验签 release.json 本地派生，§6.1）。

const PRODUCT = 'Sparkii';
const CHANNEL = 'stable';
const PLATFORM = 'win-x64';
const REQUIRES = { minOSBuild: '10.0.19045', minFreeDiskBytes: 1200000000 };
// 指针的两个路径按构造只能是 `release.json` / `release.json.sig`，所以这里**直接写死叶段**，
// 不再留一条字符集宽正则（R11 · Minor：宽叶段会让"该不该含 `+`"变成第二个待核对判据；
// 写死之后既更严，也不会与客户端的包名字符集发生漂移）。
const POINTER_PATH_RE = /^releases\/[0-9A-Za-z.+-]+\/release\.json(?:\.sig)?$/;
const ARTIFACT_NAME_RE = /^Sparkii-[0-9A-Za-z.+-]+-win-x64\.exe$/;
const ARTIFACT_URL_RE = /^releases\/[0-9A-Za-z.+-]+\/Sparkii-[0-9A-Za-z.+-]+-win-x64\.exe$/;
const DEFAULT_EXPIRES_HOURS = 72;

/**
 * 版本段的**唯一**判据：必须与客户端 `electron/main/update/dirs.ts` 的 VERSION_SHAPE_RE 逐字一致
 * （R5 · Major-1：原先这里是第三条宽判据 `^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$`，
 * 发布自检放行而客户端拒收的清单就此静默上线）。两侧一致性由
 * `test/update-version-parity.test.ts` 用同一串语料逐条对拍钉住。
 */
const VERSION_SEGMENT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isValidVersionSegment(value) {
  return typeof value === 'string' && value.length <= 64 && VERSION_SEGMENT_RE.test(value);
}

/** manifestPath / signaturePath 形态校验（§6.1.1）：禁止 .. / 绝对路径 / query / fragment。 */
export function isValidPointerPath(p) {
  if (typeof p !== 'string') return false;
  if (!POINTER_PATH_RE.test(p)) return false;
  if (p.includes('..')) return false;
  return true;
}

/** --base-url 仅用于校验 artifact URL 形态，绝不写进任何清单 / 产物。 */
function validateBaseUrl(baseUrl, artifactUrl) {
  if (!baseUrl) return;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`invalid --base-url: ${baseUrl}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`--base-url must be http(s): ${baseUrl}`);
  }
  if (!ARTIFACT_URL_RE.test(artifactUrl) || artifactUrl.includes('..')) {
    throw new Error(`invalid artifact url: ${artifactUrl}`);
  }
  // 拼到 base-url 后 host / scheme 必须不变（相对路径不能注入别的 host）。
  const resolved = new URL(artifactUrl, base);
  if (resolved.host !== base.host || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')) {
    throw new Error(`artifact url escapes base-url host: ${artifactUrl}`);
  }
}

// 防御：产物中绝不出现私钥 / base-url（真实服务器 IP、token）。只扫描文本产物。
function assertNoSecrets(planned, { privateKeyPem, baseUrl }) {
  const secrets = [privateKeyPem];
  if (baseUrl) {
    secrets.push(baseUrl);
    try {
      secrets.push(new URL(baseUrl).host);
    } catch {
      // 已在 validateBaseUrl 校验形态。
    }
  }
  for (const { rel, content } of planned) {
    if (!rel.endsWith('.json') && !rel.endsWith('.sig')) continue;
    const text = content.toString('utf8');
    for (const secret of secrets) {
      if (secret && text.includes(secret)) {
        throw new Error(`refuse to write secret / server address into product: ${rel}`);
      }
    }
  }
}

// 与 scripts/create-release-manifest.mjs 的 atomicWrite 一致：临时文件 + rename（fsync 语义）。
function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
}

/**
 * 组装并（默认）写出一棵发布树。便于单测：CLI 只是这层的一层薄封装。
 * @returns Promise<AssembledRelease>
 */
export async function assembleRelease(opts) {
  const { artifactPath, version, sequence, privateKeyPem, kid, outDir } = opts;

  // ---- 输入校验（fail fast；sequence 绝不自动递增，只认操作者显式传入的值）----
  if (!artifactPath || !isAbsolute(artifactPath)) throw new Error('--artifact must be an absolute path');
  if (!isValidVersionSegment(version)) throw new Error(`invalid --version: ${version}`);
  if (!Number.isInteger(sequence)) throw new Error(`--sequence must be an integer: ${sequence}`);
  if (opts.previousSequence !== undefined && sequence <= opts.previousSequence) {
    throw new Error(
      `sequence must be > previousSequence (${opts.previousSequence}); got ${sequence}. ` +
        'No auto-increment: the operator must pass sequence explicitly.',
    );
  }
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('--key must be a PKCS8 PEM private key');
  }
  if (typeof kid !== 'string' || kid.length === 0) throw new Error('--kid is required');
  if (!outDir) throw new Error('--out is required');
  if (!opts.minSupportedVersion) throw new Error('--min-supported is required');

  const expiresHours = opts.expiresHours ?? DEFAULT_EXPIRES_HOURS;
  if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
    throw new Error(`--expires-hours must be a positive number: ${expiresHours}`);
  }

  const artifactStat = statSync(artifactPath);
  if (!artifactStat.isFile()) throw new Error(`artifact is not a file: ${artifactPath}`);
  // 发布 CLI 为一次性工具，读入内存一次即可同时用于哈希与复制。
  const artifactBytes = readFileSync(artifactPath);
  const artifactSha512 = sha512Base64(artifactBytes);
  const artifactSha256 = sha256Hex(artifactBytes);
  const artifactName = `Sparkii-${version}-win-x64.exe`;
  if (!ARTIFACT_NAME_RE.test(artifactName)) throw new Error(`artifact name failed regex: ${artifactName}`);

  const now = opts.now instanceof Date ? opts.now : new Date();
  const publishedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresHours * 3600 * 1000).toISOString();
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const salt = opts.salt ?? randomBytes(8).toString('hex');
  const highlights = opts.highlights ?? [];
  const summary = opts.summary ?? '';

  const artifactUrl = `releases/${version}/${artifactName}`;
  const manifestPath = `releases/${version}/release.json`;
  const signaturePath = `releases/${version}/release.json.sig`;
  validateBaseUrl(opts.baseUrl, artifactUrl);
  if (!isValidPointerPath(manifestPath)) throw new Error(`manifestPath invalid: ${manifestPath}`);
  if (!isValidPointerPath(signaturePath)) throw new Error(`signaturePath invalid: ${signaturePath}`);

  // ---- release.json：严格 schema 2（契约 §3 / 设计稿 §6.2）----
  const release = {
    schemaVersion: 2,
    product: PRODUCT,
    channel: CHANNEL,
    platform: PLATFORM,
    sequence,
    nonce,
    publishedAt,
    expiresAt,
    version,
    minSupportedVersion: opts.minSupportedVersion,
    rollback: false,
    allowDowngrade: false,
    mandatory: false,
    mandatoryAfter: null,
    rollout: { percentage: 100, salt },
    releaseNotes: { summary, highlights },
    artifact: {
      name: artifactName,
      bytes: artifactBytes.length,
      sha512: artifactSha512,
      url: artifactUrl,
    },
    requires: { ...REQUIRES },
  };
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8');
  const releaseSigEnvelope = signatureEnvelope(kid, signBytes(releaseBytes, privateKeyPem, kid));

  // ---- release-manifest.json：沿用现有 schema 1（人工交付 / 构建审计）----
  const releaseManifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    platform: PLATFORM,
    commit: opts.commit ?? 'unknown',
    builtAt: opts.builtAt ?? publishedAt,
    worktreeDirty: opts.worktreeDirty ?? false,
    unsigned: true,
    artifact: artifactName,
    bytes: artifactBytes.length,
    sha256: artifactSha256,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');

  // ---- channel.json：schema 1 单一逻辑指针（§6.1.1 / 契约 §3）----
  const channel = {
    schemaVersion: 1,
    product: PRODUCT,
    channel: CHANNEL,
    platform: PLATFORM,
    sequence,
    targetVersion: version,
    manifestPath,
    manifestSha256: sha256Hex(releaseBytes), // 实收 release.json 原始字节的 hex sha256
    signaturePath,
    publishedAt,
  };
  const channelBytes = Buffer.from(`${JSON.stringify(channel, null, 2)}\n`, 'utf8');
  const channelSigEnvelope = signatureEnvelope(kid, signBytes(channelBytes, privateKeyPem, kid));

  // ---- 计划写出的文件（数组顺序 == 发布顺序，硬约束）----
  const planned = [];
  planned.push({ rel: artifactUrl, content: artifactBytes });
  if (opts.blockmapPath) {
    // 可选 blockmap：仅复制，本期不启用差分（D6 / §7.6）。
    planned.push({ rel: `${artifactUrl}.blockmap`, content: readFileSync(opts.blockmapPath) });
  }
  planned.push({ rel: manifestPath, content: releaseBytes });
  planned.push({ rel: signaturePath, content: Buffer.from(releaseSigEnvelope, 'utf8') });
  planned.push({ rel: `releases/${version}/release-manifest.json`, content: manifestBytes });

  // ===========================================================================
  // 【§8.2 发布顺序硬约束 · 单一逻辑指针】
  // 以上 5 个（含可选 blockmap 则 6 个）是版本目录整套文件，必须先全部原子落盘。
  // 下面两个是【指针】：channel.json + channel.json.sig，必须是「最后两个」被写入的文件；
  // 顺序固定为 .sig 先、channel.json 后（channel.json 是最终切换动作，切完客户端才可能看到新版本）。
  // 绝不产出 / 上传 latest.yml。两个物理文件的非原子窗口由客户端 fail closed 覆盖（见文件头）。
  // ===========================================================================
  planned.push({ rel: 'channel.json.sig', content: Buffer.from(channelSigEnvelope, 'utf8') });
  planned.push({ rel: 'channel.json', content: channelBytes });

  const files = Object.fromEntries(planned.map((p) => [p.rel, p.content]));
  assertNoSecrets(planned, { privateKeyPem, baseUrl: opts.baseUrl });

  const writeOrder = [];
  if (!opts.dryRun) {
    mkdirSync(join(outDir, 'releases', version), { recursive: true });
    for (const { rel, content } of planned) {
      atomicWrite(join(outDir, rel), content);
      writeOrder.push(rel);
    }
  }

  return {
    outDir,
    version,
    sequence,
    dryRun: Boolean(opts.dryRun),
    release,
    releaseBytes,
    channel,
    channelBytes,
    releaseManifest,
    artifact: {
      name: artifactName,
      bytes: artifactBytes.length,
      sha512: artifactSha512,
      sha256: artifactSha256,
      relPath: artifactUrl,
    },
    files,
    writeOrder,
    plannedPaths: planned.map((p) => p.rel),
  };
}

function parsePublishArgs(argv) {
  const args = { highlights: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const name = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`);
    }
    i += 1;
    if (name === 'highlight') args.highlights.push(value);
    else args[name] = value;
  }
  return args;
}

async function main() {
  const args = parsePublishArgs(process.argv.slice(2));
  for (const flag of ['artifact', 'version', 'sequence', 'key', 'kid', 'out', 'min-supported']) {
    if (args[flag] === undefined) throw new Error(`missing --${flag}`);
  }
  const privateKeyPem = readFileSync(args.key, 'utf8');
  const result = await assembleRelease({
    artifactPath: args.artifact,
    version: args.version,
    sequence: Number.parseInt(args.sequence, 10),
    privateKeyPem,
    kid: args.kid,
    outDir: args.out,
    baseUrl: args['base-url'],
    minSupportedVersion: args['min-supported'],
    expiresHours: args['expires-hours'] !== undefined ? Number(args['expires-hours']) : undefined,
    summary: args.summary,
    highlights: args.highlights,
    blockmapPath: args.blockmap,
    previousSequence:
      args['previous-sequence'] !== undefined ? Number.parseInt(args['previous-sequence'], 10) : undefined,
    dryRun: args.dryRun,
    commit: args.commit,
    builtAt: args['built-at'],
  });
  // 摘要：绝不打印私钥内容；base-url 仅口头说明，绝不写进任何产物。
  console.log(`assembled ${result.version} (sequence=${result.sequence}, kid=${args.kid})`);
  console.log(`out: ${result.outDir}`);
  if (result.dryRun) {
    console.log('dry-run: 只计算哈希与字节，未落盘。');
  } else {
    console.log(`written ${result.writeOrder.length} files; pointer is the last two: ${result.writeOrder.slice(-2).join(', ')}`);
    console.log('发布顺序：版本目录整套文件先写完 → 最后切 channel.json.sig / channel.json（单一逻辑指针）。');
    console.log('两物理文件非原子窗口由客户端 fail closed 覆盖；服务器不上传 latest.yml。');
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
