import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PlatformPermissionMode } from '@sparkii/approval';
import { PrivacyRedactions } from './privacy-redactions.js';

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
  /** User renamed this session; agent title publishes must not overwrite. Not the title string. */
  titleLockedByUser: boolean;
  /** Which permission mode this session runs under. Ask is the default. */
  permissionMode: PlatformPermissionMode;
  createdAt: number;
  updatedAt: number;
}

type Row = ChatSessionRecord;

const SELECT_COLS = 'id, profile_id AS profileId, kind, current_step AS currentStep, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, thinking_level AS thinkingLevel, pi_session_file AS piSessionFile, inputs, pinned, archived, sort_order AS sortOrder, title_locked_by_user AS titleLockedByUser, permission_mode AS permissionMode, created_at AS createdAt, updated_at AS updatedAt';

function toRecord(row: Row): ChatSessionRecord {
  return {
    ...row,
    pinned: !!row.pinned,
    archived: !!row.archived,
    titleLockedByUser: !!row.titleLockedByUser,
    permissionMode: row.permissionMode === 'auto_review' ? 'auto_review' : 'ask',
  };
}

export class ChatSessionStore {
  private db: Database.Database;
  private readonly redactions: PrivacyRedactions;
  private readonly piSessionKeyFile: string;

  constructor(dbPath: string) {
    this.piSessionKeyFile = `${dbPath}.pi-session-key`;
    this.redactions = new PrivacyRedactions(join(dirname(dbPath), `${basename(dbPath)}.privacy-redactions.json`));
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('secure_delete = ON');
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
        pi_session_file_raw BLOB,
        inputs TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order REAL,
        title_locked_by_user INTEGER NOT NULL DEFAULT 0,
        permission_mode TEXT NOT NULL DEFAULT 'ask',
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
    if (!columns.some((c) => c.name === 'title_locked_by_user')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN title_locked_by_user INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((c) => c.name === 'permission_mode')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'");
    }
    if (!columns.some((c) => c.name === 'pi_session_file_raw')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN pi_session_file_raw BLOB');
    }
    const legacy = this.db.prepare("SELECT id, pi_session_file FROM chat_sessions WHERE pi_session_file_raw IS NULL AND pi_session_file IS NOT NULL").all() as Array<{ id: string; pi_session_file: string }>;
    const backfill = this.db.prepare('UPDATE chat_sessions SET pi_session_file_raw = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const row of legacy) backfill.run(this.encryptPiSessionFile(row.pi_session_file), row.id);
    })();
  }

  private requirePrivateFile(file: string): BigIntStats {
    const info = lstatSync(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('Pi 会话路径密钥文件不安全');
    return info;
  }

  private piSessionKey(): Buffer {
    const file = this.piSessionKeyFile;
    let info: BigIntStats;
    try {
      info = this.requirePrivateFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      info = this.requirePrivateFile(file);
    }
    const key = readFileSync(file);
    if (info.size !== 32n || key.length !== 32) throw new Error('Pi 会话路径密钥损坏');
    return key;
  }

  private encryptPiSessionFile(path: string | null | undefined): Buffer | null {
    if (!path) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.piSessionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(path, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  private decryptPiSessionFile(value: unknown): string {
    if (!Buffer.isBuffer(value) || value.length < 29) throw new Error('Pi 会话原始路径损坏');
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.piSessionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }

  private redact(text: string): string {
    return this.redactions.redact(text, this.redactions.marker());
  }

  private safeRecord(row: Row): ChatSessionRecord {
    const record = toRecord(row);
    return {
      ...record,
      id: this.redact(record.id),
      profileId: this.redact(record.profileId),
      kind: record.kind === 'workflow' || record.kind === 'dashboard' ? record.kind : 'chat',
      currentStep: record.currentStep === null ? null : this.redact(record.currentStep),
      workspaceKind: record.workspaceKind === 'user' ? 'user' : 'auto',
      workspacePath: this.redact(record.workspacePath),
      model: record.model === null ? null : this.redact(record.model),
      thinkingLevel: record.thinkingLevel === null ? null : this.redact(record.thinkingLevel),
      piSessionFile: record.piSessionFile === null ? null : this.redact(record.piSessionFile),
      inputs: record.inputs === null ? null : this.redact(record.inputs),
      permissionMode: record.permissionMode,
    };
  }

  private rawRow(id: string): Row | undefined {
    return this.db.prepare(`SELECT ${SELECT_COLS} FROM chat_sessions WHERE id = ?`).get(id) as unknown as Row | undefined;
  }

  create(rec: { id: string; profileId: string; kind?: SessionKind; currentStep?: string | null; workspaceKind: WorkspaceKind; workspacePath: string; model?: string | null; thinkingLevel?: string | null; piSessionFile?: string | null; inputs?: string | null; pinned?: boolean; archived?: boolean; sortOrder?: number | null; titleLockedByUser?: boolean; permissionMode?: PlatformPermissionMode }): ChatSessionRecord {
    const now = Date.now();
    const row: Row = {
      id: rec.id, profileId: rec.profileId,
      kind: rec.kind ?? 'chat', currentStep: rec.currentStep ?? null,
      workspaceKind: rec.workspaceKind, workspacePath: rec.workspacePath,
      model: rec.model ?? null, thinkingLevel: rec.thinkingLevel ?? null, piSessionFile: rec.piSessionFile ?? null,
      inputs: rec.inputs ?? null,
      pinned: rec.pinned ?? false, archived: rec.archived ?? false, sortOrder: rec.sortOrder ?? null,
      titleLockedByUser: rec.titleLockedByUser ?? false,
      permissionMode: rec.permissionMode ?? 'ask',
      createdAt: now, updatedAt: now,
    };
    const safe = this.safeRecord(row);
    this.db.prepare(
      `INSERT INTO chat_sessions (id, profile_id, kind, current_step, workspace_kind, workspace_path, model, thinking_level, pi_session_file, pi_session_file_raw, inputs, pinned, archived, sort_order, title_locked_by_user, permission_mode, created_at, updated_at)
       VALUES (@id, @profileId, @kind, @currentStep, @workspaceKind, @workspacePath, @model, @thinkingLevel, @piSessionFile, @piSessionFileRaw, @inputs, @pinned, @archived, @sortOrder, @titleLockedByUser, @permissionMode, @createdAt, @updatedAt)`,
    ).run({ ...safe, piSessionFileRaw: this.encryptPiSessionFile(rec.piSessionFile), pinned: safe.pinned ? 1 : 0, archived: safe.archived ? 1 : 0, titleLockedByUser: safe.titleLockedByUser ? 1 : 0 });
    return safe;
  }

  list(profileId?: string): ChatSessionRecord[] {
    const sql = `SELECT ${SELECT_COLS} FROM chat_sessions`;
    if (profileId) {
      return (this.db.prepare(`${sql} WHERE profile_id = ? ORDER BY updated_at DESC`).all(profileId) as unknown as Row[]).map((row) => this.safeRecord(row));
    }
    return (this.db.prepare(`${sql} ORDER BY updated_at DESC`).all() as unknown as Row[]).map((row) => this.safeRecord(row));
  }

  get(id: string): ChatSessionRecord | undefined {
    const row = this.rawRow(id) ?? this.rawRow(this.redact(id));
    return row ? this.safeRecord(row) : undefined;
  }

  update(id: string, patch: Partial<Pick<ChatSessionRecord, 'kind' | 'currentStep' | 'model' | 'thinkingLevel' | 'workspaceKind' | 'workspacePath' | 'piSessionFile' | 'inputs' | 'pinned' | 'archived' | 'sortOrder' | 'titleLockedByUser' | 'permissionMode'>>): ChatSessionRecord | undefined {
    const cur = this.rawRow(id) ?? this.rawRow(this.redact(id));
    if (!cur) return undefined;
    const next = this.safeRecord({ ...cur, ...patch, updatedAt: Date.now() });
    this.db.prepare(
      `UPDATE chat_sessions SET kind=@kind, current_step=@currentStep, workspace_kind=@workspaceKind, workspace_path=@workspacePath, model=@model, thinking_level=@thinkingLevel, pi_session_file=@piSessionFile, pi_session_file_raw=CASE WHEN @hasPiSessionFile THEN @piSessionFileRaw ELSE pi_session_file_raw END, inputs=@inputs, pinned=@pinned, archived=@archived, sort_order=@sortOrder, title_locked_by_user=@titleLockedByUser, permission_mode=@permissionMode, updated_at=@updatedAt WHERE id=@rawId`,
    ).run({ ...next, rawId: cur.id, hasPiSessionFile: Object.prototype.hasOwnProperty.call(patch, 'piSessionFile') ? 1 : 0, piSessionFileRaw: this.encryptPiSessionFile(patch.piSessionFile), pinned: next.pinned ? 1 : 0, archived: next.archived ? 1 : 0, titleLockedByUser: next.titleLockedByUser ? 1 : 0 });
    return next;
  }

  /**
   * P10 — relocate a workspace root by updating EVERY session that references
   * it in ONE transaction (F8: multiple sessions may share a workspacePath).
   * `db` is private, so this batch method must live inside the store. If any
   * statement fails, better-sqlite3 rolls the whole batch back — no partial
   * update, so the caller can safely keep the source copy on failure.
   *
   * @returns the list of session ids whose record was updated.
   */
  updateWorkspacePathInTransaction(
    oldPath: string,
    newPath: string,
    workspaceKind: WorkspaceKind,
  ): string[] {
    const ids = (this.db.prepare(
      `SELECT id FROM chat_sessions WHERE workspace_path = ?`,
    ).all(oldPath) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return ids;
    const now = Date.now();
    const safeNewPath = this.redact(newPath);
    const safeWorkspaceKind = workspaceKind === 'user' ? 'user' : 'auto';
    const update = this.db.prepare(
      `UPDATE chat_sessions SET workspace_path = @newPath, workspace_kind = @kind, updated_at = @now WHERE id = @id`,
    );
    this.db.transaction(() => {
      for (const id of ids) {
        update.run({ id, newPath: safeNewPath, kind: safeWorkspaceKind, now });
      }
    })();
    return ids.map((id) => this.redact(id));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(this.redact(id));
  }

  rawPiSessionFile(id: string, privacyCleanup = false): string | undefined {
    const row = this.rawRow(id) ?? this.rawRow(this.redact(id));
    if (!row) return undefined;
    if (row.piSessionFile === null) return undefined;
    const raw = this.db.prepare('SELECT pi_session_file_raw FROM chat_sessions WHERE id = ?')
      .get(row.id) as { pi_session_file_raw: Buffer | null } | undefined;
    let path: string;
    if (raw?.pi_session_file_raw) {
      path = this.decryptPiSessionFile(raw.pi_session_file_raw);
    } else {
      if (this.redactions.contains(row.piSessionFile)) throw new Error('Pi 会话原始路径缺失，隐私删除已阻断');
      path = row.piSessionFile;
    }
    if (!privacyCleanup && this.redactions.contains(path)) throw new Error('Pi 会话原始路径已被隐私删除阻断');
    return path;
  }

  registerRedactions(texts: string[]): void {
    if (texts.some((text) => text.length > 0)) this.redactions.register(texts);
  }

  privacyDelete(id: string, texts: string[] = []): void {
    this.registerRedactions(texts);
    const safeId = this.redact(id);
    const surviving = (this.db.prepare(`SELECT ${SELECT_COLS} FROM chat_sessions`).all() as unknown as Row[])
      .filter((row) => row.id !== id && row.id !== safeId)
      .map((row) => ({ rawId: row.id, row: this.safeRecord(row) }));
    const unique = new Map<string, { rawId: string; row: ChatSessionRecord }>();
    for (const item of surviving) {
      const existing = unique.get(item.row.id);
      if (existing && existing.rawId !== item.rawId) throw new Error('会话隐私脱敏主键冲突');
      unique.set(item.row.id, item);
    }
    const rawFiles = new Map((this.db.prepare('SELECT id, pi_session_file_raw FROM chat_sessions').all() as Array<{ id: string; pi_session_file_raw: Buffer | null }>)
      .map((row) => [row.id, row.pi_session_file_raw]));
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chat_sessions').run();
      const insert = this.db.prepare(
        `INSERT INTO chat_sessions (id, profile_id, kind, current_step, workspace_kind, workspace_path, model, thinking_level, pi_session_file, pi_session_file_raw, inputs, pinned, archived, sort_order, title_locked_by_user, permission_mode, created_at, updated_at)
         VALUES (@id, @profileId, @kind, @currentStep, @workspaceKind, @workspacePath, @model, @thinkingLevel, @piSessionFile, @piSessionFileRaw, @inputs, @pinned, @archived, @sortOrder, @titleLockedByUser, @permissionMode, @createdAt, @updatedAt)`,
      );
      for (const { rawId, row } of unique.values()) {
        insert.run({ ...row, piSessionFileRaw: rawFiles.get(rawId) ?? null, pinned: row.pinned ? 1 : 0, archived: row.archived ? 1 : 0, titleLockedByUser: row.titleLockedByUser ? 1 : 0 });
      }
    })();
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((result) => result.busy !== 0)) throw new Error('会话数据库 WAL 清理被占用');
    this.db.exec('VACUUM');
    const finalCheckpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (finalCheckpoint.some((result) => result.busy !== 0)) throw new Error('会话数据库最终 WAL 清理被占用');
  }

  close(): void {
    this.db.close();
  }
}
