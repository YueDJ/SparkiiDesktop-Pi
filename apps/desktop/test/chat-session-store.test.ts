import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';

function store() {
  return new ChatSessionStore(join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.db'));
}

describe('ChatSessionStore', () => {
  it('creates and reads a session', () => {
    const s = store();
    const rec = s.create({ id: 's1', profileId: 'general', title: '会话 08-25 17:10', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710' });
    expect(s.get('s1')).toMatchObject({ id: 's1', title: '会话 08-25 17:10', model: null, piSessionFile: null });
    expect(rec.createdAt).toBeGreaterThan(0);
    s.close();
  });
  it('updates model and workspace', () => {
    const s = store();
    s.create({ id: 's1', profileId: 'general', title: 't', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.update('s1', { model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    expect(s.get('s1')).toMatchObject({ model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    s.close();
  });
  it('lists by profile and deletes', () => {
    const s = store();
    s.create({ id: 'a', profileId: 'general', title: 't', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.create({ id: 'b', profileId: 'contract', title: 't', workspaceKind: 'auto', workspacePath: 'C:/b' });
    expect(s.list('general').map((r) => r.id)).toEqual(['a']);
    s.delete('a');
    expect(s.get('a')).toBeUndefined();
    s.close();
  });
});
