/*
 * update-watchdog.test.ts（G6，B 关验收「watchdog 时序与退出码」，契约 §9 映射表）。
 *
 * 全部用临时目录 + 假安装器（.mjs，经 process.execPath 执行）验证，
 * 禁止真实 NSIS /S；测试绝不写真实 %LOCALAPPDATA%\SparkiiDesktop。
 * 复用任务 0 已验证的「等 PID 消失 → spawn → 回写 exitCode」模式
 * （docs/superpowers/specs/2026-11-06-task0-scripts/probe-watchdog.mjs）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const WATCHDOG = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'update-watchdog.mjs',
);

/** 假安装器：记录 argv 到 --marker 指定的文件，然后按 --exit-code 退出。 */
const FAKE_INSTALLER_SOURCE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const marker = get('--marker');
if (marker) writeFileSync(marker, JSON.stringify({ spawnedAt: Date.now(), argv }), 'utf8');
process.exit(Number(get('--exit-code') ?? 0));
`;

const dirs: string[] = [];
const extraChildren: ChildProcess[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sparkii-watchdog-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of extraChildren.splice(0)) {
    try { child.kill(); } catch { /* best effort */ }
  }
  while (dirs.length) {
    const dir = dirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** 一个「假主进程」：存活 lifeMs 后自行退出。返回其 PID 与退出时刻 Promise。 */
function spawnParent(lifeMs: number): { pid: number; exited: Promise<void>; child: ChildProcess } {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${lifeMs});`], {
    stdio: 'ignore',
  });
  extraChildren.push(child);
  // 立刻挂 exit 监听：watchdog 可能在父进程已退出之后才结束，晚挂监听会永不触发。
  const exited = new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  return { pid: child.pid!, exited, child };
}

function writeFakeInstaller(dir: string): string {
  const path = join(dir, 'fake-installer.mjs');
  writeFileSync(path, FAKE_INSTALLER_SOURCE, 'utf8');
  return path;
}

/**
 * M4：watchdog 在 spawn 前重算 sha512 并与哨兵的 packageSha512 比对。
 * 测试里的哨兵必须写**真实字节**的哈希，否则会（正确地）被判 INSTALLER_HASH_MISMATCH。
 */
