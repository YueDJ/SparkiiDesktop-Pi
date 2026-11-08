import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 与 packages/config/src/integrity.ts 的 generateKeyPair() 完全一致：
// Ed25519，公钥 spki / PEM，私钥 pkcs8 / PEM。

const DEFAULT_NOT_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

/** 生成密钥对（仅内存，供单测与 CLI 复用）。 */
export function generateReleaseKeyPair(opts = {}) {
  const kid = opts.kid;
  if (typeof kid !== 'string' || !/^[A-Za-z0-9._-]+$/.test(kid)) {
    throw new Error(`invalid --kid: ${kid}`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const now = opts.now instanceof Date ? opts.now : new Date();
  const notBefore = opts.notBefore ?? now.toISOString();
  const notAfter = opts.notAfter ?? new Date(now.getTime() + DEFAULT_NOT_AFTER_MS).toISOString();
  return { kid, publicKey, privateKey, notBefore, notAfter };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const kid = readOption('--kid');
  if (!kid) {
    throw new Error('usage: release-keys.mjs --kid <kid> [--out-dir <abs>] [--not-before ISO] [--not-after ISO] [--rotate]');
  }
  // 私钥绝不写进仓库：默认落到 %USERPROFILE%\.sparkii-release-keys\（os.homedir()）。
  const outDir = readOption('--out-dir') ?? join(homedir(), '.sparkii-release-keys');
  const pair = generateReleaseKeyPair({
    kid,
    notBefore: readOption('--not-before'),
    notAfter: readOption('--not-after'),
  });
  mkdirSync(outDir, { recursive: true });

  const privatePath = join(outDir, `${kid}.private.pem`);
  // 覆盖防护（R8 · Minor-1）：同 kid 重跑会就地毁掉旧私钥，而旧私钥签过的已发布清单从此无人能重签，
  // 客户端侧只能靠内置公钥验签 ⇒ 这台机器上的发布轨迹直接断掉。这是一条「看起来无害的查看动作」
  // 就能触发的不可逆数据丢失，所以默认拒绝，必须显式 --rotate 才允许换钥。
  const publicJsonPath = join(outDir, 'public-key.json');
  if (existsSync(privatePath) && !process.argv.includes('--rotate')) {
    throw new Error(
      `refusing to overwrite existing private key: ${privatePath}\n` +
        `该 kid 的私钥已存在；重跑会销毁它并使此前用该 kid 签发的清单不可重签。\n` +
        `确认要轮换请加 --rotate；只想核对 kid / 公钥请读 ${publicJsonPath}（它同时是构建注入用的 SPARKII_RELEASE_KEYS_FILE），` +
        `或用 verify-release.mjs --public-key <public-key.json> 让脚本自己解析。`,
    );
  }
  writeFileSync(privatePath, pair.privateKey, 'utf8');
  try {
    chmodSync(privatePath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，见下方手工 ACL 提示。
  }
  const publicPemPath = join(outDir, `${kid}.public.pem`);
  writeFileSync(publicPemPath, pair.publicKey, 'utf8');
  writeFileSync(
    publicJsonPath,
    `${JSON.stringify(
      { kid: pair.kid, notBefore: pair.notBefore, notAfter: pair.notAfter, publicKeyPem: pair.publicKey },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 公钥 PEM 打到 stdout（便于管道 / 重定向）；所有说明信息走 stderr，保持 stdout 干净。
  process.stdout.write(pair.publicKey);
  console.error('==== Sparkii 发布密钥 ====');
  console.error(`输出目录（绝对路径）: ${outDir}`);
  console.error(`私钥文件（绝对路径）: ${privatePath}`);
  console.error(`公钥 PEM（绝对路径）: ${publicPemPath}`);
  console.error(`公钥清单: ${publicJsonPath}`);
  console.error(`kid: ${pair.kid}  notBefore: ${pair.notBefore}  notAfter: ${pair.notAfter}`);
  console.error('【私钥离线保管、绝不进仓库】请把私钥放在离线介质，不要提交到任何 Git 仓库。');
  console.error('Windows 权限提示：请手工为该私钥文件设置 ACL，仅允许当前发布者账户读取。');
  console.error('（POSIX 下已尝试 chmod 600；Windows 下 chmod 不等价于 ACL，需手工确认。）');
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
