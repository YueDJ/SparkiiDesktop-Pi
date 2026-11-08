/*
 * Detached 安装 watchdog（设计稿 §7.7 / 接口契约 §6，owner: G6）。
 *
 * 载体（B1 修复）：本文件既可直接 `node update-watchdog.mjs …` 运行，也会由
 * scripts/build-watchdog-sea.mjs 打进一个独立的 Node SEA 可执行文件
 * （sparkii-update-watchdog.exe，镜像名 ≠ Sparkii.exe、运行时部署在 $INSTDIR 之外）。
 * NSIS 的两个 kill 点按「镜像名 = Sparkii.exe」或「路径在 $INSTDIR 之下」匹配，
 * watchdog 两条都不命中，且不再持有 $INSTDIR\Sparkii.exe 的句柄，旧卸载器的
 * un.atomicRMDir 不会因文件占用而 Abort。
 *
 * CLI（契约 §6 钉死，逐字）：
 *   <watchdog 载体> --parent-pid <pid> --sentinel <abs> --result <abs> \
 *     --timeout-ms 60000 --installer <abs> -- --updated --force-run /S /D=<dir>
 *
 * 行为：
 *   1. 参数校验：--installer / --sentinel / --result 必须绝对路径；
 *      --parent-pid / --timeout-ms 必须正整数；非法 ⇒ 写 ARGS_INVALID 结果，退出码 2。
 *   2. 读哨兵 pending-update.json 取 targetVersion / packageSha512 / installDir；
 *      缺失或 JSON 解析失败 ⇒ SENTINEL_INVALID，退出码 2。
 *      哨兵没有 packageSha512 ⇒ 无法做安装前重哈希 ⇒ SENTINEL_INVALID（fail closed）。
 *   3. --installer 不存在 ⇒ INSTALLER_MISSING，退出码 2（不等待父进程）。
 *   3b. M4：对 --installer 重算 sha512(base64) 与哨兵 packageSha512 比对；不符（或读不动）
 *      ⇒ INSTALLER_HASH_MISMATCH，退出码 2，【不 spawn】。这收窄了「验签 → 执行」之间
 *      被本机换包的窗口；重哈希与 spawn 之间仍有残余竞态（按路径 spawn 无法继承句柄），
 *      不宣称等价于「持有句柄直到交给安装器」。
 *   4. 轮询等待父 PID 消失（间隔 200ms ≤ 500ms；Windows 下 process.kill(pid,0)
 *      仅在 ESRCH 时判定「已消失」，EINVAL 表示存在但无权限，继续等待）。
 *      总超时（--timeout-ms，默认 60000）⇒ PARENT_TIMEOUT 且【不 spawn】，退出码 2。
 *   5. 父进程消失后 spawn 安装器；args 来自 `--` 之后的透传（至少 /S）。
 *      若哨兵含 installDir 且透传里没有 /D=，则把 `/D=<dir>` 作为【最后一个参数】
 *      追加且不加引号（NSIS 要求 /D= 必须最后、路径含空格也不加引号）。
 *   6. 单一写入方：只有本进程写 install-result.json，临时文件 + rename 原子替换，
 *      写完即落盘（writeFileSync + renameSync），因为父应用此时已经退出。
 *      字段固定：{ ok, exitCode, targetVersion, packageSha512, parentGoneAt,
 *                 spawnedAt, writtenAt, writer:'watchdog', reason? }。
 *   7. 退出码：安装器 exitCode 0 ⇒ 0；非 0 ⇒ 透传该码且 ok:false；
 *      上述错误（ARGS_INVALID / SENTINEL_INVALID / INSTALLER_MISSING /
 *      INSTALLER_HASH_MISMATCH / INSTALLER_NOT_EXECUTABLE / PARENT_TIMEOUT /
 *      SPAWN_FAILED）⇒ 2。
 *
 * 纯 Node（node:fs / node:path / node:child_process / node:crypto），绝不 import
 * Electron 或仓库内 TS 模块——它必须在应用已退出后独立运行。
 *
 * 本文件的**运行时外壳必须是 CJS 可打包的**（Node SEA 22 只接受 CommonJS）：因此
 * 入口写作 `main(...).then(...)`，不使用顶层 await；直接以 .mjs 运行时行为不变。
 *
 * 测试钩子：--installer 若以 .mjs/.cjs/.js 结尾，则用 process.execPath 间接执行
 * （Windows 无法直接 spawn 脚本文件）；仅用于假安装器测试（任务 0 已验证模式，
 * docs/superpowers/specs/2026-11-06-task0-scripts/watchdog.mjs）。真实 NSIS 为
 * .exe，走字面上的 spawn(installer, args) 分支，与契约形态一致。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isSea } from 'node:sea';

const FLAG_KEYS = new Set(['parent-pid', 'sentinel', 'result', 'timeout-ms', 'installer']);
const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 解析 CLI。`--` 之后的全部 token 原样透传给安装器。
 * 返回 null 表示存在未知 token 或重复/缺值的旗标（⇒ ARGS_INVALID）。
 */
