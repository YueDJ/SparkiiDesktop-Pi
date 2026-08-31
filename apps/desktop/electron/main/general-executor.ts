import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectorExecutor } from '@sparkii/approval';
import type { ToolHandler } from '@sparkii/connectors';
import { isPathInside } from '@sparkii/agent-host';
import { resolveRuntimePaths } from './runtime-layout.js';

export const WORKSPACE_NOT_CREATED = '工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。';

const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'cut', 'sort', 'uniq', 'diff',
  'pwd', 'echo', 'which', 'type', 'env', 'date', 'printf', 'true', 'false',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git stash list',
];
const SHELL_META = /[;&|><`\n]|\$\s*\(/;

const HIGH_RISK = /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|\bmkfs\b|\bformat\s+/i;

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return false;
  return READ_ONLY_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p} `));
}

export function riskOfCommand(command: string): 'write' | 'high-risk' {
  return HIGH_RISK.test(command) ? 'high-risk' : 'write';
}

export interface GeneralExecutorOptions {
  getWorkspace(sessionId: string): { workspacePath: string } | undefined;
  markWorkspaceCreated(sessionId: string): void;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const bashPath = resolveRuntimePaths().bashPath;
    if (!existsSync(bashPath)) {
      resolve({ exitCode: null, output: '未找到自带 Git Bash（运行时未就绪），无法执行 bash 命令。', timedOut: false });
      return;
    }
    const child = spawn(bashPath, ['-c', command], { cwd, windowsHide: true });
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
    const result = await runShell(command, ws.workspacePath, timeoutMs);
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
  executor.register('edit', edit);
  executor.register('write', write);
}
