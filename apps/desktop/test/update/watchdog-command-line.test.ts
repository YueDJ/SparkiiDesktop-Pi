/*
 * M1 的**进程边界**用例：/D= 必须原样到命令行结尾。
 *
 * 为什么必须单独有这一层：installer/watchdog 单测只断言"传给 spawn 的 args 数组里没有引号"，
 * 但真正的命令行是 Node 在 CreateProcess 层拼出来的——它会给含空格的参数自动加双引号。
 * 上一版就栽在这里：args 层全绿，真实 NSIS 收到的却是 "/D=C:\Users\John Smith\…\Sparkii"，
 * NSIS 的 /D 解析要求"最后、无引号"，于是安装目录失效（且旧卸载器先清旧目录 ⇒ 可能旧版被卸、
 * 新版没装上）。本文件用**真实 makensis 编译的探针安装器**断言它自己看到的 $INSTDIR。
 *
 * 依赖：electron-builder 下载的 NSIS（首次 dist 后存在于用户缓存）。找不到时跳过并在
 * 测试名里写明原因；同一来源的模板事实另由 installer-nsh.test.ts 恒实跑覆盖。
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WATCHDOG = join(desktopRoot, 'scripts', 'update-watchdog.mjs');

/** 在 electron-builder 的用户缓存里找 makensis（版本目录名带哈希后缀，逐层找）。 */
function findMakensis(): string | null {
  const cacheRoot = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (!existsSync(cacheRoot)) return null;
  const stack = [cacheRoot];
  let depth = 0;
  while (stack.length && depth < 5) {
    const next: string[] = [];
    for (const dir of stack) {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (entry.name.toLowerCase() === 'makensis.exe') return full;
      }
    }
    stack.length = 0;
    stack.push(...next);
    depth += 1;
  }
  return null;
}

