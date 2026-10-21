import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWindowsSandboxAdapter } from '../electron/main/security/windows-sandbox.js';

const desktopRoot = join(process.cwd(), 'apps', 'desktop');
const helper = join(
  desktopRoot,
  'native',
  'windows-sandbox',
  'bin',
  'SparkiiSandbox.exe',
);
const probeSource = join(
  desktopRoot,
  'native',
  'windows-sandbox',
  'bin',
  'SandboxProbe.exe',
);

interface SandboxResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sandboxSid: string;
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'sparkii-sandbox-matrix-'));
  const workspace = join(base, 'workspace');
  const siblingWorkspace = join(base, 'workspace-2');
  const scratch = join(base, 'scratch');
  const otherScratch = join(base, 'scratch-2');
  const runtime = join(base, 'runtime');
  for (const directory of [workspace, siblingWorkspace, scratch, otherScratch, runtime]) {
    mkdirSync(directory, { recursive: true });
  }
  const probe = join(runtime, 'SandboxProbe.exe');
  copyFileSync(probeSource, probe);
  return {
    base,
    workspace,
    siblingWorkspace,
    scratch,
    otherScratch,
    runtime,
    probe,
  };
}

function runSandbox(
  f: ReturnType<typeof fixture>,
  args: string,
  opts: {
    workspace?: string;
    scratch?: string;
    timeoutMs?: number;
    deny?: string[];
  } = {},
): SandboxResult {
  const encoded = Buffer.from(args, 'utf8').toString('base64');
  const result = spawnSync(helper, [
    '--profile',
    `Sparkii.Test.${randomUUID()}`,
    '--workspace',
    opts.workspace ?? f.workspace,
    '--scratch',
    opts.scratch ?? f.scratch,
    '--runtime-root',
    f.runtime,
    '--exe',
    f.probe,
    '--cwd',
    opts.workspace ?? f.workspace,
    '--command-base64',
    encoded,
    '--timeout-ms',
    String(opts.timeoutMs ?? 5_000),
    ...(opts.deny ?? []).flatMap((path) => ['--deny', path]),
  ], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = String(result.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  try {
    return JSON.parse(line) as SandboxResult;
  } catch {
    throw new Error(
      `sandbox helper returned non-JSON output: ${result.stdout}\n${result.stderr}`,
    );
  }
}

async function listen(server: Server, path: number | string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
}

describe.skipIf(process.platform !== 'win32')('Windows native sandbox spike', () => {
  it('allows workspace and scratch writes but blocks writes outside the workspace', () => {
    const f = fixture();
    const inside = join(f.workspace, 'inside.txt');
    const scratch = join(f.scratch, 'scratch.txt');
    const outside = join(f.base, 'outside.txt');
    expect(runSandbox(f, `write "${inside}"`).exitCode).toBe(0);
    expect(runSandbox(f, `write "${scratch}"`).exitCode).toBe(0);
    expect(runSandbox(f, `write "${outside}"`).exitCode).not.toBe(0);
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it('blocks reading a credential-like file outside the workspace', () => {
    const f = fixture();
    const secret = join(f.base, '.ssh', 'id_ed25519');
    mkdirSync(join(f.base, '.ssh'), { recursive: true });
    writeFileSync(secret, 'private-key');
    const result = runSandbox(f, `read "${secret}"`);
    expect(result.exitCode).not.toBe(0);
  });

  it('blocks direct TCP and localhost connections', async () => {
    const f = fixture();
    let accepted = false;
    const server = createServer((socket) => {
      accepted = true;
      socket.destroy();
    });
    await listen(server, 0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const local = runSandbox(f, `tcp 127.0.0.1 ${port}`, { timeoutMs: 1500 });
    const external = runSandbox(f, 'tcp 1.1.1.1 443', { timeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.close();
    expect(local.exitCode).not.toBe(0);
    expect(external.exitCode).not.toBe(0);
    expect(accepted).toBe(false);
  }, 15_000);

  it('blocks named-pipe IPC', async () => {
    const f = fixture();
    let connected = false;
    const pipeName = `\\\\.\\pipe\\sparkii-${randomUUID()}`;
    const server = createServer((socket) => {
      connected = true;
      socket.destroy();
    });
    await listen(server, pipeName);
    const result = runSandbox(f, `pipe "${pipeName}"`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.close();
    expect(result.exitCode).not.toBe(0);
    expect(connected).toBe(false);
  });

  it('isolates task scratch between sandbox profiles', () => {
    const f = fixture();
    const secret = join(f.scratch, 'task-one.txt');
    writeFileSync(secret, 'private');
    const result = runSandbox(f, `read "${secret}"`, {
      workspace: f.siblingWorkspace,
      scratch: f.otherScratch,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('terminates the whole child process tree on timeout', async () => {
    const f = fixture();
    const result = runSandbox(f, 'spawn-child', { timeoutMs: 1_000 });
    const childPid = Number(result.stdout.trim().split(/\r?\n/).pop());
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let alive = false;
    if (Number.isFinite(childPid) && childPid > 0) {
      try {
        process.kill(childPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('reports availability and quarantines workspace trust anchors through the adapter', async () => {
    const f = fixture();
    const adapter = createWindowsSandboxAdapter({
      helperPath: helper,
      probeExecutablePath: probeSource,
      runtimeRoot: f.runtime,
    });
    const report = await adapter.probe();
    expect(report.status, JSON.stringify(report)).toBe('partial');
    expect(report.limitations.join(' ')).toMatch(/Git Bash/);
    const anchor = join(f.workspace, '.env');
    writeFileSync(anchor, 'SECRET=original');
    const result = await adapter.run({
      taskId: 'anchor-task',
      workspaceRoot: f.workspace,
      scratchRoot: f.scratch,
      runtimeRoot: f.runtime,
      executable: f.probe,
      cwd: f.workspace,
      command: `read "${anchor}"`,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(anchor, 'utf8')).toBe('SECRET=original');
  });

  it('documents the Git Bash AppContainer limitation instead of enabling it', async () => {
    const f = fixture();
    const runtimeRoot = join(
      process.env.LOCALAPPDATA ?? '',
      'SparkiiDesktop',
      'runtime',
      'portable-git',
    );
    const bash = join(runtimeRoot, 'bin', 'bash.exe');
    if (!existsSync(bash)) return;
    const adapter = createWindowsSandboxAdapter({
      helperPath: helper,
      probeExecutablePath: probeSource,
      runtimeRoot,
    });
    const result = await adapter.run({
      taskId: 'bash-task',
      workspaceRoot: f.workspace,
      scratchRoot: f.scratch,
      runtimeRoot,
      executable: bash,
      cwd: f.workspace,
      command: 'printf bash-ok > bash-result.txt',
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(f.workspace, 'bash-result.txt'))).toBe(false);
  }, 20_000);
});
