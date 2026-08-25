import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkspaceKind = 'auto' | 'user';

export interface ChatSessionRecord {
  id: string;
  profileId: string;
  title: string;
  workspaceKind: WorkspaceKind;
  workspacePath: string;
  model: string | null;
  piSessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = ChatSessionRecord;

export class ChatSessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
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
  }

  create(rec: { id: string; profileId: string; title: string; workspaceKind: WorkspaceKind; workspacePath: string; model?: string | null }): ChatSessionRecord {
    const now = Date.now();
    const row: Row = {
      id: rec.id, profileId: rec.profileId, title: rec.title,
      workspaceKind: rec.workspaceKind, workspacePath: rec.workspacePath,
      model: rec.model ?? null, piSessionFile: null, createdAt: now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO chat_sessions (id, profile_id, title, workspace_kind, workspace_path, model, pi_session_file, created_at, updated_at)
       VALUES (@id, @profileId, @title, @workspaceKind, @workspacePath, @model, @piSessionFile, @createdAt, @updatedAt)`,
    ).run(row);
    return row;
  }

  list(profileId?: string): ChatSessionRecord[] {
    const sql = 'SELECT id, profile_id AS profileId, title, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, pi_session_file AS piSessionFile, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions';
    if (profileId) {
      return this.db.prepare(`${sql} WHERE profile_id = ? ORDER BY updated_at DESC`).all(profileId) as unknown as Row[];
    }
    return this.db.prepare(`${sql} ORDER BY updated_at DESC`).all() as unknown as Row[];
  }

  get(id: string): ChatSessionRecord | undefined {
    return this.db.prepare(
      'SELECT id, profile_id AS profileId, title, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, pi_session_file AS piSessionFile, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions WHERE id = ?',
    ).get(id) as unknown as Row | undefined;
  }

  update(id: string, patch: Partial<Pick<ChatSessionRecord, 'title' | 'model' | 'workspaceKind' | 'workspacePath' | 'piSessionFile'>>): ChatSessionRecord | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: Row = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.prepare(
      `UPDATE chat_sessions SET title=@title, workspace_kind=@workspaceKind, workspace_path=@workspacePath, model=@model, pi_session_file=@piSessionFile, updated_at=@updatedAt WHERE id=@id`,
    ).run(next);
    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