function parseArgs(argv) {
  const out = { flags: Object.create(null), passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { out.passthrough = argv.slice(i + 1); return out; }
    if (typeof a !== 'string' || !a.startsWith('--')) return null;
    const key = a.slice(2);
    if (!FLAG_KEYS.has(key) || key in out.flags) return null;
    i += 1;
    const value = argv[i];
    if (typeof value !== 'string' || value.startsWith('--')) return null;
    out.flags[key] = value;
  }
  return out;
}

function positiveIntOrNull(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Windows 语义：process.kill(pid, 0) 抛 ESRCH ⇒ 进程已消失；
 * 不抛 ⇒ 存活；抛 EINVAL ⇒ 存在但无权限，【不得】当成已消失。
 * 其它错误一律保守视为存活（绝不提前 spawn 安装器）。
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !e || e.code !== 'ESRCH';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 流式 sha512(base64)：与 downloader.verifyArtifactBytes 同一口径（electron-updater
 * 清单里的 artifact.sha512 即 base64）。大包不整读进内存。
 */
function sha512Base64File(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(hash.digest('base64')));
  });
}

/**
 * 原子单一写入：先写临时文件再 rename。
 * ⚠ Windows 上「rename 可以覆盖已存在的目标」并不总成立：目标若正被另一个进程打开（读取结果、
 * 或另一个 watchdog 刚 rename 完又被读）就会 EPERM/EBUSY。原先这里裸调 renameSync，
 * 抛错时会把自己的 `.tmp` 永久留在 `data\updates\` 里（实测：两个 watchdog 并发约每 5 次留 1 次残留）。
 * 现在：rename 失败 ⇒ 尽力删掉自己的临时文件并放弃这一次写入（结果文件由先赢的那个持有，
 * 内容仍是完整 JSON；不覆盖、不留垃圾），绝不因此让 watchdog 崩溃或改判安装结果。
 */
function writeResultAtomic(resultPath, payload) {
  const full = {
    ok: payload.ok,
    exitCode: payload.exitCode ?? null,
    targetVersion: payload.targetVersion ?? null,
    packageSha512: payload.packageSha512 ?? null,
    parentGoneAt: payload.parentGoneAt ?? null,
    spawnedAt: payload.spawnedAt ?? null,
    writtenAt: new Date().toISOString(),
    writer: 'watchdog',
  };
  if (payload.reason) full.reason = payload.reason;
  mkdirSync(dirname(resultPath), { recursive: true });
  const tmp = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, resultPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 删不掉也不能再抛：本次结果让给先赢的写入方 */ }
    try {
      process.stderr.write(`[watchdog] install-result 写入让位（目标被占用）：${String(err && err.code ? err.code : err)}\n`);
    } catch { /* stderr 不可用不影响主流程 */ }
  }
}

