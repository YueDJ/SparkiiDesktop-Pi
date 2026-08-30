import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

  constructor(dbPath: string, opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
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

  private prune(): void {
    this.db.prepare('DELETE FROM error_events WHERE created_at < ?').run(this.now() - RETENTION_MS);
  }

  append(rec: { id: string; message: string; source: string; createdAt: number }): ErrorEvent {
    this.prune();
    this.db.prepare(
      'INSERT INTO error_events (id, message, source, created_at, read) VALUES (@id, @message, @source, @createdAt, 0)',
    ).run(rec);
    return { ...rec, read: false };
  }

  list(limit = 500): ErrorEvent[] {
    this.prune();
    const rows = this.db.prepare(
      'SELECT id, message, source, created_at, read FROM error_events ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as unknown as Row[];
    return rows.map(toEvent);
  }

  clearOne(id: string): void {
    this.db.prepare('DELETE FROM error_events WHERE id = ?').run(id);
  }

  clear(): void {
    this.db.prepare('DELETE FROM error_events').run();
  }

  markAllRead(): void {
    this.db.prepare('UPDATE error_events SET read = 1').run();
  }

  close(): void {
    this.db.close();
  }
}