function sha512Of(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

/** 写一份「哈希与安装器实物一致」的哨兵。 */
function writeSentinelFor(sentinel: string, installer: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(sentinel, JSON.stringify({
    phase: 'installing', targetVersion: '0.2.0',
    packageSha512: sha512Of(installer),
    ...extra,
  }), 'utf8');
}

interface RunOptions {
  parentPid: number;
  sentinel: string;
  result: string;
  installer: string;
  timeoutMs?: number;
  passthrough: string[];
}

function runWatchdog(opts: RunOptions): Promise<{ code: number | null; stderr: string }> {
  const argv = [
    WATCHDOG,
    '--parent-pid', String(opts.parentPid),
    '--sentinel', opts.sentinel,
    '--result', opts.result,
    '--timeout-ms', String(opts.timeoutMs ?? 5000),
    '--installer', opts.installer,
    '--', ...opts.passthrough,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    extraChildren.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

function readResult(resultPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
}

describe('update-watchdog.mjs（§7.7 安装事务 watchdog / 契约 §6 CLI）', () => {
  it('成功：父 PID 提前消失 + 假安装器 exit 0 ⇒ ok:true exitCode:0，退出码 0', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer);
    const expectedSha = sha512Of(installer);
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--marker', marker, '--exit-code', '0'],
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const json = readResult(result);
    expect(json.ok).toBe(true);
    expect(json.exitCode).toBe(0);
    expect(json.writer).toBe('watchdog');
    expect(json.targetVersion).toBe('0.2.0');
    expect(json.packageSha512).toBe(expectedSha);
    expect(typeof json.parentGoneAt).toBe('string');
    expect(typeof json.spawnedAt).toBe('string');
    expect(typeof json.writtenAt).toBe('string');
    expect(json.reason).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });

  it('失败：假安装器 exit 1 ⇒ ok:false exitCode:1，退出码透传 1', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer);
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--marker', marker, '--exit-code', '1'],
    });
    expect(run.code).toBe(1);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBe(1);
    expect(json.writer).toBe('watchdog');
    expect(existsSync(marker)).toBe(true);
  });

  it('超时：父进程长期存活 + --timeout-ms 300 ⇒ PARENT_TIMEOUT 且不 spawn，退出码 2', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer);
    // 长期存活的真进程（10s 后自退；afterEach 里也会被 kill 兜底）。
    const parent = spawnParent(10_000);
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer, timeoutMs: 300,
      passthrough: ['/S', '--marker', marker, '--exit-code', '0'],
    });
    expect(run.code).toBe(2);
    // 没有 spawn 假安装器：marker 文件不存在即证明。
    expect(existsSync(marker)).toBe(false);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBeNull();
    expect(json.reason).toBe('PARENT_TIMEOUT');
    expect(json.writer).toBe('watchdog');
    parent.child.kill();
    await parent.exited;
  });

  it('参数非法：相对路径 / parent-pid 非正整数 ⇒ ARGS_INVALID，退出码 2，只写一份结果', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const installer = writeFakeInstaller(dir);
    writeFileSync(sentinel, JSON.stringify({ targetVersion: '0.2.0' }), 'utf8');

    // 情形一：--installer 为相对路径。
    const run1 = await runWatchdog({
      parentPid: 4, sentinel, result,
      installer: 'relative/installer.exe',
      passthrough: ['/S'],
    });
    expect(run1.code).toBe(2);
    let json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBeNull();
    expect(json.reason).toBe('ARGS_INVALID');

    // 情形二：--parent-pid 为 0（非法正整数）。为验证「只写一次」，两次都指向同一 result。
    const run2 = await runWatchdog({
      parentPid: 0, sentinel, result, installer, passthrough: ['/S'],
    });
    expect(run2.code).toBe(2);
    json = readResult(result);
    expect(json.reason).toBe('ARGS_INVALID');
    // 只写一次结果文件：目录里只有一个 install-result.json，且没有残留 .tmp。
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.endsWith('install-result.json'))).toHaveLength(1);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
    // runWatchdog 强制要求 number；非法值通过手工 argv 传入字符串 "abc"。
    const badPid = new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [
        WATCHDOG, '--parent-pid', 'abc', '--sentinel', sentinel,
        '--result', result, '--timeout-ms', '1000', '--installer', installer, '--', '/S',
      ], { stdio: 'ignore' });
      extraChildren.push(child);
      child.on('exit', (code) => resolve(code));
    });
    expect(await badPid).toBe(2);
    expect(readResult(result).reason).toBe('ARGS_INVALID');
  });

  it('哨兵缺失 ⇒ SENTINEL_INVALID，退出码 2，不 spawn；只写一份结果', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json'); // 故意不写
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--marker', marker],
    });
    expect(run.code).toBe(2);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('SENTINEL_INVALID');
    expect(json.writer).toBe('watchdog');
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(dir).filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('安装器缺失 ⇒ INSTALLER_MISSING，退出码 2，不等待父进程消失', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    writeFileSync(sentinel, JSON.stringify({ targetVersion: '0.2.0' }), 'utf8');
    const parent = spawnParent(10_000); // 父进程存活，也必须在存在性检查处立即退出
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result,
      installer: join(dir, 'no-such-installer.exe'),
      timeoutMs: 5000, passthrough: ['/S'],
    });
    expect(run.code).toBe(2);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('INSTALLER_MISSING');
    expect(json.writer).toBe('watchdog');
    void parent.exited;
  });

  it('哨兵 installDir ⇒ /D=<dir> 作为最后一个透传参数且不带引号', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installDir = join(dir, 'Program Files Sparkii'); // 含空格
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer, { installDir });
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['--updated', '--force-run', '/S', '--marker', marker, '--exit-code', '0'],
    });
    expect(run.code).toBe(0);
    const markerJson = JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[] };
    const last = markerJson.argv[markerJson.argv.length - 1];
    expect(last).toBe(`/D=${installDir}`);
    expect(last).not.toContain('"');
    expect(readResult(result).ok).toBe(true);
  });

  it('单一写入：并发两个 watchdog 同 result 路径 ⇒ 完整 JSON 且不留临时文件（8 轮）', async () => {
    // 为什么是 8 轮：这条断言的性质只在**竞态被触发时**才可见。修之前实测约每 5 次就有 1 次
    // 留下 `.tmp` 残留（Windows 下 rename 覆盖被占用的目标会 EPERM，原实现裸调 renameSync 直接抛），
    // 单轮跑等于把结论交给运气。改成 8 轮独立现场，任何一轮留残留就红。
    for (let round = 0; round < 8; round++) {
      const dir = makeTempDir();
      const tag = `round ${round}`;
      const sentinel = join(dir, 'pending-update.json');
      const result = join(dir, 'install-result.json');
      const markerA = join(dir, 'marker-a.json');
      const markerB = join(dir, 'marker-b.json');
      const installer = writeFakeInstaller(dir);
      writeSentinelFor(sentinel, installer, { targetVersion: '0.3.0' });
      const expectedSha = sha512Of(installer);
      const parent = spawnParent(50);
      await parent.exited;
      const [runA, runB] = await Promise.all([
        runWatchdog({
          parentPid: parent.pid, sentinel, result, installer,
          passthrough: ['/S', '--marker', markerA, '--exit-code', '0'],
        }),
        runWatchdog({
          parentPid: parent.pid, sentinel, result, installer,
          passthrough: ['/S', '--marker', markerB, '--exit-code', '1'],
        }),
      ]);
      expect([runA.code, runB.code].sort(), tag).toEqual([0, 1]);
      // 原子 rename 生效：结果文件可完整 JSON.parse，不出现半截内容。
      const json = readResult(result);
      expect(json.writer, tag).toBe('watchdog');
      expect(json.targetVersion, tag).toBe('0.3.0');
      expect(json.packageSha512, tag).toBe(expectedSha);
      expect([true, false], tag).toContain(json.ok);
      // 无残留临时文件：两个 pid 不同 ⇒ tmp 名不同；rename 失败的一方必须自己清掉（I-52）。
      expect(readdirSync(dir).filter((e) => e.endsWith('.tmp')), tag).toHaveLength(0);
    }
  }, 120_000);

  // R11 · Major-B：上面那 8 轮里 rename **总是成功**（实测 0/80 触发让位分支），于是"目标被占用时会怎样"
  // 这条判据分支从未被执行——把 `writeResultAtomic` 改回裸 `renameSync` 那 8 轮照样全绿。
  // 这一条把现场**确定性地**做出来：另一个进程持有结果文件的读句柄（正是 I-52 生产现场的成因），
  // 于是后到的 watchdog rename 必失败 ⇒ 必须①不改先赢方的内容、②删掉自己的 .tmp、③不崩、④留下让位说明。
  it('目标被别的进程读句柄占用时确定性地让位：不覆盖、不留 .tmp、不改判结果（R11 · Major-B）', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const ready = join(dir, 'holder-ready.txt');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer, { targetVersion: '0.3.0' });
    // 先赢方那份完整结果（内容可辨认，用来证明后来者没有覆盖它）。
    const first = {
      ok: true, exitCode: 0, targetVersion: '0.3.0', packageSha512: 'SHA-FIRST-WINS',
      parentGoneAt: '2026-11-07T05:00:00.000Z', spawnedAt: '2026-11-07T05:00:01.000Z',
      writtenAt: '2026-11-07T05:00:02.000Z', writer: 'watchdog',
    };
    writeFileSync(result, JSON.stringify(first, null, 2), 'utf8');

    // 占住读句柄的子进程：libuv 打开文件时不带 FILE_SHARE_DELETE ⇒ 后来的 rename 会 EPERM。
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(${JSON.stringify(result)}, 'r');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => { fs.closeSync(fd); }, 20_000);
    `], { stdio: 'ignore' });
    extraChildren.push(holder);
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(ready), '占句柄的子进程没起来').toBe(true);

    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--exit-code', '1'],
    });

    // ①不改判：watchdog 仍按安装器退出码透传（让位不等于失败，也不等于成功）。
    expect(run.code).toBe(1);
    // ②不覆盖：先赢方那份一字未动。
    expect(JSON.parse(readFileSync(result, 'utf8')).packageSha512).toBe('SHA-FIRST-WINS');
    // ③不留垃圾：自己的 .tmp 必须被清掉（这正是 I-52 修的东西）。
    expect(readdirSync(dir).filter((e) => e.endsWith('.tmp')), run.stderr).toHaveLength(0);
    // ④留下可判读的让位说明（运维据此知道结果文件属于另一个写入方）。
    expect(run.stderr).toMatch(/让位|占用|EPERM|EBUSY/i);
    holder.kill();
  }, 60_000);

  // M4（审核报告 §4）：验签后到执行之间本机换包。watchdog 必须在 spawn 前重算 sha512
  // 并与哨兵比对；不符即 abort、不 spawn、写 ok:false。这条用例改坏「不重哈希」就会红
  // （marker 会被写出来 / reason 不再是 INSTALLER_HASH_MISMATCH）。
  it('M4：安装器字节被换 ⇒ INSTALLER_HASH_MISMATCH，不 spawn、退出码 2', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer);
    // 哨兵已落盘（哈希 = 原字节），随后包被换掉一个字节。
    writeFileSync(installer, `${FAKE_INSTALLER_SOURCE}\n// tampered`, 'utf8');
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--marker', marker, '--exit-code', '0'],
    });
    expect(run.code).toBe(2);
    expect(existsSync(marker), '被换包后绝不允许执行安装器').toBe(false);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBeNull();
    expect(json.reason).toBe('INSTALLER_HASH_MISMATCH');
    expect(json.spawnedAt).toBeNull();
    expect(run.stderr).toMatch(/sha512|不符/i);
  });

  it('M4：重哈希发生在等待父进程之前（父进程仍存活也立即拒绝，不白等超时）', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const installer = writeFakeInstaller(dir);
    writeSentinelFor(sentinel, installer);
    writeFileSync(installer, `${FAKE_INSTALLER_SOURCE}\n// tampered`, 'utf8');
    const parent = spawnParent(10_000);           // 父进程长期存活
    const startedAt = Date.now();
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer, timeoutMs: 5_000,
      passthrough: ['/S'],
    });
    expect(run.code).toBe(2);
    expect(readResult(result).reason).toBe('INSTALLER_HASH_MISMATCH');
    expect(Date.now() - startedAt, '不得等到 PARENT_TIMEOUT 才失败').toBeLessThan(3_000);
    parent.child.kill();
    await parent.exited;
  });

  it('哨兵缺 packageSha512 ⇒ 无法做安装前重哈希 ⇒ SENTINEL_INVALID，不 spawn', async () => {
    const dir = makeTempDir();
    const sentinel = join(dir, 'pending-update.json');
    const result = join(dir, 'install-result.json');
    const marker = join(dir, 'fake-installer-marker.json');
    const installer = writeFakeInstaller(dir);
    writeFileSync(sentinel, JSON.stringify({ phase: 'installing', targetVersion: '0.2.0' }), 'utf8');
    const parent = spawnParent(50);
    await parent.exited;
    const run = await runWatchdog({
      parentPid: parent.pid, sentinel, result, installer,
      passthrough: ['/S', '--marker', marker],
    });
    expect(run.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
    const json = readResult(result);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('SENTINEL_INVALID');
  });
});
