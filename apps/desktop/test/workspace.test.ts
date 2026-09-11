import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { defaultWorkspacePath, ensureWorkspaceDir, allocateAutoWorkspace, assertAgentId } from '../electron/main/workspace.js';

describe('workspace naming', () => {
  it('default path is documents-scoped per agent and session', () => {
    expect(defaultWorkspacePath('C:/Users/x/Documents', 'contract-review', 's1')).toMatch(
      /^C:[\\/]Users[\\/]x[\\/]Documents[\\/]Sparkii[\\/]workspaces[\\/]contract-review[\\/]s1$/,
    );
  });
  it('ensureWorkspaceDir creates the folder lazily', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ws-test-')), 'Sparkii', 'workspaces', 'general', 'ws-1');
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
