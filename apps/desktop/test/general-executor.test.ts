import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isReadOnlyBashCommand,
  isReadOnlyPowerShellCommand,
  isReadOnlyShellCommand,
  riskOfCommand,
  riskOfPowerShellCommand,
  riskOfShellCommand,
  registerGeneralExecutor,
} from '../electron/main/general-executor.js';
import { ConnectorExecutor } from '@sparkii/approval';
import { AuditStore } from '@sparkii/approval';

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const shellDetectMock = vi.hoisted(() => ({
  detectGitBashPath: vi.fn(),
  resolvePowerShell: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: { spawn: childProcessMock.spawn },
  spawn: childProcessMock.spawn,
}));
vi.mock('../electron/main/shell-detect.js', () => ({
  detectGitBashPath: shellDetectMock.detectGitBashPath,
  resolvePowerShell: shellDetectMock.resolvePowerShell,
}));

function makeExecutor(workspacePath: string) {
  const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.db'));
  const executor = new ConnectorExecutor(audit);
  const created: string[] = [];
  registerGeneralExecutor(executor, {
    getWorkspace: (sid) => (sid === 's1' ? { workspacePath } : undefined),
    markWorkspaceCreated: (sid) => created.push(sid),
  });
  return { executor, created };
}

function stubSpawn(stdout = 'ok', exitCode = 0) {
  childProcessMock.spawn.mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isReadOnlyBashCommand', () => {
  it('accepts whitelisted read-only commands', () => {
    expect(isReadOnlyBashCommand('ls -la')).toBe(true);
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('rg pattern .')).toBe(true);
  });
  it('rejects metacharacters and write verbs', () => {
    expect(isReadOnlyBashCommand('cat a; rm b')).toBe(false);
    expect(isReadOnlyBashCommand('ls | grep x')).toBe(false);
    expect(isReadOnlyBashCommand('echo hi > f')).toBe(false);
    expect(isReadOnlyBashCommand('rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('git commit -m x')).toBe(false);
  });
  it('classifies destructive commands as high-risk', () => {
    expect(riskOfCommand('rm -rf /tmp/x')).toBe('high-risk');
    expect(riskOfCommand('git reset --hard')).toBe('high-risk');
    expect(riskOfCommand('echo hi')).toBe('write');
  });
});

describe('isReadOnlyPowerShellCommand', () => {
  it('accepts whitelisted read-only cmdlets and aliases', () => {
    expect(isReadOnlyPowerShellCommand('Get-ChildItem -Path .')).toBe(true);
    expect(isReadOnlyPowerShellCommand('Select-String pattern file')).toBe(true);
    expect(isReadOnlyPowerShellCommand('git status')).toBe(true);
    expect(isReadOnlyPowerShellCommand('ls -la')).toBe(true);
  });
  it('rejects metacharacters and write verbs', () => {
    expect(isReadOnlyPowerShellCommand('Get-Content a | Set-Content b')).toBe(false);
    expect(isReadOnlyPowerShellCommand('Remove-Item -Recurse x')).toBe(false);
    expect(isReadOnlyPowerShellCommand('New-Item -ItemType Directory a')).toBe(false);
    expect(isReadOnlyPowerShellCommand('Get-Content a > b')).toBe(false);
  });
  it('dispatches read-only classification by tool name', () => {
    expect(isReadOnlyShellCommand('powershell', 'Get-ChildItem')).toBe(true);
    expect(isReadOnlyShellCommand('bash', 'ls')).toBe(true);
    expect(isReadOnlyShellCommand('edit', 'ls')).toBe(false);
  });
});

describe('riskOfPowerShellCommand', () => {
  it('classifies destructive powershell commands as high-risk', () => {
    expect(riskOfPowerShellCommand('Remove-Item -Recurse -Force C:/x')).toBe('high-risk');
    expect(riskOfPowerShellCommand('git reset --hard')).toBe('high-risk');
    expect(riskOfPowerShellCommand('Get-ChildItem')).toBe('write');
  });
  it('dispatches risk by tool name', () => {
    expect(riskOfShellCommand('powershell', 'Remove-Item -Recurse x')).toBe('high-risk');
    expect(riskOfShellCommand('bash', 'rm -rf x')).toBe('high-risk');
    expect(riskOfShellCommand('powershell', 'Get-ChildItem')).toBe('write');
  });
});

describe('general executor handlers', () => {
  it('write creates the workspace folder and file', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-parent-')), 'ws-child');
    const { executor, created } = makeExecutor(ws);
    const p = {
      id: 'p1', profileId: 'general', sessionId: 's1', toolName: 'write', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { path: join(ws, 'a/b.txt'), content: 'hello' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect(out.status).toBe('executed');
    expect(existsSync(join(ws, 'a/b.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'a/b.txt'), 'utf8')).toBe('hello');
    expect(created).toEqual(['s1']);
  });

  it('bash read-only on missing workspace returns WORKSPACE_NOT_CREATED', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'not-created');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p2', profileId: 'general', sessionId: 's1', toolName: 'bash', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'ls' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect((out as any).execution?.result?.output).toContain('尚未创建');
    expect(existsSync(ws)).toBe(false);
  });

  it('powershell read-only on missing workspace returns WORKSPACE_NOT_CREATED', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'not-created');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p6', profileId: 'general', sessionId: 's1', toolName: 'powershell', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'Get-ChildItem' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect((out as any).execution?.result?.output).toContain('尚未创建');
    expect(existsSync(ws)).toBe(false);
  });

  it('executes bash through Git Bash with -c', async () => {
    shellDetectMock.detectGitBashPath.mockReturnValue('C:/Program Files/Git/bin/bash.exe');
    stubSpawn();
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'ws');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p3', profileId: 'general', sessionId: 's1', toolName: 'bash', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'mkdir -p a/b' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect(out.status).toBe('executed');
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'C:/Program Files/Git/bin/bash.exe',
      ['-c', 'mkdir -p a/b'],
      expect.objectContaining({ cwd: ws }),
    );
  });

  it('executes powershell through the resolved PowerShell shell', async () => {
    shellDetectMock.resolvePowerShell.mockReturnValue({
      exe: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
    });
    stubSpawn();
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'ws');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p4', profileId: 'general', sessionId: 's1', toolName: 'powershell', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'New-Item -ItemType Directory a' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect(out.status).toBe('executed');
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'New-Item -ItemType Directory a'],
      expect.objectContaining({ cwd: ws }),
    );
  });

  it('returns a clear error when bash is requested without Git Bash', async () => {
    shellDetectMock.detectGitBashPath.mockReturnValue(null);
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'ws');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p5', profileId: 'general', sessionId: 's1', toolName: 'bash', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'mkdir -p a/b' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect((out as any).execution?.result?.output).toContain('未检测到 Git Bash');
  });
});
