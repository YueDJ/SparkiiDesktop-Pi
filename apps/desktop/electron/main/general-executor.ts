import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectorExecutor } from '@sparkii/approval';
import type { ToolHandler } from '@sparkii/connectors';
import { isPathInside } from '@sparkii/agent-host';
import { detectGitBashPath, resolvePowerShell } from './shell-detect.js';

export const WORKSPACE_NOT_CREATED = '工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。';

const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'cut', 'sort', 'uniq', 'diff',
  'pwd', 'echo', 'which', 'type', 'env', 'date', 'printf', 'true', 'false',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git stash list',
];
const SHELL_META = /[;&|><`\n]|\$\s*\(/;

const POWERSHELL_READ_ONLY_PREFIXES = [
  // 纯读 cmdlet
  'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-Location', 'Get-Process', 'Get-Service',
  'Get-Date', 'Get-History', 'Get-Command', 'Get-Member', 'Get-Alias', 'Get-Module',
  'Get-Variable', 'Get-PSDrive', 'Get-PSProvider', 'Get-Random', 'Get-Host',
  'Test-Path', 'Resolve-Path',
  'Select-String', 'Select-Object', 'Sort-Object', 'Where-Object', 'Measure-Object',
  'Compare-Object', 'Group-Object', 'Format-List', 'Format-Table', 'Format-Wide', 'Out-String',
  'ConvertFrom-Json', 'ConvertFrom-Csv', 'ConvertTo-Json', 'ConvertTo-Csv',
  // 只读别名
  'ls', 'dir', 'cat', 'gc', 'gci', 'gl', 'pwd', 'type', 'echo', 'sort', 'diff', 'select',
  'where', 'sls', 'gcm', 'gm', 'measure', 'group', 'ft', 'fl', 'ps', 'gps',
  'Write-Output', 'Write-Host', 'date',
  // git 只读（与 shell 无关）
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git stash list',
];

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return false;
  return READ_ONLY_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p} `));
}

const HIGH_RISK = /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|\bmkfs\b|\bformat\s+/i;
const HIGH_RISK_POWERSHELL = /\bRemove-Item\b[^|]*(?:-Recurse|-Force)\b|\bgit\s+reset\s+--hard\b|\bClear-Content\b|\bClear-Disk\b|\bFormat-Volume\b|\bClear-RecycleBin\b/i;

export function riskOfCommand(command: string): 'write' | 'high-risk' {
  return HIGH_RISK.test(command) ? 'high-risk' : 'write';
}

export function isReadOnlyPowerShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return false;
  return POWERSHELL_READ_ONLY_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p} `));
}

export function isReadOnlyShellCommand(toolName: string, command: string): boolean {
  if (toolName === 'powershell') return isReadOnlyPowerShellCommand(command);
  if (toolName === 'bash') return isReadOnlyBashCommand(command);
  return false;
}

export function riskOfPowerShellCommand(command: string): 'write' | 'high-risk' {
  return HIGH_RISK_POWERSHELL.test(command) ? 'high-risk' : 'write';
}

export function riskOfShellCommand(toolName: string, command: string): 'write' | 'high-risk' {
  if (toolName === 'powershell') return riskOfPowerShellCommand(command);
  if (toolName === 'bash') return riskOfCommand(command);
  return 'write';
}

export interface GeneralExecutorOptions {
  getWorkspace(sessionId: string): { workspacePath: string } | undefined;
  markWorkspaceCreated(sessionId: string): void;
}

type ShellSpec = { kind: 'bash' } | { kind: 'shell'; exe: string; args: string[] };

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  shell: ShellSpec,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    if (shell.kind === 'bash') {
      const bashPath = detectGitBashPath();
      if (!bashPath) {
        resolve({ exitCode: null, output: '未检测到 Git Bash，无法执行 bash 命令。', timedOut: false });
        return;
      }
      child = spawn(bashPath, ['-c', command], { cwd, windowsHide: true });
    } else {
      child = spawn(shell.exe, [...shell.args, command], { cwd, windowsHide: true });
    }
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: output.slice(0, 128 * 1024), timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: output.slice(0, 128 * 1024), timedOut });
    });
  });
}

export function registerGeneralExecutor(executor: ConnectorExecutor, opts: GeneralExecutorOptions): void {
  const bash: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const command = String(args.command ?? '');
    const readOnly = isReadOnlyBashCommand(command);
    if (readOnly && !existsSync(ws.workspacePath)) {
      return { ok: true, data: { exitCode: 0, output: WORKSPACE_NOT_CREATED } };
    }
    if (!readOnly) {
      await mkdir(ws.workspacePath, { recursive: true });
      opts.markWorkspaceCreated(ctx.sessionId);
    }
    const timeoutMs = Number(args.timeout ?? 60_000);
    const result = await runShell(command, ws.workspacePath, timeoutMs, { kind: 'bash' });
    return { ok: true, data: result };
  };

  const powershell: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const command = String(args.command ?? '');
    const readOnly = isReadOnlyPowerShellCommand(command);
    if (readOnly && !existsSync(ws.workspacePath)) {
      return { ok: true, data: { exitCode: 0, output: WORKSPACE_NOT_CREATED } };
    }
    if (!readOnly) {
      await mkdir(ws.workspacePath, { recursive: true });
      opts.markWorkspaceCreated(ctx.sessionId);
    }
    const timeoutMs = Number(args.timeout ?? 60_000);
    const ps = resolvePowerShell();
    const result = await runShell(command, ws.workspacePath, timeoutMs, { kind: 'shell', exe: ps.exe, args: ps.args });
    return { ok: true, data: result };
  };

  const edit: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const path = String(args.path);
    if (!isPathInside(ws.workspacePath, path)) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'path outside workspace' } };
    await mkdir(ws.workspacePath, { recursive: true });
    opts.markWorkspaceCreated(ctx.sessionId);
    await writeFile(path, String(args.content ?? ''), 'utf8');
    return { ok: true, data: { path } };
  };

  const write: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const path = String(args.path);
    if (!isPathInside(ws.workspacePath, path)) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'path outside workspace' } };
    await mkdir(ws.workspacePath, { recursive: true });
    opts.markWorkspaceCreated(ctx.sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(args.content ?? ''), 'utf8');
    return { ok: true, data: { path } };
  };

  executor.register('bash', bash);
  executor.register('powershell', powershell);
  executor.register('edit', edit);
  executor.register('write', write);
}
