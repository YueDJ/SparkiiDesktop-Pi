import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface AuditEvent {
  id: string; ts: number; actor: string; action: string;
  resource?: string; payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired';
  modelRoute?: string;
}

export class AuditStore {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT,
      resource TEXT, payload_summary TEXT, decision TEXT, model_route TEXT)`);
  }
  async append(ev: Omit<AuditEvent, 'id' | 'ts'>): Promise<AuditEvent> {
    const full: AuditEvent = { ...ev, id: randomUUID(), ts: Date.now() };
    this.db.prepare(`INSERT INTO audit (id, ts, actor, action, resource, payload_summary, decision, model_route)
      VALUES (@id, @ts, @actor, @action, @resource, @payloadSummary, @decision, @modelRoute)`).run({
      ...full, resource: full.resource ?? null, payloadSummary: full.payloadSummary ?? null,
      decision: full.decision ?? null, modelRoute: full.modelRoute ?? null,
    });
    return full;
  }
  async query(filter: { actor?: string; action?: string; resource?: string }): Promise<AuditEvent[]> {
    const rows = this.db.prepare(`SELECT * FROM audit WHERE
      (@actor IS NULL OR actor = @actor) AND
      (@action IS NULL OR action = @action) AND
      (@resource IS NULL OR resource = @resource) ORDER BY ts DESC`).all({ actor: filter.actor ?? null, action: filter.action ?? null, resource: filter.resource ?? null });
    return rows as AuditEvent[];
  }
  async exportJsonl(): Promise<string> {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY ts ASC').all() as AuditEvent[];
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
  close(): void { this.db.close(); }
}
