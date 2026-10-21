import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PlatformSecurityReport,
  SandboxRunRequest,
  SandboxRunResult,
  WorkspaceSandboxAdapter,
} from '@sparkii/approval';

const TRUST_ANCHOR_NAMES = new Set([
  '.env',
  '.git-credentials',
  '.mcp.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bashrc',
  '.profile',
  '.zshrc',
  '.codex',
  '.cursor',
  '.claude',
  'id_rsa',
  'id_ed25519',
]);

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  '.git/objects',
  '.git/refs',
  '.git/logs',
]);

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isTrustAnchorName(name: string): boolean {
  return TRUST_ANCHOR_NAMES.has(name)
    || name.startsWith('.env.')
    || name === 'credentials';
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function scanTrustAnchors(workspaceRoot: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        found.push(full);
        continue;
      }
      if (entry.isDirectory() && isTrustAnchorName(entry.name)) {
        found.push(full);
        continue;
      }
      if (rel === '.git/hooks' || rel === '.git/config') {
        found.push(full);
        continue;
      }
      if (entry.isFile() && isTrustAnchorName(entry.name)) {
        found.push(full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name) || SKIPPED_DIRECTORIES.has(rel)) {
        continue;
      }
      if (rel.startsWith('.git/') && rel !== '.git/hooks') continue;
      visit(full);
    }
  };
  visit(workspaceRoot);
  return [...new Set(found.map((path) => resolve(path)))];
}

export interface TrustAnchorIsolation {
  restore(): Promise<string[]>;
  emptyHooksPath: string;
}

export async function assertNoHardLinkAliases(
  workspaceRoot: string,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await lstat(full, { bigint: true });
      if (stats.nlink > 1n) {
        throw new Error(`workspace contains a hardlink alias: ${full}`);
      }
    }
  };
  await visit(workspaceRoot);
}

async function movePath(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, force: false });
    await rm(source, { recursive: true, force: false });
  }
}

export async function prepareTrustAnchorIsolation(
  workspaceRoot: string,
  scratchRoot: string,
): Promise<TrustAnchorIsolation> {
  const backupRoot = join(
    scratchRoot,
    '.sparkii-anchor-backup',
    randomUUID(),
  );
  const emptyHooksPath = join(scratchRoot, 'empty-hooks');
  await mkdir(backupRoot, { recursive: true });
  await mkdir(emptyHooksPath, { recursive: true });

  const moved: Array<{ source: string; backup: string }> = [];
  const copied: Array<{ source: string; backup: string }> = [];
  for (const source of scanTrustAnchors(workspaceRoot)) {
    const rel = relative(workspaceRoot, source);
    const backup = join(backupRoot, rel);
    await mkdir(dirname(backup), { recursive: true });
    if (pathKey(rel) === pathKey('.git/config')) {
      if (await exists(source)) {
        const bytes = await readFile(source);
        await writeFile(backup, bytes, { flag: 'wx' });
        copied.push({ source, backup });
      }
      continue;
    }
    if (await exists(source)) {
      await movePath(source, backup);
      moved.push({ source, backup });
    }
  }

  return {
    emptyHooksPath,
    async restore() {
      const changes: string[] = [];
      for (const { source, backup } of moved) {
        if (await exists(source)) {
          await rm(source, { recursive: true, force: true });
          changes.push(`discarded sandbox replacement: ${source}`);
        }
        await mkdir(dirname(source), { recursive: true });
        await movePath(backup, source);
      }
      for (const { source, backup } of copied) {
        const original = await readFile(backup);
        const current = await exists(source) ? await readFile(source) : null;
        if (!current || !current.equals(original)) {
          await mkdir(dirname(source), { recursive: true });
          const temp = `${source}.sparkii-restore-${randomUUID()}`;
          await writeFile(temp, original, { flag: 'wx' });
          await rename(temp, source);
          changes.push(`restored trust anchor: ${source}`);
        }
      }
      await rm(backupRoot, { recursive: true, force: true });
      return changes;
    },
  };
}

