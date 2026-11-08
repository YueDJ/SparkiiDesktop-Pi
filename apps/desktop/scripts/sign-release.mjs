import { createHash, sign, verify } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 签名协议（设计稿 §6.3 / 接口契约 §1.8）：
//   被签消息 = kid(utf8) || 0x00 || sha256(fileBytes 原始字节)
//   Ed25519 sign(null, 消息, 私钥) → base64；.sig 文件为 {"kid","signature"} envelope。
//   签名覆盖的是文件「原始字节」，不做 JSON 归一化、不做键排序，避免解析差异。
//   kid 计入签名输入：换 kid 后即便复用同一段 signature，因消息前缀变化也必然验签失败。
//   kid 与公钥的对应关系（按 kid 选钥）由调用方保证：本函数只用 envelope 内的 kid 还原消息，
//   并用调用方传入的 publicKeyPem 验签；调用方须确保该公钥正是该 kid 对应的公钥。

function signatureInput(fileBytes, kid) {
  return Buffer.concat([
    Buffer.from(kid, 'utf8'),
    Buffer.from([0x00]),
    createHash('sha256').update(fileBytes).digest(),
  ]);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

/** 对文件原始字节签名，返回 base64 字符串。 */
export function signBytes(fileBytes, privateKeyPem, kid) {
  return sign(null, signatureInput(fileBytes, kid), privateKeyPem).toString('base64');
}

/** .sig 文件内容：JSON envelope {"kid","signature"}。 */
export function signatureEnvelope(kid, signature) {
  return JSON.stringify({ kid, signature });
}

/** 校验 .sig envelope 与原始字节；kid 一致性（按 kid 选钥）由调用方保证。 */
export function verifyBytes(fileBytes, sigText, publicKeyPem) {
  let envelope;
  try {
    envelope = JSON.parse(sigText);
  } catch {
    return false;
  }
  if (!envelope || typeof envelope.kid !== 'string' || typeof envelope.signature !== 'string') {
    return false;
  }
  let signature;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    return false;
  }
  try {
    return verify(null, signatureInput(fileBytes, envelope.kid), publicKeyPem, signature);
  } catch {
    return false;
  }
}

// 与 scripts/create-release-manifest.mjs 的 atomicWrite 一致：临时文件 + rename。
function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const keyPath = readOption('--key');
  const filePath = readOption('--file');
  const kid = readOption('--kid');
  if (!keyPath || !filePath || !kid) {
    throw new Error('usage: sign-release.mjs --key <private.pem> --file <path> --kid <kid> [--out <path>]');
  }
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  const fileBytes = readFileSync(filePath);
  const signature = signBytes(fileBytes, privateKeyPem, kid);
  const sigText = signatureEnvelope(kid, signature);
  const outPath = readOption('--out') ?? `${filePath}.sig`;
  atomicWrite(outPath, Buffer.from(sigText, 'utf8'));
  // 绝不打印私钥内容。
  console.log(`signature envelope: ${outPath} (kid=${kid})`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
