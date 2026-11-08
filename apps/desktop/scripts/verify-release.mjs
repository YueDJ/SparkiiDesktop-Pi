import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex, sha512Base64, verifyBytes } from './sign-release.mjs';
import { isValidPointerPath, isValidVersionSegment } from './publish-release.mjs';

// 离线校验一棵发布树（设计稿 §6.3 验签顺序 / §8.2 回读校验）。
// 严格顺序：channel.json 形态/正则 → 指针签名 → manifestSha256 与实收 release.json 字节
//          → 清单签名 → sequence 相等 → expiresAt 未过 → 包体 sha512/bytes 一致。
// 任一失败即 fail closed：返回 { ok:false, reason }，CLI 打印 `FAIL <reason>` 并退出 1。

const ARTIFACT_NAME_RE = /^Sparkii-[0-9A-Za-z.+-]+-win-x64\.exe$/;
const ARTIFACT_URL_RE = /^releases\/[0-9A-Za-z.+-]+\/Sparkii-[0-9A-Za-z.+-]+-win-x64\.exe$/;

function validArtifactUrl(u) {
  return typeof u === 'string' && ARTIFACT_URL_RE.test(u) && !u.includes('..');
}

function validateChannelShape(ch) {
  if (!ch || typeof ch !== 'object') return { ok: false, reason: 'POINTER_INVALID (not an object)' };
  if (ch.schemaVersion !== 1) return { ok: false, reason: 'POINTER_INVALID (schemaVersion)' };
  if (ch.product !== 'Sparkii') return { ok: false, reason: 'POINTER_INVALID (product)' };
  if (ch.channel !== 'stable') return { ok: false, reason: 'POINTER_INVALID (channel)' };
  if (ch.platform !== 'win-x64') return { ok: false, reason: 'POINTER_INVALID (platform)' };
  if (!Number.isInteger(ch.sequence) || ch.sequence < 0) return { ok: false, reason: 'POINTER_INVALID (sequence)' };
  // 版本段判据与客户端逐字同源（R5 · Major-1）：原先这里只判「非空字符串」，
  // 于是 `..` / `CON` / 70 字长的 targetVersion 能过发布自检却被客户端拒收。
  if (!isValidVersionSegment(ch.targetVersion)) {
    return { ok: false, reason: 'POINTER_INVALID (targetVersion)' };
  }
  if (!isValidPointerPath(ch.manifestPath)) return { ok: false, reason: 'POINTER_INVALID (manifestPath)' };
  if (!isValidPointerPath(ch.signaturePath)) return { ok: false, reason: 'POINTER_INVALID (signaturePath)' };
  if (typeof ch.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ch.manifestSha256)) {
    return { ok: false, reason: 'POINTER_INVALID (manifestSha256)' };
  }
  if (typeof ch.publishedAt !== 'string' || Number.isNaN(Date.parse(ch.publishedAt))) {
    return { ok: false, reason: 'POINTER_INVALID (publishedAt)' };
  }
  return { ok: true };
}

function validateReleaseShape(r) {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'MANIFEST_INVALID (not an object)' };
  if (r.schemaVersion !== 2) return { ok: false, reason: 'MANIFEST_INVALID (schemaVersion)' };
  if (r.product !== 'Sparkii' || r.channel !== 'stable' || r.platform !== 'win-x64') {
    return { ok: false, reason: 'MANIFEST_INVALID (product/channel/platform)' };
  }
  if (!Number.isInteger(r.sequence)) return { ok: false, reason: 'MANIFEST_INVALID (sequence)' };
  if (typeof r.nonce !== 'string' || r.nonce.length === 0) return { ok: false, reason: 'MANIFEST_INVALID (nonce)' };
  if (typeof r.publishedAt !== 'string' || Number.isNaN(Date.parse(r.publishedAt))) {
    return { ok: false, reason: 'MANIFEST_INVALID (publishedAt)' };
  }
  if (typeof r.expiresAt !== 'string' || Number.isNaN(Date.parse(r.expiresAt))) {
    return { ok: false, reason: 'MANIFEST_INVALID (expiresAt)' };
  }
  if (!isValidVersionSegment(r.version)) return { ok: false, reason: 'MANIFEST_INVALID (version)' };
  if (!r.artifact || typeof r.artifact !== 'object') return { ok: false, reason: 'MANIFEST_INVALID (artifact)' };
  if (typeof r.artifact.name !== 'string' || !ARTIFACT_NAME_RE.test(r.artifact.name)) {
    return { ok: false, reason: 'MANIFEST_INVALID (artifact.name)' };
  }
  if (!Number.isInteger(r.artifact.bytes) || r.artifact.bytes < 0) {
    return { ok: false, reason: 'MANIFEST_INVALID (artifact.bytes)' };
  }
  if (typeof r.artifact.sha512 !== 'string' || r.artifact.sha512.length === 0) {
    return { ok: false, reason: 'MANIFEST_INVALID (artifact.sha512)' };
  }
  if (!validArtifactUrl(r.artifact.url)) return { ok: false, reason: 'MANIFEST_INVALID (artifact.url)' };
  // 名字与 URL 必须由**已判合法**的版本段推出：否则 `[0-9A-Za-z.+-]+` 这类宽字符类
  // 能让 `Sparkii-..-win-x64.exe` 过关，而客户端按 pending/<version>/ 落点判据会拒收。
  if (r.artifact.name !== `Sparkii-${r.version}-win-x64.exe`) {
    return { ok: false, reason: 'MANIFEST_INVALID (artifact.name vs version)' };
  }
  if (r.artifact.url !== `releases/${r.version}/${r.artifact.name}`) {
    return { ok: false, reason: 'MANIFEST_INVALID (artifact.url vs version)' };
  }
  return { ok: true };
}