interface HelperResult extends SandboxRunResult {
  ok: boolean;
  error?: string;
  win32Error?: number;
}

function helperOutputPath(base: string, resourcesPath?: string): string {
  if (base) return base;
  const packaged = resourcesPath
    ? join(resourcesPath, 'windows-sandbox', 'SparkiiSandbox.exe')
    : '';
  if (packaged && existsSync(packaged)) return packaged;
  return join(
    process.cwd(),
    'apps',
    'desktop',
    'native',
    'windows-sandbox',
    'bin',
    'SparkiiSandbox.exe',
  );
}

function probeOutputPath(base: string, resourcesPath?: string): string {
  if (base) return base;
  const packaged = resourcesPath
    ? join(resourcesPath, 'windows-sandbox', 'SandboxProbe.exe')
    : '';
  if (packaged && existsSync(packaged)) return packaged;
  return join(
    process.cwd(),
    'apps',
    'desktop',
    'native',
    'windows-sandbox',
    'bin',
    'SandboxProbe.exe',
  );
}

function runHelper(
  helperPath: string,
  args: string[],
): Promise<HelperResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split(/\r?\n/).pop() ?? '';
      try {
        resolvePromise(JSON.parse(line) as HelperResult);
      } catch {
        reject(new Error(`sandbox helper returned invalid output: ${stdout}\n${stderr}`));
      }
    });
  });
}

function baseArgs(
  request: SandboxRunRequest,
  extra: string[] = [],
): string[] {
  return [
    '--profile',
    `Sparkii.${createHash('sha256')
      .update(`${request.taskId}:${randomUUID()}`)
      .digest('hex')
      .slice(0, 24)}`,
    '--workspace',
    request.workspaceRoot,
    '--scratch',
    request.scratchRoot,
    '--runtime-root',
    request.runtimeRoot,
    '--exe',
    request.executable,
    '--cwd',
    request.cwd,
    '--command-base64',
    Buffer.from(request.command, 'utf8').toString('base64'),
    '--timeout-ms',
    String(request.timeoutMs),
    ...extra,
  ];
}

export interface WindowsSandboxAdapterOptions {
  helperPath?: string;
  probeExecutablePath?: string;
  runtimeRoot: string;
  resourcesPath?: string;
}

