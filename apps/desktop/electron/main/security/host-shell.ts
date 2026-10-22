import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, delimiter, join } from 'node:path';
import {
  HOST_SHELL_BACKEND,
  HOST_SHELL_LIMITATIONS,
  HOST_SHELL_MAX_OUTPUT_BYTES,
  HOST_SHELL_UNAVAILABLE,
  HOST_SHELL_VERSION,
  type HostShellAdapter,
  type HostShellProbeReport,
  type HostShellRunRequest,
  type HostShellRunResult,
} from '@sparkii/approval';

/**
 * The only variables a host Shell command may see. Everything else — API keys,
 * knowledge tokens, registry tokens, the user's own PATH and profile dirs —
 * stays in Main.
 */
export const HOST_SHELL_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'ComSpec',
  'HOME',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_NOSYSTEM',
] as const;

const DEFAULT_GRACE_MS = 15_000;
const DEFAULT_SYSTEM_ROOT = 'C:/Windows';

function sub(root: string, ...parts: string[]): string {
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join('/').replace(/\\/g, '/');
}

function sanitize(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

/** Git Bash always lives at `<distribution>/bin/bash.exe`. */
export function gitRootOf(bashPath: string): string {
  return dirname(dirname(bashPath));
}

export function resolveHelperPath(opts: {
  resourcesPath?: string;
  cwd?: string;
}): string {
  const packaged = join(opts.resourcesPath ?? '', 'windows-sandbox', 'HostShellRunner.exe');
  if (existsSync(packaged)) return packaged;
  const cwd = opts.cwd ?? process.cwd();
  const candidates = [
    join(cwd, 'native', 'windows-sandbox', 'bin', 'HostShellRunner.exe'),
    join(cwd, 'apps', 'desktop', 'native', 'windows-sandbox', 'bin', 'HostShellRunner.exe'),
  ];
  return candidates.find(existsSync) ?? packaged;
}

const TOOLCHAIN_EXECUTABLES = [
  'node.exe',
  'pnpm.exe',
  'pnpm.cmd',
  'npm.exe',
  'npm.cmd',
] as const;

/**
 * Keep the host PATH scrubbed while exposing executables needed by ordinary
 * project workflows. Only directories that actually contain a known Node
 * toolchain executable are admitted; unrelated user PATH entries stay hidden.
 */
export function discoverToolchainPaths(
  parentPath: string | undefined,
  workspaceRoot?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  if (workspaceRoot) {
    const localBin = join(workspaceRoot, 'node_modules', '.bin');
    if (existsSync(localBin)) add(localBin);
  }
  for (const entry of (parentPath ?? '').split(delimiter).filter(Boolean)) {
    if (
      TOOLCHAIN_EXECUTABLES.some((name) => existsSync(join(entry, name)))
    ) {
      add(entry);
    }
  }
  return out;
}

export function buildHostShellEnvironment(
  parentEnv: Record<string, string | undefined>,
  gitRoot: string,
  scratchRoot: string,
  workspaceRoot?: string,
): Record<string, string> {
  const systemRoot = sanitize(parentEnv.SystemRoot ?? DEFAULT_SYSTEM_ROOT);
  const binPath = [
    sub(scratchRoot, 'bin'),
    ...discoverToolchainPaths(parentEnv.PATH, workspaceRoot),
    sub(gitRoot, 'bin'),
    sub(gitRoot, 'cmd'),
    `${systemRoot}/system32`,
    systemRoot,
  ].join(delimiter);
  return {
    PATH: binPath,
    SystemRoot: systemRoot,
    ComSpec: sanitize(parentEnv.ComSpec ?? `${systemRoot}/system32/cmd.exe`),
    HOME: sub(scratchRoot, 'home'),
    TEMP: sub(scratchRoot, 'tmp'),
    TMP: sub(scratchRoot, 'tmp'),
    APPDATA: sub(scratchRoot, 'appdata'),
    LOCALAPPDATA: sub(scratchRoot, 'localappdata'),
    LANG: sanitize(parentEnv.LANG ?? 'C.UTF-8'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function serializeEnvBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function readBounded(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= HOST_SHELL_MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  let cut = HOST_SHELL_MAX_OUTPUT_BYTES;
  // Never end on a split multi-byte character.
  while (cut > 0 && (text.charCodeAt(cut) & 0xc0) === 0x80) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}

interface HelperReport {
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}

export function createHostShellAdapter(opts: {
  bashPath: string;
  helperPath: string;
  platform?: NodeJS.Platform;
  parentEnv?: Record<string, string | undefined>;
  graceMs?: number;
}): HostShellAdapter {
  const platform = opts.platform ?? process.platform;
  const parentEnv = opts.parentEnv ?? process.env;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  type Child = ReturnType<typeof spawn>;
  const children = new Map<string, Set<Child>>();
  const revokedTasks = new Set<string>();

  const helperMissing = () => !existsSync(opts.helperPath) || !existsSync(opts.bashPath);

  const probe = async (): Promise<HostShellProbeReport> => {
    const available = platform === 'win32' && !helperMissing();
    return {
      backend: HOST_SHELL_BACKEND,
      status: available ? 'available' : 'unavailable',
      executionBoundary: 'host',
      version: HOST_SHELL_VERSION,
      limitations: available
        ? [...HOST_SHELL_LIMITATIONS]
        : [HOST_SHELL_UNAVAILABLE, ...HOST_SHELL_LIMITATIONS],
    };
  };

  const run = async (request: HostShellRunRequest): Promise<HostShellRunResult> => {
    const empty: HostShellRunResult = {
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      truncated: { stdout: false, stderr: false },
    };
    if (platform !== 'win32') {
      return { ...empty, stderr: HOST_SHELL_UNAVAILABLE };
    }
    if (helperMissing()) {
      return { ...empty, stderr: HOST_SHELL_UNAVAILABLE };
    }
    if (revokedTasks.has(request.taskId)) {
      return { ...empty, stderr: 'task revoked before shell start' };
    }
    const requested = Number(request.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
      ? Math.max(1_000, Math.min(300_000, Math.floor(requested)))
      : 60_000;
    const shellDir = join(request.scratchRoot, 'shell');
    await mkdir(shellDir, { recursive: true });
    for (const dir of ['home', 'tmp', 'appdata', 'localappdata', 'bin']) {
      await mkdir(join(request.scratchRoot, dir), { recursive: true }).catch(() => {});
    }
    const runId = randomUUID();
    const scriptPath = join(shellDir, `${runId}.sh`);
    const envPath = join(shellDir, `${runId}.env`);
    const outPath = join(shellDir, `${runId}.out`);
    const errPath = join(shellDir, `${runId}.err`);
    await writeFile(scriptPath, `${request.command}\n`, 'utf8');
    await writeFile(
      envPath,
      serializeEnvBlock(
        buildHostShellEnvironment(
          parentEnv,
          gitRootOf(opts.bashPath),
          request.scratchRoot,
          request.workspaceRoot,
        ),
      ),
      'utf8',
    );

    const child = spawn(opts.helperPath, [
      '--bash', opts.bashPath,
      '--script', scriptPath,
      '--cwd', request.workspaceRoot,
      '--env', envPath,
      '--out', outPath,
      '--err', errPath,
      '--timeout', String(timeoutMs),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = children.get(request.taskId) ?? new Set<Child>();
    owned.add(child);
    children.set(request.taskId, owned);
    // A revoke that landed while the scratch files were still being written.
    if (revokedTasks.has(request.taskId)) child.kill('SIGKILL');

    let report = '';
    let helperError = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (report.length < 64 * 1024) report += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (helperError.length < 8 * 1024) helperError += chunk.toString('utf8');
    });

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardTimeout = new Promise<'hard'>((resolveHard) => {
      hardTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveHard('hard');
      }, timeoutMs + graceMs);
    });

    const exit = await Promise.race([
      new Promise<'close'>((resolveClose) => {
        child.once('close', () => resolveClose('close'));
        child.once('error', () => resolveClose('close'));
      }),
      hardTimeout,
    ]);
    if (hardTimer) clearTimeout(hardTimer);
    owned.delete(child);
    if (owned.size === 0) children.delete(request.taskId);

    const readStream = async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return '';
      }
    };
    const stdout = readBounded(await readStream(outPath));
    const stderr = readBounded(await readStream(errPath));

    let parsed: HelperReport | null = null;
    if (exit === 'close') {
      try {
        parsed = JSON.parse(report) as HelperReport;
      } catch {
        parsed = null;
      }
    }
    const wasTerminated = revokedTasks.has(request.taskId);
    if (exit === 'hard' || wasTerminated) {
      return {
        exitCode: parsed?.exitCode ?? null,
        timedOut: exit === 'hard',
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      };
    }
    if (!parsed || parsed.exitCode === undefined) {
      return {
        ...empty,
        stdout: stdout.text,
        stderr: [stderr.text, parsed?.error ?? '', helperError, report]
          .filter(Boolean)
          .join('\n')
          .slice(0, HOST_SHELL_MAX_OUTPUT_BYTES),
      };
    }
    return {
      exitCode: parsed.exitCode,
      timedOut: parsed.timedOut === true,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    };
  };

  return {
    probe,
    run,
    async terminate(taskId) {
      // A tombstone closes the small race between Main's final Task check and
      // CreateProcess. Keep it because Task ids are unique for the app lifetime.
      revokedTasks.add(taskId);
      const owned = [...(children.get(taskId) ?? [])];
      for (const child of owned) {
        // Killing the helper closes its Job Object handle, and
        // KILL_ON_JOB_CLOSE takes the whole Bash tree with it.
        child.kill('SIGKILL');
      }
      await Promise.all(owned.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, graceMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      })));
    },
  };
}
