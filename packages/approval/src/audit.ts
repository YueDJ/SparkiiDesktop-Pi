import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface AuditEvent {
  id: string; ts: number; actor: string; action: string;
  resource?: string; payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired' | 'allowed' | 'auto-approved' | 'failed' | string;
  modelRoute?: string;
  sessionId?: string;
  taskId?: string;
  actionId?: string;
  ruleId?: string;
  capability?: string;
  payloadHash?: string;
  platform?: string;
  sandboxVersion?: string;
}

interface AuditRow {
  id: string; ts: number; actor: string; action: string;
  resource: string | null; payload_summary: string | null;
  decision: string | null; model_route: string | null; session_id: string | null;
  task_id: string | null; action_id: string | null; rule_id: string | null;
  capability: string | null; payload_hash: string | null;
  platform: string | null; sandbox_version: string | null;
}

function mapRow(r: AuditRow): AuditEvent {
  return {
    id: r.id, ts: r.ts, actor: r.actor, action: r.action,
    resource: r.resource ?? undefined, payloadSummary: r.payload_summary ?? undefined,
    decision: r.decision as AuditEvent['decision'] | undefined, modelRoute: r.model_route ?? undefined,
    sessionId: r.session_id ?? undefined,
    taskId: r.task_id ?? undefined,
    actionId: r.action_id ?? undefined,
    ruleId: r.rule_id ?? undefined,
    capability: r.capability ?? undefined,
    payloadHash: r.payload_hash ?? undefined,
    platform: r.platform ?? undefined,
    sandboxVersion: r.sandbox_version ?? undefined,
  };
}

export class AuditStore {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT,
      resource TEXT, payload_summary TEXT, decision TEXT, model_route TEXT,
      session_id TEXT, task_id TEXT, action_id TEXT, rule_id TEXT,
      capability TEXT, payload_hash TEXT, platform TEXT, sandbox_version TEXT)`);
    const cols = this.db.prepare("PRAGMA table_info(audit)").all() as Array<{ name: string }>;
    for (const column of [
      'session_id', 'task_id', 'action_id', 'rule_id', 'capability',
      'payload_hash', 'platform', 'sandbox_version',
    ]) {
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE audit ADD COLUMN ${column} TEXT`);
      }
    }
  }
  async append(ev: Omit<AuditEvent, 'id' | 'ts'>): Promise<AuditEvent> {
    const full: AuditEvent = { ...ev, id: randomUUID(), ts: Date.now() };
    this.db.prepare(`INSERT INTO audit (
      id, ts, actor, action, resource, payload_summary, decision, model_route,
      session_id, task_id, action_id, rule_id, capability, payload_hash,
      platform, sandbox_version
    ) VALUES (
      @id, @ts, @actor, @action, @resource, @payloadSummary, @decision, @modelRoute,
      @sessionId, @taskId, @actionId, @ruleId, @capability, @payloadHash,
      @platform, @sandboxVersion
    )`).run({
      ...full, resource: full.resource ?? null, payloadSummary: full.payloadSummary ?? null,
      decision: full.decision ?? null, modelRoute: full.modelRoute ?? null, sessionId: full.sessionId ?? null,
      taskId: full.taskId ?? null, actionId: full.actionId ?? null, ruleId: full.ruleId ?? null,
      capability: full.capability ?? null, payloadHash: full.payloadHash ?? null,
      platform: full.platform ?? null, sandboxVersion: full.sandboxVersion ?? null,
    });
    return full;
  }
  async query(filter: {
    actor?: string; action?: string; resource?: string; sessionId?: string;
    taskId?: string; actionId?: string; capability?: string;
  }): Promise<AuditEvent[]> {
    const rows = this.db.prepare(`SELECT * FROM audit WHERE
      (@actor IS NULL OR actor = @actor) AND
      (@action IS NULL OR action = @action) AND
      (@resource IS NULL OR resource = @resource) AND
      (@sessionId IS NULL OR session_id = @sessionId) AND
      (@taskId IS NULL OR task_id = @taskId) AND
      (@actionId IS NULL OR action_id = @actionId) AND
      (@capability IS NULL OR capability = @capability)
      ORDER BY ts DESC`).all({
      actor: filter.actor ?? null, action: filter.action ?? null,
      resource: filter.resource ?? null, sessionId: filter.sessionId ?? null,
      taskId: filter.taskId ?? null, actionId: filter.actionId ?? null,
      capability: filter.capability ?? null,
    }) as AuditRow[];
    return rows.map(mapRow);
  }
  async exportJsonl(): Promise<string> {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY ts ASC').all() as AuditRow[];
    return rows.map((r) => JSON.stringify(mapRow(r))).join('\n');
  }
  close(): void { this.db.close(); }
}