export function createWindowsSandboxAdapter(
  options: WindowsSandboxAdapterOptions,
): WorkspaceSandboxAdapter {
  const helperPath = helperOutputPath(options.helperPath ?? '', options.resourcesPath);
  const probeExecutablePath = probeOutputPath(
    options.probeExecutablePath ?? '',
    options.resourcesPath,
  );
  const active = new Map<string, ChildProcess>();
  let reportPromise: Promise<PlatformSecurityReport> | undefined;

  const probe = (): Promise<PlatformSecurityReport> => {
    if (reportPromise) return reportPromise;
    reportPromise = (async () => {
      if (process.platform !== 'win32' || !existsSync(helperPath)
          || !existsSync(probeExecutablePath)) {
        return {
          platform: 'windows',
          status: 'unavailable',
          version: 'appcontainer-v1',
          capabilities: {
            filesystemBoundary: false,
            privateScratch: false,
            networkIsolation: false,
            ipcIsolation: false,
            processTreeControl: false,
            environmentScrubbing: false,
          },
          limitations: ['Windows sandbox helper or probe executable is missing'],
        };
      }
      const root = join(tmpdir(), `sparkii-sandbox-probe-${randomUUID()}`);
      const workspace = join(root, 'workspace');
      const scratch = join(root, 'scratch');
      await mkdir(workspace, { recursive: true });
      await mkdir(scratch, { recursive: true });
      try {
        const result = await runHelper(helperPath, baseArgs({
          taskId: `probe-${randomUUID()}`,
          workspaceRoot: workspace,
          scratchRoot: scratch,
          runtimeRoot: dirname(probeExecutablePath),
          executable: probeExecutablePath,
          cwd: workspace,
          command: 'exit',
          timeoutMs: 5_000,
        }));
        if (!result.ok || result.exitCode !== 0) {
          throw new Error(result.error ?? `probe exited ${result.exitCode}`);
        }
        return {
          platform: 'windows',
          status: 'partial',
          version: 'appcontainer-v1',
          capabilities: {
            filesystemBoundary: true,
            privateScratch: true,
            networkIsolation: true,
            ipcIsolation: true,
            processTreeControl: true,
            environmentScrubbing: true,
          },
          limitations: [
            'Git Bash/MSYS2 cannot start under AppContainer on this Windows build; Standard bash remains disabled',
          ],
        };
      } catch (error) {
        return {
          platform: 'windows',
          status: 'unavailable',
          version: 'appcontainer-v1',
          capabilities: {
            filesystemBoundary: false,
            privateScratch: false,
            networkIsolation: false,
            ipcIsolation: false,
            processTreeControl: false,
            environmentScrubbing: false,
          },
          limitations: [error instanceof Error ? error.message : String(error)],
          failure: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return reportPromise;
  };

  return {
    probe,
    async run(request) {
      const status = await probe();
      if (status.status === 'unavailable') {
        throw new Error(`sandbox unavailable: ${status.limitations.join('; ')}`);
      }
      await mkdir(request.workspaceRoot, { recursive: true });
      await mkdir(request.scratchRoot, { recursive: true });
      const isolation = await prepareTrustAnchorIsolation(
        request.workspaceRoot,
        request.scratchRoot,
      );
      let restored = false;
      try {
        await assertNoHardLinkAliases(request.workspaceRoot);
        const helperArgs = baseArgs(request, [
          '--env', `GIT_CONFIG_COUNT=3`,
          '--env', `GIT_CONFIG_KEY_0=core.hooksPath`,
          '--env', `GIT_CONFIG_VALUE_0=${isolation.emptyHooksPath}`,
          '--env', `GIT_CONFIG_KEY_1=core.fsmonitor`,
          '--env', `GIT_CONFIG_VALUE_1=false`,
          '--env', `GIT_CONFIG_KEY_2=credential.helper`,
          '--env', `GIT_CONFIG_VALUE_2=`,
          '--env', `GIT_CONFIG_NOSYSTEM=1`,
          '--env', `GIT_TERMINAL_PROMPT=0`,
        ]);
        const child = spawn(helperPath, helperArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        active.set(request.taskId, child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        const helper = await new Promise<HelperResult>((resolvePromise, reject) => {
          child.on('error', reject);
          child.on('close', () => {
            const line = stdout.trim().split(/\r?\n/).pop() ?? '';
            try {
              resolvePromise(JSON.parse(line) as HelperResult);
            } catch {
              reject(new Error(`sandbox helper returned invalid output: ${stdout}\n${stderr}`));
            }
          });
        });
        if (!helper.ok) throw new Error(helper.error ?? 'sandbox helper failed');
        const restoreChanges = await isolation.restore();
        restored = true;
        return {
          exitCode: helper.exitCode,
          timedOut: helper.timedOut,
          stdout: helper.stdout,
          stderr: helper.stderr,
          sandboxSid: helper.sandboxSid,
          trustAnchorChanges: restoreChanges,
        };
      } finally {
        active.delete(request.taskId);
        if (!restored) await isolation.restore().catch(() => []);
      }
    },
    async terminate(taskId) {
      const child = active.get(taskId);
      if (!child) return;
      child.kill();
      await new Promise<void>((resolvePromise) => {
        if (child.exitCode !== null) {
          resolvePromise();
          return;
        }
        child.once('close', () => resolvePromise());
        setTimeout(resolvePromise, 5_000);
      });
      active.delete(taskId);
    },
  };
}
