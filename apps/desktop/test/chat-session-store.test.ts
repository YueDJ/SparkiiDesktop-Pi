import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';
import { ErrorStore } from '../electron/main/error-store.js';

function store() {
  return new ChatSessionStore(join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.db'));
}

describe('ChatSessionStore', () => {
  it('R8 final review fences future session creates, updates and relocation after privacy cleanup and restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-privacy-'));
    const path = join(dir, 'sessions.db');
    const secret = 'R8_SESSION_FUTURE_SECRET_92D';
    const s = new ChatSessionStore(path);
    s.create({ id: 'remove', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/remove' });
    s.create({ id: `keep-${secret}`, profileId: 'general', workspaceKind: 'user', workspacePath: `C:/${secret}`, inputs: JSON.stringify({ text: secret }) });
    s.privacyDelete('remove', [secret]);
    s.create({ id: `future-${secret}`, profileId: 'general', workspaceKind: 'user', workspacePath: `C:/${secret}`, inputs: secret });
    s.create({ id: 'relocate', profileId: 'general', workspaceKind: 'user', workspacePath: 'C:/clean' });
    s.update(`keep-${secret}`, { model: secret, piSessionFile: `C:/${secret}.jsonl` });
    s.updateWorkspacePathInTransaction('C:/clean', `D:/${secret}`, 'user');
    expect(JSON.stringify(s.list())).not.toContain(secret);
    s.close();

    const reopened = new ChatSessionStore(path);
    reopened.create({ id: `restart-${secret}`, profileId: 'general', workspaceKind: 'auto', workspacePath: `C:/${secret}`, inputs: secret });
    expect(JSON.stringify(reopened.list())).not.toContain(secret);
    reopened.close();
    expect(readFileSync(join(dir, 'sessions.db.privacy-redactions.json'), 'utf8')).not.toContain(secret);
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
  });

  it('R8 final review fences raw Pi carrier reads after privacy registration except explicit cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-carrier-fence-'));
    const path = join(dir, 'sessions.db');
    const secret = 'R8_SESSION_CARRIER_FENCE_71C';
    const carrier = join(dir, `${secret}.jsonl`);
    const s = new ChatSessionStore(path);
    s.create({ id: 'remove', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/remove' });
    s.create({ id: 'keep', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/keep', piSessionFile: carrier });
    s.privacyDelete('remove', [secret]);

    expect(s.get('keep')?.piSessionFile).not.toContain(secret);
    expect(() => s.rawPiSessionFile('keep')).toThrow(/隐私删除.*阻断/);
    expect(s.rawPiSessionFile('keep', true)).toBe(carrier);
    s.close();

    const reopened = new ChatSessionStore(path);
    expect(() => reopened.rawPiSessionFile('keep')).toThrow(/隐私删除.*阻断/);
    expect(reopened.rawPiSessionFile('keep', true)).toBe(carrier);
    reopened.close();
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
  });

  it('R8 final review backfills legacy Pi carriers before privacy registration and preserves surviving encrypted mappings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-legacy-carrier-'));
    const path = join(dir, 'sessions.db');
    const secret = 'R8_LEGACY_CARRIER_SECRET_71C';
    const raw = new Database(path);
    raw.exec(`CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', current_step TEXT,
      workspace_kind TEXT NOT NULL, workspace_path TEXT NOT NULL, model TEXT, thinking_level TEXT,
      pi_session_file TEXT, inputs TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      sort_order REAL, title_locked_by_user INTEGER NOT NULL DEFAULT 0, permission_mode TEXT NOT NULL DEFAULT 'ask',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    raw.prepare(`INSERT INTO chat_sessions (id, profile_id, workspace_kind, workspace_path, pi_session_file, created_at, updated_at)
      VALUES ('remove', 'general', 'auto', 'C:/remove', ?, 1, 1),
             ('keep', 'general', 'auto', 'C:/keep', ?, 1, 1)`)
      .run(join(dir, `${secret}.jsonl`), 'C:/clean.jsonl');
    raw.close();

    const store = new ChatSessionStore(path);
    expect(store.rawPiSessionFile('remove', true)).toBe(join(dir, `${secret}.jsonl`));
    store.privacyDelete('remove', [secret]);
    expect(store.rawPiSessionFile('keep', true)).toBe('C:/clean.jsonl');
    store.close();

    const reopened = new ChatSessionStore(path);
    expect(reopened.get('remove')).toBeUndefined();
    expect(reopened.rawPiSessionFile('keep', true)).toBe('C:/clean.jsonl');
    reopened.close();
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
  });

  it('R8 final review refuses privacy primary-key collisions without dropping surviving chat or error rows', () => {
    const secret = 'R8_ID_COLLISION_SECRET_71C';
    const dir = mkdtempSync(join(tmpdir(), 'sessions-collision-'));
    const path = join(dir, 'sessions.db');
    const store = new ChatSessionStore(path);
    store.create({ id: 'remove', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/remove' });
    const first = `keep-${secret}-a`;
    const second = `keep-${secret}-b`;
    store.create({ id: first, profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
    store.create({ id: second, profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/b' });
    expect(() => store.privacyDelete('remove', [first, second])).toThrow('主键冲突');
    expect(store.list()).toHaveLength(3);
    const raw = new Database(path);
    expect((raw.prepare('SELECT id FROM chat_sessions ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)).toEqual(['remove', first, second].sort());
    raw.close();
    store.close();

    const errors = new ErrorStore(join(dir, 'errors.db'));
    errors.append({ id: first, message: 'first', source: 'test', createdAt: 1 });
    errors.append({ id: second, message: 'second', source: 'test', createdAt: 2 });
    expect(() => errors.redactTexts([first, second])).toThrow('主键冲突');
    expect(errors.list()).toHaveLength(2);
    errors.close();
  });

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
    expect(cols.some((c) => c.name === 'title_locked_by_user')).toBe(true);
    check.close();
  });

  it('persists titleLockedByUser and defaults to false', () => {
    const s = store();
    s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
    expect(s.get('pi-1')?.titleLockedByUser).toBe(false);
    s.update('pi-1', { titleLockedByUser: true });
    expect(s.get('pi-1')?.titleLockedByUser).toBe(true);
    s.close();
  });

  it('migrates title_locked_by_user onto an existing db', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sessions-lock-')), 'sessions.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        current_step TEXT,
        workspace_kind TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        model TEXT,
        thinking_level TEXT,
        pi_session_file TEXT,
        inputs TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(`INSERT INTO chat_sessions (id, profile_id, kind, workspace_kind, workspace_path, pinned, archived, created_at, updated_at)
      VALUES ('old', 'general', 'chat', 'auto', 'C:/a', 0, 0, 1, 1)`).run();
    raw.close();
    const s = new ChatSessionStore(dbPath);
    expect(s.get('old')?.titleLockedByUser).toBe(false);
    s.update('old', { titleLockedByUser: true });
    expect(s.get('old')?.titleLockedByUser).toBe(true);
    s.close();
  });

  it('persists permission mode with Ask as legacy default', () => {
    const s = store();
    s.create({
      id: 's1',
      profileId: 'general',
      workspaceKind: 'auto',
      workspacePath: 'C:/ws',
      permissionMode: 'auto_review',
    });
    expect(s.get('s1')?.permissionMode).toBe('auto_review');
    s.update('s1', { permissionMode: 'ask' });
    expect(s.get('s1')?.permissionMode).toBe('ask');
    s.create({ id: 's2', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/ws' });
    expect(s.get('s2')?.permissionMode).toBe('ask');
    expect(s.list()).toHaveLength(2);
    s.close();
  });

  it('adds the permission column to a database written before it existed', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sessions-legacy-')), 'sessions.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        current_step TEXT,
        workspace_kind TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        model TEXT,
        thinking_level TEXT,
        pi_session_file TEXT,
        inputs TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order REAL,
        title_locked_by_user INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(`INSERT INTO chat_sessions (id, profile_id, kind, workspace_kind, workspace_path, pinned, archived, created_at, updated_at)
      VALUES ('old', 'general', 'chat', 'auto', 'C:/a', 0, 0, 1, 1)`).run();
    raw.close();

    const s = new ChatSessionStore(dbPath);
    expect(s.get('old')?.permissionMode).toBe('ask');
    s.update('old', { permissionMode: 'auto_review' });
    expect(s.get('old')?.permissionMode).toBe('auto_review');
    s.close();
  });
});
