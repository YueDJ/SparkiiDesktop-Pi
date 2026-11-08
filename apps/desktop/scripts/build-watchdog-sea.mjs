/*
 * 把 scripts/update-watchdog.mjs 打成独立可执行文件（B1 修复的载体，设计 §7.7:591）。
 *
 * 为什么必须独立：NSIS 在升级链路上有两个 kill 点，都按「镜像名 = Sparkii.exe」或
 * 「进程路径在 $INSTDIR 之下」匹配（allowOnlyOneInstallerInstance.nsh:66 / :75）。
 * watchdog 若以 $INSTDIR\Sparkii.exe + ELECTRON_RUN_AS_NODE 运行，静默安装必被 KILL；
 * 即便豁免 kill，它仍持有 $INSTDIR\Sparkii.exe 句柄 ⇒ 旧卸载器 un.atomicRMDir 的
 * Rename 撞占用 ⇒ Abort。独立镜像名 + $INSTDIR 之外的部署位置同时避开两者（部署在
 * update/installer.ts 里做）。
 *
 * 产物：build/watchdog/sparkii-update-watchdog.exe（Node SEA，体积 ≈ node 运行时）。
 * 它**不是** Sparkii.exe 改名，也不含 Chromium/Electron。
 *
 * 构建步骤：
 *   1. esbuild 把 ESM 源打成 CommonJS（Node SEA v22 只接受 CJS；源里的顶层 await
 *      已在 update-watchdog.mjs 里改成 promise 链）；
 *   2. `node --experimental-sea-config` 生成 blob；
 *   3. 复制当前 node 运行时（process.execPath）到产物路径；
 *   4. postject 注入 blob（sentinel fuse 必须是 NODE_SEA_FUSE_…，否则 SEA 不生效）。
 *
 * 签名：注入会破坏 node.exe 自带的 Authenticode 签名。发布构建必须用**与 app 相同的
 * 证书**重签，否则 SmartScreen/MOTW 行为不可预期（真机验收项）。本脚本只在显式提供
 * 证书材料时签名，否则打印醒目警告——不假装签过。
 *
 *   SPARKII_SIGNTOOL=signtool.exe
 *   SPARKII_SIGN_CERT=<pfx 路径>
 *   SPARKII_SIGN_CERT_PASSWORD=<密码，可选>
 *   SPARKII_SIGN_TIMESTAMP_URL=<默认 http://timestamp.digicert.com>
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(desktopRoot, 'scripts', 'update-watchdog.mjs');
const outDir = join(desktopRoot, 'build', 'watchdog');
const outExe = join(outDir, 'sparkii-update-watchdog.exe');

// Node 的 SEA 运行时按这个 fuse 名查找注入的 blob；postject 默认值不同，必须显式给。
const NODE_SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(message) {
  process.stdout.write(`[build-watchdog-sea] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[build-watchdog-sea] WARNING: ${message}\n`);
}

function signIfConfigured(exePath) {
  const signtool = process.env.SPARKII_SIGNTOOL;
  const cert = process.env.SPARKII_SIGN_CERT;
  if (!signtool || !cert) {
    warn(
      'watchdog 未签名（未设置 SPARKII_SIGNTOOL / SPARKII_SIGN_CERT）。'
      + '发布构建必须用与 app 相同的证书重签，见 docs/release-windows.md。',
    );
    return;
  }
  if (!existsSync(cert)) {
    throw new Error(`SPARKII_SIGN_CERT 指向的文件不存在：${cert}`);
  }
  const args = ['sign', '/fd', 'sha256', '/f', cert];
  const password = process.env.SPARKII_SIGN_CERT_PASSWORD;
  if (password) args.push('/p', password);
  const timestampUrl = process.env.SPARKII_SIGN_TIMESTAMP_URL ?? 'http://timestamp.digicert.com';
  args.push('/tr', timestampUrl, '/td', 'sha256', exePath);
  log(`签名 ${exePath}`);
  execFileSync(signtool, args, { stdio: 'inherit' });
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`找不到 watchdog 源文件：${sourcePath}`);
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'sparkii-watchdog-sea-'));
  try {
    // 1) ESM → CJS。平台 node 让 node: 内置模块保持外部引用，不打进 bundle。
    const bundled = join(work, 'update-watchdog.cjs');
    await build({
      entryPoints: [sourcePath],
      outfile: bundled,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    });

    // 2) SEA blob。
    const blob = join(work, 'watchdog.blob');
    const configPath = join(work, 'sea-config.json');
    writeJson(configPath, {
      main: bundled,
      output: blob,
      disableExperimentalSEAWarning: true,
    });
    log(`生成 SEA blob（node ${process.versions.node}）`);
    execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
    if (!existsSync(blob)) throw new Error('SEA blob 未生成');

    // 3) 复制 node 运行时（先写临时名再换名：目标可能正被上一轮构建占用）。
    const staging = `${outExe}.staging-${process.pid}`;
    copyFileSync(process.execPath, staging);

    // 4) 注入。
    const { inject } = require('postject');
    log('注入 NODE_SEA_BLOB');
    await inject(staging, 'NODE_SEA_BLOB', readFileSync(blob), {
      sentinelFuse: NODE_SEA_FUSE,
      overwrite: true,
    });

    renameSync(staging, outExe);
    signIfConfigured(outExe);

    const size = statSync(outExe).size;
    const digest = createHash('sha256').update(readFileSync(outExe)).digest('hex');
    log(`完成：${outExe}（${(size / 1024 / 1024).toFixed(1)} MiB，sha256 ${digest.slice(0, 16)}…）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

main().catch((err) => {
  process.stderr.write(`[build-watchdog-sea] 失败：${String(err && err.stack ? err.stack : err)}\n`);
  process.exitCode = 1;
});
