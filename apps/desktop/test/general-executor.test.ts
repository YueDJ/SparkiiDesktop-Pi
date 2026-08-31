import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isReadOnlyBashCommand,
  registerGeneralExecutor,
  riskOfCommand,
} from '../electron/main/general-executor.js';
import { AuditStore, ConnectorExecutor } from '@sparkii/approval';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
const runtimeLayoutMock = vi.hoisted(() => ({ resolveRuntimePaths: vi.fn() }));

vi.mock('node:child_process', () => ({
  default: { spawn: childProcessMock.spawn },
  spawn: childProcessMock.spawn,
}));
vi.mock('../electron/main/runtime-layout.js', () => ({
  resolveRuntimePaths: runtimeLayoutMock.resolveRuntimePaths,
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

function mockRuntime(bashPath: string) {
  const portableGitDir = join(bashPath, '..', '..');
  runtimeLayoutMock.resolveRuntimePaths.mockReturnValue({
    root: join(portableGitDir, '..'),
    portableGitDir,
    bashPath,
    gitCmdDir: join(portableGitDir, 'cmd'),
    gitPath: join(portableGitDir, 'cmd', 'git.exe'),
  });
}

function tempBash(): string {
  const root = mkdtempSync(join(tmpdir(), 'rt-'));
  const bashPath = join(root, 'portable-git', 'bin', 'bash.exe');
  mkdirSync(join(root, 'portable-git', 'bin'), { recursive: true });
  writeFileSync(bashPath, 'x');
  mockRuntime(bashPath);
  return bashPath;
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

  it('executes bash through the bundled Git Bash with -c', async () => {
    const bashPath = tempBash();
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
      bashPath,
      ['-c', 'mkdir -p a/b'],
      expect.objectContaining({ cwd: ws }),
    );
  });

  it('returns a clear error when the bundled bash is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-missing-'));
    mockRuntime(join(root, 'portable-git', 'bin', 'bash.exe'));
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'ws');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p5', profileId: 'general', sessionId: 's1', toolName: 'bash', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'mkdir -p a/b' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect((out as any).execution?.result?.output).toContain('未找到自带 Git Bash');
  });
});