const MAKENSIS = findMakensis();
const dirs: string[] = [];
/** 探针目录跨用例复用，必须与「每个用例的现场目录」分开清理，否则 afterEach 会把探针删掉。 */
const probeDirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
afterAll(() => {
  while (probeDirs.length) {
    try { rmSync(probeDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const PROBE_NSI = `
Unicode true
OutFile "probe.exe"
InstallDir "$EXEDIR\\InstallDefault"
RequestExecutionLevel user
SilentInstall silent
Section
  FileOpen $0 "$EXEDIR\\cmdline.txt" w
  FileWrite $0 "INSTDIR=<<$INSTDIR>>$\\r$\\n"
  FileWrite $0 "CMDLINE=<<$CMDLINE>>$\\r$\\n"
  FileClose $0
SectionEnd
`;

async function buildProbe(): Promise<{ dir: string; exe: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sparkii-nsis-probe-'));
  probeDirs.push(dir);
  writeFileSync(join(dir, 'probe.nsi'), PROBE_NSI, 'utf8');
  // makensis 的 OutFile 相对当前工作目录，必须把 cwd 指到探针目录。
  execFileSync(MAKENSIS!, ['-V1', '-INPUTCHARSET', 'UTF8', 'probe.nsi'], {
    cwd: dir, stdio: 'ignore', windowsHide: true,
  });
  const exe = join(dir, 'probe.exe');
  expect(existsSync(exe), 'makensis 未产出 probe.exe').toBe(true);
  await waitReadable(exe);
  return { dir, exe };
}

function sha512Of(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

/**
 * 等文件可稳定读取：makensis 刚写出的 exe 可能被 Defender 短暂扫描占用
 * （EBUSY/EPERM）。这不是产品行为，只影响取证时机；最多等 3s。
 */
async function waitReadable(path: string): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    try {
      readFileSync(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  readFileSync(path);   // 仍未就绪：让判据以真实错误失败，不吞掉
}

/** 跑一次 watchdog（与生产同形：真实 exe 安装器 + 哨兵），返回探针看到的 $INSTDIR / $CMDLINE。 */
async function runWatchdogWithProbe(
  probeExe: string,
  sentinelDir: string,
): Promise<{ code: number | null; instdir: string; cmdline: string; resultOk: boolean; resultText: string }> {
  await waitReadable(probeExe);
  const runDir = mkdtempSync(join(tmpdir(), 'sparkii-wd-cli-'));
  dirs.push(runDir);
  const sentinel = join(runDir, 'pending-update.json');
  const resultPath = join(runDir, 'install-result.json');
  // 探针会复用同一目录：先删旧输出，避免本次没跑起来时读到上一轮的假证据。
  const probeOut = join(dirname(probeExe), 'cmdline.txt');
  rmSync(probeOut, { force: true });
  writeFileSync(sentinel, JSON.stringify({
    phase: 'installing', targetVersion: '0.2.0', packageSha512: sha512Of(probeExe), installDir: sentinelDir,
  }), 'utf8');
  // 父进程立刻退出（watchdog 只等 PID 消失）
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50);'], { stdio: 'ignore' });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      WATCHDOG,
      '--parent-pid', String(parent.pid),
      '--sentinel', sentinel,
      '--result', resultPath,
      '--timeout-ms', '10000',
      '--installer', probeExe,
      '--', '--updated', '--force-run', '/S',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => {
      const text = existsSync(join(dirname(probeExe), 'cmdline.txt'))
        ? readFileSync(join(dirname(probeExe), 'cmdline.txt'), 'utf8')
        : '';
      const instdir = /INSTDIR=<<([\s\S]*?)>>/.exec(text)?.[1] ?? '';
      const cmdline = /CMDLINE=<<([\s\S]*?)>>/.exec(text)?.[1] ?? '';
      const resultText = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : '';
      let resultOk = false;
      try { resultOk = JSON.parse(resultText).ok === true; } catch { /* ignore */ }
      void stdout; void stderr;
      resolve({ code, instdir, cmdline, resultOk, resultText });
    });
  });
}

describe.skipIf(!MAKENSIS)('M1 · /D= 的进程边界（真实 NSIS 探针）', () => {
  // 探针只编一次（首次编译可能被 Defender 扫描，慢 ~10s）；三个用例共用同一份。
  let probe: { dir: string; exe: string };
  // 全量套件并行跑时，makensis 首次编译 + Defender 扫描可能超过默认 hookTimeout(10s)。
  beforeAll(async () => { probe = await buildProbe(); }, 120_000);

  it('安装目录含空格 ⇒ $INSTDIR 精确等于该路径（没有被加引号）', async () => {
    const spaced = ['C:', 'Users', 'John Smith', 'AppData', 'Local', 'Programs', 'Sparkii'].join(sep);
    const run = await runWatchdogWithProbe(probe.exe, spaced);
    expect(run.code, run.resultText).toBe(0);
    expect(run.resultOk, run.resultText).toBe(true);
    expect(run.instdir).toBe(spaced);
    // NSIS 认出了 /D= 就会把它从 $CMDLINE 里移除；残留即说明没被识别。
    expect(run.cmdline).not.toContain('/D=');
    expect(run.cmdline).not.toContain('"');
  }, 30_000);

  it('安装目录含 & 也不被截断（cmd /c 包装会把 A&B 截成 A）', async () => {
    const amp = ['C:', 'Users', 'John Smith', 'AppData', 'Local', 'Programs', 'A&B'].join(sep);
    const run = await runWatchdogWithProbe(probe.exe, amp);
    expect(run.code, run.resultText).toBe(0);
    expect(run.instdir).toBe(amp);
  }, 30_000);

  it('无空格目录同样正确（对照组）', async () => {
    const plain = ['C:', 'Users', 'YDJ', 'AppData', 'Local', 'Programs', 'Sparkii'].join(sep);
    const run = await runWatchdogWithProbe(probe.exe, plain);
    expect(run.code, run.resultText).toBe(0);
    expect(run.instdir).toBe(plain);
  }, 30_000);
});

describe('M1 · 载体必须把 /D= 逐字交给 CreateProcess（源码级回归门）', () => {
  it('真实安装器分支启用 windowsVerbatimArguments，脚本分支不启用', () => {
    // 行为证据来自上面的真实探针；这条保证在没装 NSIS 缓存的机器上也不会悄悄退回归。
    const source = readFileSync(WATCHDOG, 'utf8');
    expect(source).toMatch(/if \(!asScript\) spawnOptions\.windowsVerbatimArguments = true;/);
    // 不允许用 shell 包装（cmd 会吃掉 & 等合法路径字符）
    expect(source).not.toMatch(/shell:\s*true/);
  });
});
