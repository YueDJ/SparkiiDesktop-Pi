import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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
  it('stores and updates the thinking level', () => {
    const s = store();
    s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a', thinkingLevel: 'high' });
    expect(s.get('pi-1')).toMatchObject({ thinkingLevel: 'high' });
    s.update('pi-1', { thinkingLevel: null });
    expect(s.get('pi-1')).toMatchObject({ thinkingLevel: null });
    s.close();
  });
  it('persists manual sort order', () => {
    const s = store();
    s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
    expect(s.get('pi-1')).toMatchObject({ sortOrder: null });
    s.update('pi-1', { sortOrder: 2 });
    expect(s.get('pi-1')).toMatchObject({ sortOrder: 2 });
    s.update('pi-1', { sortOrder: null });
    expect(s.get('pi-1')).toMatchObject({ sortOrder: null });
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
  it('migrates a legacy schema by dropping the title column', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sessions-legacy-')), 'sessions.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace_kind TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        model TEXT,
        pi_session_file TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const s = new ChatSessionStore(dbPath);
    // 迁移前 title 列为 NOT NULL，旧库首次 create 会抛错；迁移后应能正常插入。
    s.create({ id: 'pi-legacy', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/ws' });
    expect(s.get('pi-legacy')).toMatchObject({ id: 'pi-legacy', profileId: 'general' });
    s.close();

    const check = new Database(dbPath);
    const cols = check.pragma('table_info(chat_sessions)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'title')).toBe(false);
    expect(cols.some((c) => c.name === 'thinking_level')).toBe(true);
    check.close();
  });
});
