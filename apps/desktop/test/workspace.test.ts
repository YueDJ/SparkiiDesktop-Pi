import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { workspaceName, autoWorkspacePath, ensureWorkspaceDir, randomWorkspaceToken, formatWorkspaceTimestamp } from '../electron/main/workspace.js';

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
  it('ensureWorkspaceDir creates the folder lazily', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ws-test-')), 'SparkiiXyZ9202608251710');
    await ensureWorkspaceDir(dir);
    const { statSync } = await import('node:fs');
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
