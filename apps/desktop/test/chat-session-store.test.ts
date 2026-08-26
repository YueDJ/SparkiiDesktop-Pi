import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';

function store() {
  return new ChatSessionStore(join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.db'));
}

describe('ChatSessionStore', () => {
  it('creates and reads a session keyed by pi session id', () => {
    const s = store();
    const rec = s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710' });
    expect(s.get('pi-1')).toMatchObject({ id: 'pi-1', model: null, piSessionFile: null });
    expect(s.get('pi-1')).not.toHaveProperty('title');
    expect(rec.createdAt).toBeGreaterThan(0);
    s.close();
  });
  it('stores the piSessionFile overlay', () => {
    const s = store();
    s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a', piSessionFile: 'C:/pi/sessions/pi-1.jsonl' });
    expect(s.get('pi-1')).toMatchObject({ piSessionFile: 'C:/pi/sessions/pi-1.jsonl' });
    s.close();
  });
  it('updates model and workspace', () => {
    const s = store();
    s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.update('pi-1', { model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    expect(s.get('pi-1')).toMatchObject({ model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    s.close();
  });
  it('lists by profile and deletes', () => {
    const s = store();
    s.create({ id: 'pi-a', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.create({ id: 'pi-b', profileId: 'contract-review', workspaceKind: 'auto', workspacePath: 'C:/b' });
    expect(s.list('general').map((r) => r.id)).toEqual(['pi-a']);
    s.delete('pi-a');
    expect(s.get('pi-a')).toBeUndefined();
    s.close();
  });
});
