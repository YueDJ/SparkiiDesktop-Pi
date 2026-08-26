import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isReadOnlyBashCommand, riskOfCommand, registerGeneralExecutor } from '../electron/main/general-executor.js';
import { ConnectorExecutor } from '@sparkii/approval';
import { AuditStore } from '@sparkii/approval';

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
});
