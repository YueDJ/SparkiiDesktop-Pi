import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostShellAdapter, resolveHelperPath } from '../electron/main/security/host-shell.js';
import { resolveRuntimePaths } from '../electron/main/runtime-layout.js';

/**
 * These cases drive the real native helper through the real Portable Git Bash.
 * They are the only proof that the Job Object path works on Windows, so the
 * discovery rules below are explicit and a skip is logged loudly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packagedHelper = resolveHelperPath({ resourcesPath: process.resourcesPath });
const devHelper = resolve(here, '../native/windows-sandbox/bin/HostShellRunner.exe');
const helper = process.env.SPARKII_HOST_SHELL_HELPER
  ?? (existsSync(packagedHelper) ? packagedHelper : devHelper);
const bashPath = process.env.SPARKII_TEST_BASH ?? resolveRuntimePaths().bashPath;
const enabled = process.platform === 'win32' && existsSync(helper) && existsSync(bashPath);

if (!enabled) {
  console.warn(
    `[host-shell-integration] SKIPPED helper=${helper} helperExists=${existsSync(helper)} `
    + `bash=${bashPath} bashExists=${existsSync(bashPath)}`,
  );
}

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/^\/([a-zA-Z])\//i, (_m, drive: string) => `${drive.toUpperCase()}:/`);
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const roots: string[] = [];

function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'host-shell-run-'));
  const workspaceRoot = join(base, 'workspace');
  const scratchRoot = join(base, 'scratch');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  roots.push(base);
  return { workspaceRoot, scratchRoot };
}

async function waitForFile(dir: string, timeoutMs = 20_000, fileName = 'ready'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (readdirSync(dir).some((name) => name.startsWith(fileName))) return true;
    } catch {
      // Directory may not exist yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

describe.skipIf(!enabled)('host shell integration on Windows', () => {
  let adapter: ReturnType<typeof createHostShellAdapter>;

  beforeAll(async () => {
    adapter = createHostShellAdapter({ bashPath, helperPath: helper, platform: 'win32' });
    const report = await adapter.probe();
    expect(report).toMatchObject({ status: 'available', backend: 'host-git-bash' });
  });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    for (const root of roots) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('runs a command from the workspace cwd', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const result = await adapter.run({
      taskId: 'task-run',
      workspaceRoot,
      scratchRoot,
      command: 'printf \'host-ok\\n\'; pwd',
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('host-ok');
    expect(normalizePath(lines[1] ?? '')).toBe(normalizePath(workspaceRoot));
  });

  it('exposes discovered Node and pnpm toolchain commands', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const result = await adapter.run({
      taskId: 'task-toolchain',
      workspaceRoot,
      scratchRoot,
      command: 'node --version; pnpm --version; git --version',
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\./m);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/m);
    expect(result.stdout).toMatch(/^git version/m);
  });

  it('keeps stdout and stderr separate', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const result = await adapter.run({
      taskId: 'task-streams',
      workspaceRoot,
      scratchRoot,
      command: 'printf out-part; printf err-part 1>&2',
      timeoutMs: 30_000,
    });
    expect(result.stdout).toBe('out-part');
    expect(result.stderr).toBe('err-part');
  });

  it('truncates an oversized stdout stream', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const result = await adapter.run({
      taskId: 'task-truncate',
      workspaceRoot,
      scratchRoot,
      command: 'for i in $(seq 1 20000); do printf "%s" "0123456789abcdef"; done',
      timeoutMs: 30_000,
    });
    expect(result.stdout.length).toBeGreaterThan(128 * 1024 - 4);
    expect(result.stdout.length).toBeLessThanOrEqual(128 * 1024);
  });

  it('propagates a non-zero exit code', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const result = await adapter.run({
      taskId: 'task-exit',
      workspaceRoot,
      scratchRoot,
      command: 'printf before; exit 3',
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('before');
  });

  it('starts from a scrubbed environment without inherited secrets', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    process.env.SPARKII_PROBE_SECRET = 'leak-me';
    const result = await adapter.run({
      taskId: 'task-env',
      workspaceRoot,
      scratchRoot,
      command: 'printf "[%s][%s][%s]" "$SPARKII_PROBE_SECRET" "$HOME" "$GIT_CONFIG_NOSYSTEM"',
      timeoutMs: 30_000,
    });
    delete process.env.SPARKII_PROBE_SECRET;
    expect(result.stdout).not.toContain('leak-me');
    expect(result.stdout).toMatch(/^\[\]\[\/[^\]]*\]\[1\]$/);
  });

  it('kills the whole process tree on timeout', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const started = Date.now();
    const result = await adapter.run({
      taskId: 'task-timeout',
      workspaceRoot,
      scratchRoot,
      command: 'sleep 30',
      timeoutMs: 1_500,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  });

  it('kills a backgrounded grandchild when the timeout fires', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const log = join(workspaceRoot, 'grandchild.log');
    const result = await adapter.run({
      taskId: 'task-tree',
      workspaceRoot,
      scratchRoot,
      // The loop runs in a subshell (a grandchild of Bash). If only the direct
      // child were killed, it would keep appending after the timeout.
      command: '( for i in $(seq 1 40); do printf x >> grandchild.log; sleep 0.5; done ) & sleep 30',
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    const { readFileSync, statSync } = await import('node:fs');
    const first = existsSync(log) ? statSync(log).size : 0;
    expect(first).toBeGreaterThan(0);
    await new Promise((done) => setTimeout(done, 2_500));
    expect(statSync(log).size).toBe(first);
    expect(readFileSync(log, 'utf8')).toBe('x'.repeat(first));
  });

  it('terminates a running task on request', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const running = adapter.run({
      taskId: 'task-cancel',
      workspaceRoot,
      scratchRoot,
      command: 'touch ready.flag; sleep 30',
      timeoutMs: 60_000,
    });
    expect(await waitForFile(workspaceRoot)).toBe(true);
    await adapter.terminate('task-cancel');
    const result = await running;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('terminates every concurrent command owned by the same task', async () => {
    const { workspaceRoot, scratchRoot } = scratch();
    const first = adapter.run({
      taskId: 'task-multi-cancel',
      workspaceRoot,
      scratchRoot,
      command: 'touch ready-one.flag; sleep 30',
      timeoutMs: 60_000,
    });
    const second = adapter.run({
      taskId: 'task-multi-cancel',
      workspaceRoot,
      scratchRoot,
      command: 'touch ready-two.flag; sleep 30',
      timeoutMs: 60_000,
    });
    expect(await waitForFile(workspaceRoot, 20_000, 'ready-one.flag')).toBe(true);
    expect(await waitForFile(workspaceRoot, 20_000, 'ready-two.flag')).toBe(true);
    await adapter.terminate('task-multi-cancel');
    const [a, b] = await Promise.all([first, second]);
    expect(a.exitCode).not.toBe(0);
    expect(b.exitCode).not.toBe(0);
  }, 40_000);
});
