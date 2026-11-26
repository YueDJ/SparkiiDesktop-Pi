import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PrivacyRedactions } from './privacy-redactions.js';

export interface ErrorEvent {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}

type Row = { id: string; message: string; source: string; created_at: number; read: number };

function toEvent(row: Row): ErrorEvent {
  return { id: row.id, message: row.message, source: row.source, createdAt: row.created_at, read: !!row.read };
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ErrorStore {
  private db: Database.Database;
  private now: () => number;
  private readonly redactions: PrivacyRedactions;

  constructor(dbPath: string, opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    this.redactions = new PrivacyRedactions(join(dirname(dbPath), `${basename(dbPath)}.privacy-redactions.json`));
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS error_events (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at)');
    this.prune();
  }

  private redact(text: string): string {
    return this.redactions.redact(text, this.redactions.marker());
  }

  private prune(): void {
    this.db.prepare('DELETE FROM error_events WHERE created_at < ?').run(this.now() - RETENTION_MS);
  }

  /** 同一 id 只留一行：主进程与窗口报同一次故障时不能出现双行。 */
  append(rec: { id: string; message: string; source: string; createdAt: number }): ErrorEvent {
    this.prune();
    const safe = {
      id: this.redact(rec.id),
      message: this.redact(rec.message),
      source: this.redact(rec.source),
      createdAt: rec.createdAt,
    };
    this.db.prepare(
      'INSERT OR IGNORE INTO error_events (id, message, source, created_at, read) VALUES (@id, @message, @source, @createdAt, 0)',
    ).run(safe);
    return { ...safe, read: false };
  }

  list(limit = 500): ErrorEvent[] {
    this.prune();
    const rows = this.db.prepare(
      'SELECT id, message, source, created_at, read FROM error_events ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as unknown as Row[];
    return rows.map((row) => toEvent({
      ...row,
      id: this.redact(row.id),
      message: this.redact(row.message),
      source: this.redact(row.source),
    }));
  }

  clearOne(id: string): void {
    this.db.prepare('DELETE FROM error_events WHERE id = ?').run(this.redact(id));
  }

  clear(): void {
    this.db.prepare('DELETE FROM error_events').run();
  }

  markAllRead(): void {
    this.db.prepare('UPDATE error_events SET read = 1').run();
  }

  redactTexts(texts: string[]): void {
    if (!texts.some((text) => text.length > 0)) return;
    this.redactions.register(texts);
    const rows = this.db.prepare('SELECT id, message, source, created_at, read FROM error_events').all() as unknown as Row[];
    const safeRows = rows.map((row) => ({
      ...row,
      id: this.redact(row.id),
      message: this.redact(row.message),
      source: this.redact(row.source),
    }));
    const changed = safeRows.some((row, index) => row.id !== rows[index].id
      || row.message !== rows[index].message || row.source !== rows[index].source);
    if (new Set(safeRows.map((row) => row.id)).size !== safeRows.length) throw new Error('诊断隐私脱敏主键冲突');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM error_events').run();
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO error_events (id, message, source, created_at, read) VALUES (@id, @message, @source, @created_at, @read)',
      );
      for (const row of safeRows) insert.run(row);
    })();
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((result) => result.busy !== 0)) throw new Error('诊断数据库 WAL 清理被占用');
    if (!changed && this.db.pragma('freelist_count', { simple: true }) === 0) return;
    this.db.exec('VACUUM');
    const finalCheckpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (finalCheckpoint.some((result) => result.busy !== 0)) throw new Error('诊断数据库最终 WAL 清理被占用');
  }

  close(): void {
    this.db.close();
  }
}