function isoNow() {
  return new Date().toISOString();
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const flags = parsed ? parsed.flags : null;

  // 1) 参数校验。result 路径本身非法时无法写结果文件，只能以退出码表达失败。
  const resultPath = parsed ? parsed.flags.result : undefined;
  const canWriteResult =
    typeof resultPath === 'string' && resultPath.length > 0 && isAbsolute(resultPath);
  const writeOrFail = (fields) => {
    if (canWriteResult) writeResultAtomic(resultPath, fields);
  };

  if (!parsed) return { code: 2, finalize: () => writeOrFail({ ok: false, reason: 'ARGS_INVALID' }) };
  const parentPid = positiveIntOrNull(flags['parent-pid']);
  const timeoutRaw = flags['timeout-ms'];
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : positiveIntOrNull(timeoutRaw);
  const sentinelPath = flags.sentinel;
  const installerPath = flags.installer;
  const absOk = (p) => typeof p === 'string' && p.length > 0 && isAbsolute(p);
  if (
    parentPid === null || timeoutMs === null ||
    !absOk(sentinelPath) || !absOk(installerPath) || !absOk(resultPath)
  ) {
    return { code: 2, finalize: () => writeOrFail({ ok: false, reason: 'ARGS_INVALID' }) };
  }

  // 2) 哨兵：缺失或 JSON 解析失败 ⇒ SENTINEL_INVALID。
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  } catch {
    sentinel = null;
  }
  if (sentinel === null || typeof sentinel !== 'object' || Array.isArray(sentinel)) {
    return { code: 2, finalize: () => writeOrFail({ ok: false, reason: 'SENTINEL_INVALID' }) };
  }
  const base = {
    targetVersion: typeof sentinel.targetVersion === 'string' ? sentinel.targetVersion : null,
    packageSha512: typeof sentinel.packageSha512 === 'string' ? sentinel.packageSha512 : null,
  };

  // 3) 安装器存在性（不等待父进程即可判定，失败尽早退出且不 spawn）。
  if (!existsSync(installerPath)) {
    return { code: 2, finalize: () => writeOrFail({ ...base, ok: false, reason: 'INSTALLER_MISSING' }) };
  }

  // 3b) M4：安装前重哈希。哨兵必须带 packageSha512（没有就无法比对 ⇒ fail closed）。
  //     放在等待父进程之前：包被动过就立刻失败，不必让主进程白等 60s。
  //     这一条只**收窄** TOCTOU 窗口（验签 → 执行之间本机换包），不是「持句柄到安装器」；
  //     重哈希与 spawn 之间仍有残余竞态（NSIS 按路径 spawn，句柄继承不可行）。
  if (base.packageSha512 === null) {
    return { code: 2, finalize: () => writeOrFail({ ...base, ok: false, reason: 'SENTINEL_INVALID' }) };
  }
  let actualSha512;
  try {
    actualSha512 = await sha512Base64File(installerPath);
  } catch (err) {
    try {
      process.stderr.write(`[watchdog] 安装包重哈希失败，拒绝执行：${String(err)}\n`);
    } catch { /* stderr 不可用不影响判定 */ }
    return { code: 2, finalize: () => writeOrFail({ ...base, ok: false, reason: 'INSTALLER_HASH_MISMATCH' }) };
  }
  if (actualSha512 !== base.packageSha512) {
    try {
      process.stderr.write(
        `[watchdog] 安装包 sha512 与哨兵不符，拒绝执行：expected=${base.packageSha512} actual=${actualSha512}\n`,
      );
    } catch { /* stderr 不可用不影响判定 */ }
    return { code: 2, finalize: () => writeOrFail({ ...base, ok: false, reason: 'INSTALLER_HASH_MISMATCH' }) };
  }

  // 4) 等待父进程消失，超时 ⇒ PARENT_TIMEOUT 且不 spawn。
  const startedAt = Date.now();
  let parentGoneAt = null;
  for (;;) {
    if (!pidAlive(parentPid)) { parentGoneAt = Date.now(); break; }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt))));
  }
  if (parentGoneAt === null) {
    return {
      code: 2,
      finalize: () => writeOrFail({ ...base, ok: false, reason: 'PARENT_TIMEOUT' }),
    };
  }

  // 5) 组装透传参数；哨兵含 installDir 且未显式给 /D= 时，/D=<dir> 追加为最后一个
  //    参数，不加引号（NSIS 约定：/D= 必须最后，含空格路径也不加引号）。
  const installerArgs = [...parsed.passthrough];
  const installDir = sentinel.installDir;
  const hasD = installerArgs.some((a) => /^\/D=/i.test(a));
  if (!hasD && typeof installDir === 'string' && installDir.length > 0) {
    installerArgs.push(`/D=${installDir}`);
  }

  // 6) spawn 安装器。.mjs/.cjs/.js 视为测试假安装器，经 process.execPath 间接执行；
  //    真实 NSIS .exe 走字面 spawn(installer, args)。
  //    ⚠ 在 SEA 载体里 process.execPath 就是 watchdog 自己 —— 拿它跑脚本会递归回本程序，
  //    因此 SEA 中拒绝脚本安装器（生产只会传 .exe；这条边界让误用立刻失败而不是死循环）。
  //
  //    ⚠⚠ /D= 必须**逐字**送到 CreateProcess：Node 默认会给「含空格的参数」加双引号，
  //    而 NSIS 要求 /D= 之后原样到命令行结尾、绝不能带引号。实测（真实 NSIS 探针）：
  //      - 默认 spawn ⇒ 命令行以 "/D=C:\Users\John Smith\…\Sparkii" 结束，
  //        NSIS 不认识这个带引号的 /D，$INSTDIR 仍是默认值 / GetDParameter 取到带尾引号的路径；
  //      - windowsVerbatimArguments:true ⇒ 命令行以 /D=C:\Users\John Smith\… 结束，$INSTDIR 正确，
  //        且 C:\…\A&B 这类合法路径也不会被 shell 截断（cmd /c 包装会）。
  //    因此**真实安装器分支必须开 verbatim**；脚本分支只在测试里用，保持普通转义。
  const asScript = /\.(?:mjs|cjs|js)$/i.test(installerPath);
  let runningAsSea = false;
  try { runningAsSea = isSea(); } catch { /* 老运行时没有 node:sea ⇒ 视为非 SEA */ }
  if (asScript && runningAsSea) {
    return {
      code: 2,
      finalize: () => writeOrFail({ ...base, ok: false, reason: 'INSTALLER_NOT_EXECUTABLE' }),
    };
  }
  const [cmd, cmdArgs] = asScript
    ? [process.execPath, [installerPath, ...installerArgs]]
    : [installerPath, installerArgs];
  const spawnOptions = { detached: false, stdio: 'ignore', windowsHide: true };
  if (!asScript) spawnOptions.windowsVerbatimArguments = true;
  const spawnedAt = isoNow();
  const child = spawn(cmd, cmdArgs, spawnOptions);
  let spawnError = null;
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => { spawnError = e; resolve(null); });
    child.on('exit', (code, signal) => { resolve(code ?? (signal ? -1 : 0)); });
  });


  if (spawnError) {
    return {
      code: 2,
      finalize: () => writeOrFail({
        ...base, ok: false, exitCode: null,
        parentGoneAt: new Date(parentGoneAt).toISOString(), spawnedAt,
        reason: 'SPAWN_FAILED',
      }),
    };
  }

  // 7) 结果：exitCode===0 ⇒ ok:true 退出 0；非 0 ⇒ ok:false 透传该码。
  const ok = exitCode === 0;
  return {
    code: ok ? 0 : (exitCode ?? 2),
    finalize: () => writeOrFail({
      ...base, ok, exitCode,
      parentGoneAt: new Date(parentGoneAt).toISOString(), spawnedAt,
    }),
  };
}

// Node SEA（v22 只支持 CommonJS）不接受顶层 await：用 promise 链收尾，
// 直接以 .mjs 运行时行为与原先一致（成功/失败都写结果并设置退出码）。
main(process.argv.slice(2)).then(
  (outcome) => {
    outcome.finalize();
    process.exitCode = outcome.code;
  },
  (err) => {
    try {
      process.stderr.write(`[watchdog] 未预期错误：${String(err && err.stack ? err.stack : err)}\n`);
    } catch { /* stderr 不可用不影响退出码 */ }
    process.exitCode = 1;
  },
);
