import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { workspaceName, autoWorkspacePath, defaultWorkspacePath, ensureWorkspaceDir, randomWorkspaceToken, formatWorkspaceTimestamp, allocateAutoWorkspace, assertAgentId } from '../electron/main/workspace.js';

describe('workspace naming', () => {
  it('matches Sparkii + 4 token chars + minute timestamp', () => {
    const d = new Date('2026-08-25T17:10:00');
    const name = workspaceName(d);
    expect(name).toMatch(/^Sparkii[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{4}202608251710$/);
  });
  it('formats timestamp to the minute', () => {
    expect(formatWorkspaceTimestamp(new Date('2026-01-02T03:04:59'))).toBe('202601020304');
  });
  it('token excludes ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomWorkspaceToken()).not.toMatch(/[0O1lI]/);
    }
  });
  it('auto path joins desktop', () => {
    expect(autoWorkspacePath('C:/Users/x/Desktop', new Date('2026-08-25T17:10:00'))).toMatch(/^C:[\\/]Users[\\/]x[\\/]Desktop[\\/]Sparkii[^\\/]+202608251710$/);
  });
  it('default path is documents-scoped per agent and session', () => {
    expect(defaultWorkspacePath('C:/Users/x/Documents', 'contract-review', 's1')).toMatch(
      /^C:[\\/]Users[\\/]x[\\/]Documents[\\/]Sparkii[\\/]workspaces[\\/]contract-review[\\/]s1$/,
    );
  });
  it('ensureWorkspaceDir creates the folder lazily', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ws-test-')), 'SparkiiXyZ9202608251710');
    await ensureWorkspaceDir(dir);
    const { statSync } = await import('node:fs');
    expect(statSync(dir).isDirectory()).toBe(true);
  });
  it('allocateAutoWorkspace is Documents/Sparkii/workspaces/<agent>/<uuid> and does not mkdir', () => {
    const docs = join(tmpdir(), 'docs-home');
    const a = allocateAutoWorkspace(docs, 'contract-review');
    const b = allocateAutoWorkspace(docs, 'contract-review');
    expect(a.workspaceKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a.workspacePath).toBe(join(docs, 'Sparkii', 'workspaces', 'contract-review', a.workspaceKey));
    expect(b.workspaceKey).not.toBe(a.workspaceKey);
    expect(existsSync(a.workspacePath)).toBe(false);
  });
  it('assertAgentId rejects traversal', () => {
    expect(() => assertAgentId('../x')).toThrow();
    expect(() => assertAgentId('a/b')).toThrow();
    expect(assertAgentId('general')).toBe('general');
  });
});
