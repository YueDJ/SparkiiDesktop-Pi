import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type ShellChoice = 'bash' | 'powershell' | null;

export interface ShellResolution {
  shell: ShellChoice;
  degraded: boolean;
  bashPath: string | null;
}

const GIT_BASH_CANDIDATES = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/usr/bin/bash.exe',
];

let bashPathCache: string | null | undefined;

export function detectGitBashPath(): string | null {
  if (bashPathCache !== undefined) return bashPathCache;
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      bashPathCache = candidate;
      return bashPathCache;
    }
  }
  try {
    const out = execFileSync('where', ['bash'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => /bash(\.exe)?$/i.test(s) && existsSync(s));
    bashPathCache = line ?? null;
  } catch {
    bashPathCache = null;
  }
  return bashPathCache;
}

let powerShellCache: { exe: string; args: string[] } | undefined;

export function resolvePowerShell(): { exe: string; args: string[] } {
  if (powerShellCache) return powerShellCache;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
  try {
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
    powerShellCache = { exe: 'pwsh', args };
  } catch {
    powerShellCache = { exe: 'powershell.exe', args };
  }
  return powerShellCache;
}

/**
 * 依据 profile 工具列表、环境探测与持久化记录，决定会话使用 bash 还是 powershell。
 * `bashPath` 仅在测试或显式指定时传入；生产环境省略以触发自动探测。
 */
export function resolveShellChoice(
  profileTools: string[],
  persistedShell?: 'bash' | 'powershell' | null,
  bashPath?: string | null,
): ShellResolution {
  if (!profileTools.includes('bash')) {
    return { shell: null, degraded: false, bashPath: null };
  }
  const detected = bashPath === undefined ? detectGitBashPath() : bashPath;
  const hasBash = detected !== null;

  if (persistedShell === 'powershell') {
    return { shell: 'powershell', degraded: false, bashPath: detected };
  }
  if (persistedShell === 'bash') {
    return hasBash
      ? { shell: 'bash', degraded: false, bashPath: detected }
      : { shell: 'powershell', degraded: true, bashPath: null };
  }
  // 新会话 / 无持久化记录：有 Git Bash 走 bash，否则走 powershell（不算降级）
  return hasBash
    ? { shell: 'bash', degraded: false, bashPath: detected }
    : { shell: 'powershell', degraded: false, bashPath: null };
}
