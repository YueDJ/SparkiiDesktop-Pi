import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkspaceKind = 'auto' | 'user';
export type SessionKind = 'chat' | 'workflow' | 'dashboard';

export interface ChatSessionRecord {
  id: string;
  profileId: string;
  kind: SessionKind;
  currentStep: string | null;
  workspaceKind: WorkspaceKind;
  workspacePath: string;
  model: string | null;
  thinkingLevel: string | null;
  piSessionFile: string | null;
  /** JSON 编码的会话输入文件（如工作流输入的合同文档）。 */
  inputs: string | null;
  pinned: boolean;
  archived: boolean;
  sortOrder: number | null;
  createdAt: number;
  updatedAt: number;
}

type Row = ChatSessionRecord;

function toRecord(row: Row): ChatSessionRecord {
  return { ...row, pinned: !!row.pinned, archived: !!row.archived };
}

export class ChatSessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
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
    // 迁移旧 schema：老版本有 `title NOT NULL` 列，去掉它，避免旧库首次 INSERT 报错。
    const columns = this.db.pragma('table_info(chat_sessions)') as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'title')) {
      this.db.exec('ALTER TABLE chat_sessions DROP COLUMN title');
    }
    if (columns.some((c) => c.name === 'shell')) {
      this.db.exec('ALTER TABLE chat_sessions DROP COLUMN shell');
    }
    if (!columns.some((c) => c.name === 'thinking_level')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN thinking_level TEXT');
    }
    if (!columns.some((c) => c.name === 'pinned')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((c) => c.name === 'archived')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((c) => c.name === 'sort_order')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN sort_order REAL');
    }
    if (!columns.some((c) => c.name === 'kind')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    }
    if (!columns.some((c) => c.name === 'current_step')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN current_step TEXT');
    }
    if (!columns.some((c) => c.name === 'inputs')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN inputs TEXT');
    }
  }

  create(rec: { id: string; profileId: string; kind?: SessionKind; currentStep?: string | null; workspaceKind: WorkspaceKind; workspacePath: string; model?: string | null; thinkingLevel?: string | null; piSessionFile?: string | null; inputs?: string | null; pinned?: boolean; archived?: boolean; sortOrder?: number | null }): ChatSessionRecord {
    const now = Date.now();
    const row: Row = {
      id: rec.id, profileId: rec.profileId,
      kind: rec.kind ?? 'chat', currentStep: rec.currentStep ?? null,
      workspaceKind: rec.workspaceKind, workspacePath: rec.workspacePath,
      model: rec.model ?? null, thinkingLevel: rec.thinkingLevel ?? null, piSessionFile: rec.piSessionFile ?? null,
      inputs: rec.inputs ?? null,
      pinned: rec.pinned ?? false, archived: rec.archived ?? false, sortOrder: rec.sortOrder ?? null, createdAt: now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO chat_sessions (id, profile_id, kind, current_step, workspace_kind, workspace_path, model, thinking_level, pi_session_file, inputs, pinned, archived, sort_order, created_at, updated_at)
       VALUES (@id, @profileId, @kind, @currentStep, @workspaceKind, @workspacePath, @model, @thinkingLevel, @piSessionFile, @inputs, @pinned, @archived, @sortOrder, @createdAt, @updatedAt)`,
    ).run({ ...row, pinned: row.pinned ? 1 : 0, archived: row.archived ? 1 : 0 });
    return row;
  }

  list(profileId?: string): ChatSessionRecord[] {
    const sql = 'SELECT id, profile_id AS profileId, kind, current_step AS currentStep, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, thinking_level AS thinkingLevel, pi_session_file AS piSessionFile, inputs, pinned, archived, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions';
    if (profileId) {
      return (this.db.prepare(`${sql} WHERE profile_id = ? ORDER BY updated_at DESC`).all(profileId) as unknown as Row[]).map(toRecord);
    }
    return (this.db.prepare(`${sql} ORDER BY updated_at DESC`).all() as unknown as Row[]).map(toRecord);
  }

  get(id: string): ChatSessionRecord | undefined {
    const row = this.db.prepare(
      'SELECT id, profile_id AS profileId, kind, current_step AS currentStep, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, thinking_level AS thinkingLevel, pi_session_file AS piSessionFile, inputs, pinned, archived, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions WHERE id = ?',
    ).get(id) as unknown as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<ChatSessionRecord, 'kind' | 'currentStep' | 'model' | 'thinkingLevel' | 'workspaceKind' | 'workspacePath' | 'piSessionFile' | 'inputs' | 'pinned' | 'archived' | 'sortOrder'>>): ChatSessionRecord | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: Row = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.prepare(
      `UPDATE chat_sessions SET kind=@kind, current_step=@currentStep, workspace_kind=@workspaceKind, workspace_path=@workspacePath, model=@model, thinking_level=@thinkingLevel, pi_session_file=@piSessionFile, inputs=@inputs, pinned=@pinned, archived=@archived, sort_order=@sortOrder, updated_at=@updatedAt WHERE id=@id`,
    ).run({ ...next, pinned: next.pinned ? 1 : 0, archived: next.archived ? 1 : 0 });
    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