/** 离线校验发布树；返回 { ok:true } 或 { ok:false, reason }。 */
export function verifyReleaseTree(opts) {
  const { outDir, publicKeyPem, kid: expectedKid } = opts;
  const now = opts.now ?? Date.now();
  try {
    // 1. channel.json 形态 / 正则
    const channelBytes = readFileSync(join(outDir, 'channel.json'));
    let channel;
    try {
      channel = JSON.parse(channelBytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'POINTER_INVALID (not JSON)' };
    }
    const shape = validateChannelShape(channel);
    if (!shape.ok) return { ok: false, reason: shape.reason };

    // 2. 指针签名
    const channelSigText = readFileSync(join(outDir, 'channel.json.sig'), 'utf8');
    if (!verifyBytes(channelBytes, channelSigText, publicKeyPem)) {
      return { ok: false, reason: 'POINTER_SIGNATURE_INVALID' };
    }
    let channelKid;
    try {
      channelKid = JSON.parse(channelSigText).kid;
    } catch {
      return { ok: false, reason: 'POINTER_SIGNATURE_INVALID' };
    }
    if (expectedKid && channelKid !== expectedKid) return { ok: false, reason: 'POINTER_KID_MISMATCH' };

    // 3. manifestSha256 与实收 release.json 原始字节
    const releaseBytes = readFileSync(join(outDir, channel.manifestPath));
    if (sha256Hex(releaseBytes) !== channel.manifestSha256) {
      return { ok: false, reason: 'MANIFEST_HASH_MISMATCH' };
    }

    // 4. 清单签名
    const releaseSigText = readFileSync(join(outDir, channel.signaturePath), 'utf8');
    if (!verifyBytes(releaseBytes, releaseSigText, publicKeyPem)) {
      return { ok: false, reason: 'MANIFEST_SIGNATURE_INVALID' };
    }
    let releaseKid;
    try {
      releaseKid = JSON.parse(releaseSigText).kid;
    } catch {
      return { ok: false, reason: 'MANIFEST_SIGNATURE_INVALID' };
    }
    if (releaseKid !== channelKid) return { ok: false, reason: 'KID_MISMATCH' };
    if (expectedKid && releaseKid !== expectedKid) return { ok: false, reason: 'KID_MISMATCH' };

    let release;
    try {
      release = JSON.parse(releaseBytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'MANIFEST_INVALID (not JSON)' };
    }
    const releaseShape = validateReleaseShape(release);
    if (!releaseShape.ok) return { ok: false, reason: releaseShape.reason };

    // 5. sequence 相等（+ publishedAt / version 一致）
    if (release.sequence !== channel.sequence) return { ok: false, reason: 'SEQUENCE_MISMATCH' };
    if (release.publishedAt !== channel.publishedAt) return { ok: false, reason: 'PUBLISHED_AT_MISMATCH' };
    if (release.version !== channel.targetVersion) return { ok: false, reason: 'VERSION_MISMATCH' };

    // 6. expiresAt 未过
    if (Date.parse(release.expiresAt) <= now) return { ok: false, reason: 'EXPIRED' };

    // 7. 包体 sha512 / bytes 一致
    const artifactBytes = readFileSync(join(outDir, release.artifact.url));
    if (artifactBytes.length !== release.artifact.bytes) return { ok: false, reason: 'ARTIFACT_BYTES_MISMATCH' };
    if (sha512Base64(artifactBytes) !== release.artifact.sha512) {
      return { ok: false, reason: 'ARTIFACT_SHA512_MISMATCH' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `IO_ERROR (${err && err.message ? err.message : err})` };
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const outDir = readOption('--out');
  const publicKeyPath = readOption('--public-key');
  if (!outDir || !publicKeyPath) {
    throw new Error('usage: verify-release.mjs --out <root> --public-key <pem|public-key.json> [--kid <kid>]');
  }
  let publicKeyPem = readFileSync(publicKeyPath, 'utf8').trim();
  // 也接受 release-keys.mjs 产出的 public-key.json（其内嵌 PEM 文本不能以字串包含来判断）。
  if (publicKeyPem.startsWith('{')) {
    try {
      publicKeyPem = JSON.parse(publicKeyPem).publicKeyPem;
    } catch {
      throw new Error(`--public-key is neither a PEM nor a public-key.json: ${publicKeyPath}`);
    }
  }
  if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    throw new Error(`--public-key is not a valid PEM / public-key.json: ${publicKeyPath}`);
  }
  const result = verifyReleaseTree({
    outDir,
    publicKeyPem,
    kid: readOption('--kid'),
    now: Date.now(),
  });
  if (result.ok) {
    console.log('OK');
    process.exitCode = 0;
  } else {
    console.log(`FAIL ${result.reason}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    console.log(`FAIL ${err.message}`);
    process.exitCode = 1;
  });
}
