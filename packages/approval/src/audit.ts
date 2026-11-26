import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

interface RedactionPattern {
  hash: string;
  length: number;
}

const TEXT_COLUMNS = [
  'actor', 'action', 'resource', 'payload_summary', 'decision', 'model_route',
  'session_id', 'task_id', 'action_id', 'rule_id', 'capability', 'payload_hash',
  'platform', 'sandbox_version',
] as const;

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Keep Audit/Gate variants aligned with PrivacyRedactions, including each physical-line fragment. */
function redactionVariants(value: string): string[] {
  const variants = [value, JSON.stringify(value).slice(1, -1)];
  if (/[\r\n]/.test(value)) {
    for (const fragment of value.split(/\r\n|\r|\n/).filter(Boolean)) {
      variants.push(fragment, JSON.stringify(fragment).slice(1, -1));
    }
  }
  return variants;
}

function findMatches(text: string, patterns: RedactionPattern[]): Array<{ start: number; length: number }> {
  const byLength = new Map<number, Set<string>>();
  for (const pattern of patterns) {
    const hashes = byLength.get(pattern.length) ?? new Set<string>();
    hashes.add(pattern.hash);
    byLength.set(pattern.length, hashes);
  }
  const matches: Array<{ start: number; length: number }> = [];
  for (const [length, hashes] of byLength) {
    for (let start = 0; start + length <= text.length; start += 1) {
      if (hashes.has(fingerprint(text.slice(start, start + length)))) matches.push({ start, length });
    }
  }
  return matches.sort((a, b) => b.length - a.length || a.start - b.start);
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
  private readonly registryFile: string;
  private registryPatterns: RedactionPattern[] = [];
  private registryCharacters = new Set<string>();
  private blocked = false;
  constructor(file: string) {
    this.registryFile = `${file}.privacy-redactions.json`;
    this.loadRegistry();
    this.db = new Database(file);
    this.db.pragma('secure_delete = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT,
      resource TEXT, payload_summary TEXT, decision TEXT, model_route TEXT,
      session_id TEXT, task_id TEXT, action_id TEXT, rule_id TEXT,
      capability TEXT, payload_hash TEXT, platform TEXT, sandbox_version TEXT);
      CREATE TABLE IF NOT EXISTS audit_redactions (
        hash TEXT PRIMARY KEY, length INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_redaction_characters (
        hash TEXT PRIMARY KEY)`);
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
  private loadRegistry(): void {
    let info;
    try { info = lstatSync(this.registryFile, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('审计隐私登记文件不安全');
    const parsed = JSON.parse(readFileSync(this.registryFile, 'utf8')) as { patterns?: unknown; characters?: unknown };
    if (!Array.isArray(parsed.patterns) || !Array.isArray(parsed.characters)
      || parsed.patterns.some((pattern) => !pattern || typeof pattern.hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(pattern.hash) || !Number.isSafeInteger(pattern.length) || pattern.length <= 0)
      || parsed.characters.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
      throw new Error('审计隐私登记文件损坏');
    }
    this.registryPatterns = parsed.patterns as RedactionPattern[];
    this.registryCharacters = new Set(parsed.characters as string[]);
  }

  private assertUnblocked(): void {
    if (this.blocked) throw new Error('审计隐私写入阻断标记仍生效');
  }

  private persistRegistry(patterns: RedactionPattern[], characters: Set<string>): void {
    if (this.registryFile === ':memory:.privacy-redactions.json') {
      this.registryPatterns = patterns;
      this.registryCharacters = characters;
      return;
    }
    try {
      mkdirSync(dirname(this.registryFile), { recursive: true });
      const temp = join(dirname(this.registryFile), `.audit-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify({ patterns, characters: [...characters] }), { flag: 'wx', mode: 0o600 });
        renameSync(temp, this.registryFile);
        const info = lstatSync(this.registryFile, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('审计隐私登记文件不安全');
      } finally {
        rmSync(temp, { force: true });
      }
      this.registryPatterns = patterns;
      this.registryCharacters = characters;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  private patterns(): RedactionPattern[] {
    this.assertUnblocked();
    return [...new Map([...this.registryPatterns, ...this.db.prepare('SELECT hash, length FROM audit_redactions ORDER BY length DESC').all() as RedactionPattern[]]
      .map((pattern) => [`${pattern.hash}:${pattern.length}`, pattern])).values()]
      .sort((a, b) => b.length - a.length);
  }

  private characters(): Set<string> {
    this.assertUnblocked();
    return new Set([
      ...this.registryCharacters,
      ...(this.db.prepare('SELECT hash FROM audit_redaction_characters').all() as Array<{ hash: string }>).map((row) => row.hash),
    ]);
  }

  marker(candidates = ['[已删除]', '[REDACTED]', '[removed]']): string {
    const patterns = this.patterns();
    const characters = this.characters();
    const safe = (candidate: string): boolean => candidate.length > 0
      && Array.from(candidate).every((character) => !characters.has(fingerprint(character)))
      && findMatches(candidate, patterns).length === 0;
    const named = candidates.find(safe);
    if (named) return named;
    for (let codePoint = 0x25a0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const candidate = String.fromCodePoint(codePoint).repeat(3);
      if (safe(candidate)) return candidate;
    }
    throw new Error('无法生成安全的审计脱敏标记');
  }

  contains(text: string): boolean {
    return findMatches(text, this.patterns()).length > 0;
  }

  private containsValueWithPatterns(value: unknown, patterns: RedactionPattern[]): boolean {
    if (typeof value === 'string') return findMatches(value, patterns).length > 0;
    if (Array.isArray(value)) return value.some((item) => this.containsValueWithPatterns(item, patterns));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
        findMatches(key, patterns).length > 0 || this.containsValueWithPatterns(child, patterns));
    }
    return false;
  }

  containsValue(value: unknown): boolean {
    return this.containsValueWithPatterns(value, this.patterns());
  }

  redactText(text: string): string {
    const patterns = this.patterns();
    return this.redact(text, patterns, this.marker());
  }

  redactValue(value: unknown): { value: unknown; redacted: boolean } {
    const patterns = this.patterns();
    const marker = this.marker();
    const redacted = this.containsValueWithPatterns(value, patterns);
    const scrub = (item: unknown): unknown => {
      if (typeof item === 'string') return this.redact(item, patterns, marker);
      if (Array.isArray(item)) return item.map(scrub);
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item as Record<string, unknown>).map(([key, child]) => [this.redact(key, patterns, marker), scrub(child)] as const);
        if (new Set(entries.map(([key]) => key)).size !== entries.length) return marker;
        return Object.fromEntries(entries);
      }
      return item;
    };
    const output = scrub(value);
    if (this.containsValueWithPatterns(output, patterns)) throw new Error('审计脱敏输出仍包含登记模式');
    return { value: output, redacted };
  }

  private redact(text: string, patterns = this.patterns(), marker = this.marker()): string {
    if (!patterns.length || !text) return text;
    const matches = findMatches(text, patterns);
    const selected: Array<{ start: number; length: number }> = [];
    for (const match of matches) {
      if (selected.some((other) => match.start < other.start + other.length && other.start < match.start + match.length)) continue;
      selected.push(match);
    }
    selected.sort((a, b) => a.start - b.start);
    let output = '';
    let cursor = 0;
    for (const match of selected) {
      output += text.slice(cursor, match.start) + marker;
      cursor = match.start + match.length;
    }
    output += text.slice(cursor);
    if (findMatches(output, patterns).length) throw new Error('审计脱敏输出仍包含登记模式');
    return output;
  }

  private mapRow(row: AuditRow, patterns = this.patterns()): AuditEvent {
    const event = mapRow(row);
    return {
      ...event,
      actor: this.redact(event.actor, patterns),
      action: this.redact(event.action, patterns),
      ...(event.resource !== undefined ? { resource: this.redact(event.resource, patterns) } : {}),
      ...(event.payloadSummary !== undefined ? { payloadSummary: this.redact(event.payloadSummary, patterns) } : {}),
      ...(event.decision !== undefined ? { decision: this.redact(event.decision, patterns) } : {}),
      ...(event.modelRoute !== undefined ? { modelRoute: this.redact(event.modelRoute, patterns) } : {}),
      ...(event.sessionId !== undefined ? { sessionId: this.redact(event.sessionId, patterns) } : {}),
      ...(event.taskId !== undefined ? { taskId: this.redact(event.taskId, patterns) } : {}),
      ...(event.actionId !== undefined ? { actionId: this.redact(event.actionId, patterns) } : {}),
      ...(event.ruleId !== undefined ? { ruleId: this.redact(event.ruleId, patterns) } : {}),
      ...(event.capability !== undefined ? { capability: this.redact(event.capability, patterns) } : {}),
      ...(event.payloadHash !== undefined ? { payloadHash: this.redact(event.payloadHash, patterns) } : {}),
      ...(event.platform !== undefined ? { platform: this.redact(event.platform, patterns) } : {}),
      ...(event.sandboxVersion !== undefined ? { sandboxVersion: this.redact(event.sandboxVersion, patterns) } : {}),
    };
  }

  async append(ev: Omit<AuditEvent, 'id' | 'ts'>): Promise<AuditEvent> {
    const patterns = this.patterns();
    const marker = this.marker();
    const full: AuditEvent = { ...ev, id: randomUUID(), ts: Date.now() };
    for (const column of TEXT_COLUMNS) {
      const key = column === 'payload_summary' ? 'payloadSummary'
        : column === 'model_route' ? 'modelRoute'
          : column === 'session_id' ? 'sessionId'
            : column === 'task_id' ? 'taskId'
              : column === 'action_id' ? 'actionId'
                : column === 'rule_id' ? 'ruleId'
                  : column === 'payload_hash' ? 'payloadHash'
                    : column === 'sandbox_version' ? 'sandboxVersion'
                      : column as keyof AuditEvent;
      const value = full[key];
      if (typeof value === 'string') Object.assign(full, { [key]: this.redact(value, patterns, marker) });
    }
    // 长度上限必须在脱敏之后施加：先截断会把登记过的秘密切成不完整的片段，
    // 使指纹匹配再也认不出来，明文前缀就会被持久化。
    if (typeof full.payloadSummary === 'string' && full.payloadSummary.length > 512) {
      full.payloadSummary = full.payloadSummary.slice(0, 512);
    }
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
    const patterns = this.patterns();
    const marker = this.marker();
    const redactFilter = (value: string | undefined): string | null => value === undefined ? null : this.redact(value, patterns, marker);
    const rows = this.db.prepare(`SELECT * FROM audit WHERE
      (@actor IS NULL OR actor = @actor) AND
      (@action IS NULL OR action = @action) AND
      (@resource IS NULL OR resource = @resource) AND
      (@sessionId IS NULL OR session_id = @sessionId) AND
      (@taskId IS NULL OR task_id = @taskId) AND
      (@actionId IS NULL OR action_id = @actionId) AND
      (@capability IS NULL OR capability = @capability)
      ORDER BY ts DESC`).all({
      actor: redactFilter(filter.actor), action: redactFilter(filter.action),
      resource: redactFilter(filter.resource), sessionId: redactFilter(filter.sessionId),
      taskId: redactFilter(filter.taskId), actionId: redactFilter(filter.actionId),
      capability: redactFilter(filter.capability),
    }) as AuditRow[];
    return rows.map((row) => this.mapRow(row, patterns));
  }

  redactTexts(texts: string[]): number {
    const values = [...new Set(texts.filter((text) => text.length > 0))];
    if (!values.length) return 0;
    const variants = values.flatMap(redactionVariants);
    const patterns = [...new Map(variants.filter((value) => value.length > 0)
      .map((value) => [`${fingerprint(value)}:${value.length}`, { hash: fingerprint(value), length: value.length }])).values()]
      .sort((a, b) => b.length - a.length);
    const characters = new Set([...this.registryCharacters, ...values.flatMap((value) => Array.from(value)).map(fingerprint)]);
    this.persistRegistry([...new Map([...this.registryPatterns, ...patterns]
      .map((pattern) => [`${pattern.hash}:${pattern.length}`, pattern])).values()].sort((a, b) => b.length - a.length), characters);
    let changed = 0;
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO audit_redactions(hash, length) VALUES (?, ?)');
      const insertCharacter = this.db.prepare('INSERT OR IGNORE INTO audit_redaction_characters(hash) VALUES (?)');
      for (const pattern of patterns) insert.run(pattern.hash, pattern.length);
      for (const character of values.flatMap((value) => Array.from(value))) insertCharacter.run(fingerprint(character));
      const allPatterns = this.patterns();
      const marker = this.marker();
      const columns = TEXT_COLUMNS;
      for (const column of columns) {
        const rows = this.db.prepare(`SELECT id, ${column} AS value FROM audit WHERE ${column} IS NOT NULL`).all() as Array<{ id: string; value: string }>;
        const update = this.db.prepare(`UPDATE audit SET ${column} = ? WHERE id = ?`);
        for (const row of rows) {
          const value = this.redact(row.value, allPatterns, marker);
          if (value !== row.value) {
            update.run(value, row.id);
            changed += 1;
          }
        }
      }
    })();
    this.compact();
    return changed;
  }

  private compact(): void {
    this.db.pragma('secure_delete = ON');
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((result) => result.busy !== 0)) throw new Error('审计数据库 WAL 清理被占用');
    this.db.exec('VACUUM');
    const finalCheckpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (finalCheckpoint.some((result) => result.busy !== 0)) throw new Error('审计数据库最终 WAL 清理被占用');
  }

  async exportJsonl(): Promise<string> {
    const patterns = this.patterns();
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY ts ASC').all() as AuditRow[];
    return rows.map((row) => JSON.stringify(this.mapRow(row, patterns))).join('\n');
  }
  close(): void { this.db.close(); }
}
