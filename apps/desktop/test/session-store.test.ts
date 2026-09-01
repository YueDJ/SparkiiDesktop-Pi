import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in test teardown
    }
  }
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-kind-'));
  dirs.push(dir);
  return new ChatSessionStore(join(dir, 'sessions.db'));
}

describe('ChatSessionStore workflow fields', () => {
  it('persists session kind and current step', () => {
    const s = store();
    s.create({
      id: 's1',
      profileId: 'contract-review',
      workspaceKind: 'auto',
      workspacePath: 'C:/tmp',
      kind: 'workflow',
      currentStep: 'compare',
    });
    const rec = s.get('s1');
    expect(rec?.kind).toBe('workflow');
    expect(rec?.currentStep).toBe('compare');
    s.close();
  });
});
