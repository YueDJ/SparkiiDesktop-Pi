import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorStore } from '../error-store.js';
import {
  atomicWrite,
  episodesFile,
  loadProjectRegistry,
  memoryDir,
  memoryDbPath,
  normalizeWorkspacePath,
  projectMemoryFile,
  userMemoryFile,
} from './settings.js';
import { canUseTrigram, ftsMatchQuery, ftsWindowQuery, probeFts5Trigram, recordMemoryError } from './fts.js';
import type {
  EpisodeRecord,
  MemoryEntry,
  MemoryEntryView,
  MemoryFileV1,
  MemoryStatus,
  MemoryUsage,
  ProjectMemoryFileV1,
  MemorySearchHit,
} from './types.js';

export class CorruptMemoryError extends Error {
  constructor(public readonly file: string, detail: string) {
    super(`记忆文件损坏：${file}（${detail}）`);
    this.name = 'CorruptMemoryError';
  }
}

const STATUSES: MemoryStatus[] = ['active', 'pending', 'superseded'];

/** 情景摘要的条目 id 前缀（表主键是 session_id）。 */
const EPISODE_ID_PREFIX = 'episode:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntries(raw: unknown, file: string): MemoryEntry[] {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw new CorruptMemoryError(file, 'version/entries 结构非法');
  }
  return raw.entries.map((value, index) => {
    if (!isRecord(value)) throw new CorruptMemoryError(file, `第 ${index + 1} 条不是对象`);
    const id = String(value.id ?? '');
    const text = String(value.text ?? '');
    const status = String(value.status ?? '') as MemoryStatus;
    if (!id.startsWith('mem_') || !text.trim() || !STATUSES.includes(status)) {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条字段非法`);
    }
    if (typeof value.pinned !== 'boolean' || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条标记/时间非法`);
    }
    const importance = Number(value.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 3) {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条 importance 非法`);
    }
    const source = value.source === null || value.source === undefined
      ? null
      : isRecord(value.source)
        ? {
            sessionId: String(value.source.sessionId ?? ''),
            excerpt: String(value.source.excerpt ?? ''),
            kind: value.source.kind === 'explicit'
              ? 'explicit' as const
              : value.source.kind === 'consolidated' ? 'consolidated' as const : 'extracted' as const,
          }
        : (() => { throw new CorruptMemoryError(file, `第 ${index + 1} 条 source 非法`); })();
    return {
      id,
      text,
      status,
      pinned: value.pinned,
      importance,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      source,
      supersededBy: typeof value.supersededBy === 'string' ? value.supersededBy : null,
      pendingOp: isRecord(value.pendingOp) ? (value.pendingOp as MemoryEntry['pendingOp']) : null,
    };
  });
}

export function parseMemoryFile(text: string, file: string): MemoryFileV1 {
  try {
    return { version: 1, entries: parseEntries(JSON.parse(text) as unknown, file) };
  } catch (error) {
    if (error instanceof CorruptMemoryError) throw error;
    throw new CorruptMemoryError(file, error instanceof Error ? error.message : String(error));
  }
}

export function parseProjectMemoryFile(text: string, file: string): ProjectMemoryFileV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch (error) {
    throw new CorruptMemoryError(file, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed) || typeof parsed.projectId !== 'string' || !parsed.projectId) {
    throw new CorruptMemoryError(file, '缺少 projectId');
  }
  return {
    version: 1,
    projectId: parsed.projectId,
    archived: parsed.archived === true,
    entries: parseEntries(parsed, file),
  };
}

export interface ScopeFileRef {
  scope: string;
  file: string;
  projectId?: string;
  workspacePath?: string;
  archived?: boolean;
}

interface IndexedRow {
  id: string;
  scope: string;
  project_id: string | null;
  workspace_path: string | null;
  status: MemoryStatus;
  text: string;
  pinned: number;
  importance: number;
  last_accessed_at: number | null;
  access_count: number;
  source_session: string | null;
  file_ref: string;
  updated_at: number;
}

function toView(row: IndexedRow, entry: MemoryEntry, sessionExists: (id: string) => boolean): MemoryEntryView {
  return {
    ...entry,
    scope: row.scope,
    usage: { lastAccessedAt: row.last_accessed_at, accessCount: row.access_count },
    sourceDeleted: Boolean(entry.source?.sessionId && !sessionExists(entry.source.sessionId)),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
  };
}

export class MemoryStore {
  readonly db: Database.Database;
  readonly ftsAvailable: boolean;
  readonly ftsReason?: string;
  readonly sqliteVersion: string;
  private readonly now: () => number;
  private readonly dataDir: string;

  constructor(opts: { dataDir: string; errors?: ErrorStore; now?: () => number; forceLike?: boolean }) {
    this.now = opts.now ?? (() => Date.now());
    this.dataDir = opts.dataDir;
    mkdirSync(memoryDir(opts.dataDir), { recursive: true });
    mkdirSync(join(memoryDir(opts.dataDir), 'agents'), { recursive: true });
    const probe = probeFts5Trigram();
    this.ftsAvailable = opts.forceLike ? false : probe.available;
    this.ftsReason = probe.reason;
    this.sqliteVersion = probe.sqliteVersion;
    if (!this.ftsAvailable && !opts.forceLike) {
      recordMemoryError(opts.errors, 'fts-probe', `FTS5 trigram 不可用，检索退化 LIKE：${probe.reason ?? 'unknown'}`);
    }
    this.db = new Database(memoryDbPath(opts.dataDir));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT, workspace_path TEXT,
        status TEXT NOT NULL, text TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        importance INTEGER NOT NULL, last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0,
        source_session TEXT, file_ref TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_session);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      CREATE TABLE IF NOT EXISTS episodes (
        session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
        project_id TEXT, ts INTEGER NOT NULL, summary TEXT NOT NULL, topics TEXT NOT NULL,
        last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rejected_hashes (
        hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extraction_state (
        session_id TEXT PRIMARY KEY, last_entry_id TEXT NOT NULL DEFAULT '',
        last_run_at INTEGER NOT NULL DEFAULT 0, user_turns_since INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS consolidation_state (
        id TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (this.ftsAvailable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(session_id UNINDEXED, summary, topics, tokenize='trigram');
      `);
    }
    const count = (this.db.prepare('SELECT count(*) AS c FROM memories').get() as { c: number }).c;
    if (count === 0 && this.hasTruthFiles(opts.dataDir)) this.rebuild();
  }

  close(): void { this.db.close(); }

  private hasTruthFiles(dataDir: string): boolean {
    if (existsSync(userMemoryFile(dataDir))) return true;
    const agentsDir = join(memoryDir(dataDir), 'agents');
    if (existsSync(agentsDir) && readdirSync(agentsDir).some((n) => n.endsWith('.json'))) return true;
    return loadProjectRegistry(dataDir).projects.some((p) => existsSync(projectMemoryFile(p.workspacePath)));
  }

  /** 真相源 → db。统计清零是设置页明示的代价。 */
  rebuild(): { entries: number; corrupt: string[] } {
    const refs = this.allScopeFiles();
    const rows = this.readAllTruth(refs);
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM memories');
      this.db.exec('DELETE FROM memories_fts');
      for (const { ref, entry } of rows) this.insertRow(ref, entry, { lastAccessedAt: null, accessCount: 0 });
    });
    tx();
    return { entries: rows.length, corrupt: refs.filter((r) => r.corrupt).map((r) => r.file) };
  }

  allScopeFiles(): Array<ScopeFileRef & { corrupt?: string }> {
    const files: Array<ScopeFileRef & { corrupt?: string }> = [];
    const userFile = userMemoryFile(this.dataDir);
    files.push({ scope: 'user', file: userFile });
    const agentsDir = join(memoryDir(this.dataDir), 'agents');
    if (existsSync(agentsDir)) {
      for (const name of readdirSync(agentsDir).filter((n) => n.endsWith('.json')).sort()) {
        const agentId = name.slice(0, -'.json'.length);
        files.push({ scope: `agent:${agentId}`, file: join(agentsDir, name) });
      }
    }
    for (const project of loadProjectRegistry(this.dataDir).projects) {
      const file = projectMemoryFile(project.workspacePath);
      files.push({
        scope: `project:${project.projectId}`,
        file,
        projectId: project.projectId,
        workspacePath: normalizeWorkspacePath(project.workspacePath),
      });
    }
    // 漂移检测：注册过但文件损坏的 scope 不静默覆盖，也不注入。
    for (const ref of files) {
      if (!existsSync(ref.file)) continue;
      try {
        if (ref.scope === 'user') parseMemoryFile(readFileSync(ref.file, 'utf8'), ref.file);
        else if (ref.scope.startsWith('agent:')) parseMemoryFile(readFileSync(ref.file, 'utf8'), ref.file);
        else parseProjectMemoryFile(readFileSync(ref.file, 'utf8'), ref.file);
      } catch (error) {
        ref.corrupt = error instanceof Error ? error.message : String(error);
      }
    }
    return files;
  }

  readAllTruth(refs: Array<ScopeFileRef & { corrupt?: string }>): Array<{ ref: ScopeFileRef; entry: MemoryEntry; archived?: boolean }> {
    const out: Array<{ ref: ScopeFileRef; entry: MemoryEntry; archived?: boolean }> = [];
    for (const ref of refs) {
      if (!existsSync(ref.file) || ref.corrupt) continue;
      const text = readFileSync(ref.file, 'utf8');
      const parsed = ref.scope.startsWith('project:')
        ? parseProjectMemoryFile(text, ref.file)
        : parseMemoryFile(text, ref.file);
      const archived = ref.scope.startsWith('project:') ? (parsed as ProjectMemoryFileV1).archived === true : undefined;
      for (const entry of parsed.entries) out.push({ ref, entry, archived });
    }
    return out;
  }

  /** 写真相源后同步索引；保留 lastAccessedAt/accessCount。 */
  replaceScopeIndex(ref: ScopeFileRef, entries: MemoryEntry[], archived?: boolean): void {
    const usage = new Map<string, MemoryUsage>();
    for (const row of this.db.prepare('SELECT id, last_accessed_at, access_count FROM memories WHERE scope = ?').all(ref.scope) as Array<{ id: string; last_accessed_at: number | null; access_count: number }>) {
      usage.set(row.id, { lastAccessedAt: row.last_accessed_at, accessCount: row.access_count });
    }
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE scope = ?').run(ref.scope);
      this.db.exec('DELETE FROM memories_fts');
      for (const row of this.db.prepare('SELECT rowid AS rid, id, text FROM memories').all() as Array<{ rid: number; id: string; text: string }>) {
        if (this.ftsAvailable) this.db.prepare('INSERT INTO memories_fts(rowid, id, text) VALUES (?, ?, ?)').run(row.rid, row.id, row.text);
      }
      for (const entry of entries) {
        this.insertRow({ ...ref, archived }, entry, usage.get(entry.id) ?? { lastAccessedAt: null, accessCount: 0 });
      }
    });
    tx();
  }

  private insertRow(ref: ScopeFileRef, entry: MemoryEntry, usage: MemoryUsage, archived?: boolean): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, scope, project_id, workspace_path, status, text, pinned, importance,
         last_accessed_at, access_count, source_session, file_ref, updated_at)
      VALUES (@id, @scope, @projectId, @workspacePath, @status, @text, @pinned, @importance,
              @lastAccessedAt, @accessCount, @sourceSession, @fileRef, @updatedAt)
    `).run({
      id: entry.id,
      scope: ref.scope,
      projectId: ref.projectId ?? null,
      workspacePath: ref.workspacePath ?? null,
      status: entry.status,
      text: entry.text,
      pinned: entry.pinned ? 1 : 0,
      importance: entry.importance,
      lastAccessedAt: usage.lastAccessedAt,
      accessCount: usage.accessCount,
      sourceSession: entry.source?.sessionId ?? null,
      fileRef: ref.file,
      updatedAt: entry.updatedAt,
    });
    if (this.ftsAvailable) {
      const row = this.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(entry.id) as { rid: number };
      this.db.prepare('INSERT INTO memories_fts(rowid, id, text) VALUES (?, ?, ?)').run(row.rid, entry.id, entry.text);
    }
    void archived;
  }

  removeIndexed(id: string): void {
    const tx = this.db.transaction(() => {
      if (this.ftsAvailable) {
        const row = this.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(id) as { rid: number } | undefined;
        if (row) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid);
      }
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    });
    tx();
  }

  usageFor(id: string): MemoryUsage {
    const row = this.db.prepare('SELECT last_accessed_at, access_count FROM memories WHERE id = ?').get(id) as { last_accessed_at: number | null; access_count: number } | undefined;
    return row ? { lastAccessedAt: row.last_accessed_at, accessCount: row.access_count } : { lastAccessedAt: null, accessCount: 0 };
  }

  /** FTS 检索：记忆与情景摘要各查一遍，按 bm25 排序。 */
  private searchFts(match: string, limit: number, statusClause: string): MemorySearchHit[] {
    const out: MemorySearchHit[] = [];
    const rows = this.db.prepare(`
      SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?${statusClause} ORDER BY rank ASC, m.id ASC LIMIT ?
    `).all(match, limit) as Array<IndexedRow & { rank: number }>;
    for (const row of rows) out.push({
      id: row.id, scope: row.scope, text: row.text, kind: 'memory',
      status: row.status, score: -row.rank,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
      ...(row.source_session ? { sessionId: row.source_session } : {}),
    });
    const episodes = this.db.prepare(`
      SELECT e.*, bm25(episodes_fts) AS rank FROM episodes_fts
      JOIN episodes e ON e.rowid = episodes_fts.rowid
      WHERE episodes_fts MATCH ? ORDER BY rank ASC, e.session_id ASC LIMIT ?
    `).all(match, limit) as Array<{ session_id: string; summary: string; project_id: string | null; workspace_path: string; rank: number }>;
    for (const row of episodes) out.push({
      id: `episode:${row.session_id}`, scope: `episode:${row.session_id}`, text: row.summary,
      kind: 'episode', score: -row.rank, summary: row.summary,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      workspacePath: row.workspace_path, sessionId: row.session_id,
    });
    return out;
  }

  rowFor(id: string): IndexedRow | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as IndexedRow | undefined;
  }

  rowsBySession(sessionId: string): IndexedRow[] {
    return this.db.prepare('SELECT * FROM memories WHERE source_session = ?').all(sessionId) as IndexedRow[];
  }

  /**
   * 注入只加计数；reset=true（检索命中/显式操作）才重置时钟。
   * 条目 id 可能是记忆（mem_…）也可能是情景摘要（episode:<sessionId>）——情景摘要
   * 的表主键是 session_id，必须剥掉 `episode:` 前缀再匹配，否则更新落空。
   */
  touchAccess(ids: string[], resetClock: boolean): void {
    if (!ids.length) return;
    const ts = this.now();
    const bumpMemory = this.db.prepare(
      resetClock
        ? 'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
        : 'UPDATE memories SET access_count = access_count + 1 WHERE id = ?',
    );
    const bumpEpisode = this.db.prepare(
      resetClock
        ? 'UPDATE episodes SET access_count = access_count + 1, last_accessed_at = ? WHERE session_id = ?'
        : 'UPDATE episodes SET access_count = access_count + 1 WHERE session_id = ?',
    );
    const tx = this.db.transaction(() => {
      for (const id of new Set(ids)) {
        if (id.startsWith(EPISODE_ID_PREFIX)) {
          const sessionId = id.slice(EPISODE_ID_PREFIX.length);
          if (resetClock) bumpEpisode.run(ts, sessionId);
          else bumpEpisode.run(sessionId);
        } else if (resetClock) {
          bumpMemory.run(ts, id);
        } else {
          bumpMemory.run(id);
        }
      }
    });
    tx();
  }

  viewOf(row: IndexedRow, sessionExists: (id: string) => boolean): MemoryEntryView | null {
    const file = row.file_ref;
    if (!existsSync(file)) return null;
    let parsed: MemoryFileV1;
    try {
      parsed = row.project_id
        ? parseProjectMemoryFile(readFileSync(file, 'utf8'), file)
        : parseMemoryFile(readFileSync(file, 'utf8'), file);
    } catch {
      return null;
    }
    const entry = parsed.entries.find((e) => e.id === row.id);
    if (!entry) return null;
    return toView(row, entry, sessionExists);
  }

  viewsByIds(ids: string[], sessionExists: (id: string) => boolean): MemoryEntryView[] {
    return ids.flatMap((id) => {
      const row = this.rowFor(id);
      return row ? this.viewOf(row, sessionExists) ?? [] : [];
    });
  }

  search(query: string, opts: { limit?: number; includeHistory?: boolean } = {}): MemorySearchHit[] {
    const term = query.trim();
    if (!term) return [];
    const limit = opts.limit ?? 12;
    const statusClause = opts.includeHistory ? '' : " AND m.status != 'superseded'";
    const hits: MemorySearchHit[] = [];
    if (canUseTrigram(term, this.ftsAvailable)) {
      hits.push(...this.searchFts(ftsMatchQuery(term), limit, statusClause));
      if (!hits.length) {
        // 整句问法（"上个月那个项目的报价"）短语匹配必然落空：退到三字窗口 OR。
        const windows = ftsWindowQuery(term);
        if (windows) hits.push(...this.searchFts(windows, limit, statusClause));
      }
    } else {
      const like = `%${term}%`;
      const rows = this.db.prepare(`
        SELECT * FROM memories WHERE text LIKE ?${statusClause}
        ORDER BY importance DESC, updated_at DESC LIMIT ?
      `).all(like, limit) as IndexedRow[];
      for (const row of rows) hits.push({
        id: row.id, scope: row.scope, text: row.text, kind: 'memory', status: row.status,
        score: row.importance,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
      });
      const episodes = this.db.prepare(`
        SELECT * FROM episodes WHERE summary LIKE ? OR topics LIKE ?
        ORDER BY ts DESC LIMIT ?
      `).all(like, like, limit) as Array<{ session_id: string; summary: string; project_id: string | null; workspace_path: string }>;
      for (const row of episodes) hits.push({
        id: `episode:${row.session_id}`, scope: `episode:${row.session_id}`, text: row.summary,
        kind: 'episode', score: 1, summary: row.summary,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        workspacePath: row.workspace_path, sessionId: row.session_id,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  appendEpisode(rec: EpisodeRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO episodes
        (session_id, agent_id, workspace_path, project_id, ts, summary, topics, last_accessed_at, access_count)
      VALUES (@sessionId, @agentId, @workspacePath, @projectId, @ts, @summary, @topics, NULL, 0)
    `).run({ ...rec, projectId: rec.projectId ?? null, topics: JSON.stringify(rec.topics) });
    if (this.ftsAvailable) {
      this.db.prepare('DELETE FROM episodes_fts').run();
      for (const row of this.db.prepare('SELECT rowid AS rid, session_id, summary, topics FROM episodes').all() as Array<{ rid: number; session_id: string; summary: string; topics: string }>) {
        this.db.prepare('INSERT INTO episodes_fts(rowid, session_id, summary, topics) VALUES (?, ?, ?, ?)').run(row.rid, row.session_id, row.summary, row.topics);
      }
    }
    const line = JSON.stringify(rec);
    appendFileSync(episodesFile(this.dataDir), `${line}\n`, 'utf8');
  }

  listEpisodes(): EpisodeRecord[] {
    return (this.db.prepare('SELECT * FROM episodes ORDER BY ts DESC').all() as Array<{
      session_id: string; agent_id: string; workspace_path: string; project_id: string | null;
      ts: number; summary: string; topics: string;
    }>).map((row) => ({
      sessionId: row.session_id, agentId: row.agent_id, workspacePath: row.workspace_path,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ts: row.ts, summary: row.summary, topics: JSON.parse(row.topics) as string[],
    }));
  }

  /**
   * 情景摘要二次压缩（§9 空闲整合）：只改系统生成的情景摘要，不动用户记忆。
   * 追加式日志按行重写成原子文件，保留其余行原文。
   */
  updateEpisodeSummary(sessionId: string, summary: string): void {
    this.db.prepare('UPDATE episodes SET summary = ? WHERE session_id = ?').run(summary, sessionId);
    if (this.ftsAvailable) {
      this.db.prepare('UPDATE episodes_fts SET summary = ? WHERE session_id = ?').run(summary, sessionId);
    }
    const path = episodesFile(this.dataDir);
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
    let hit = false;
    const next = lines.map((line) => {
      try {
        const rec = JSON.parse(line) as EpisodeRecord;
        if (rec.sessionId !== sessionId) return line;
        hit = true;
        return JSON.stringify({ ...rec, summary, compressedAt: Date.now() });
      } catch {
        return line;
      }
    });
    if (hit) atomicWrite(path, `${next.join('\n')}\n`);
  }

  deleteEpisodesForSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      if (this.ftsAvailable) {
        this.db.prepare('DELETE FROM episodes_fts WHERE session_id = ?').run(sessionId);
      }
      this.db.prepare('DELETE FROM episodes WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM rejected_hashes WHERE session_id = ?').run(sessionId);
    });
    tx();
    const path = episodesFile(this.dataDir);
    if (existsSync(path)) {
      const kept = readFileSync(path, 'utf8').split('\n').filter((line) => {
        if (!line.trim()) return false;
        try { return (JSON.parse(line) as EpisodeRecord).sessionId !== sessionId; } catch { return false; }
      });
      atomicWrite(path, kept.length ? `${kept.join('\n')}\n` : '');
    }
  }

  addRejectedHash(hash: string, sessionId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO rejected_hashes(hash, session_id, created_at) VALUES (?, ?, ?)')
      .run(hash, sessionId, this.now());
  }

  hasRejectedHash(hash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM rejected_hashes WHERE hash = ?').get(hash));
  }

  getExtractionState(sessionId: string): { lastEntryId: string; lastRunAt: number; userTurnsSince: number } {
    const row = this.db.prepare('SELECT * FROM extraction_state WHERE session_id = ?').get(sessionId) as {
      last_entry_id: string; last_run_at: number; user_turns_since: number;
    } | undefined;
    return row
      ? { lastEntryId: row.last_entry_id, lastRunAt: row.last_run_at, userTurnsSince: row.user_turns_since }
      : { lastEntryId: '', lastRunAt: 0, userTurnsSince: 0 };
  }

  setExtractionState(sessionId: string, state: { lastEntryId: string; lastRunAt?: number; userTurnsSince: number }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO extraction_state(session_id, last_entry_id, last_run_at, user_turns_since)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, state.lastEntryId, state.lastRunAt ?? this.getExtractionState(sessionId).lastRunAt, state.userTurnsSince);
  }

  getConsolidationLastRun(): number {
    const row = this.db.prepare("SELECT last_run_at FROM consolidation_state WHERE id = 'singleton'").get() as { last_run_at: number } | undefined;
    return row?.last_run_at ?? 0;
  }

  setConsolidationLastRun(ts: number): void {
    this.db.prepare("INSERT OR REPLACE INTO consolidation_state(id, last_run_at) VALUES ('singleton', ?)").run(ts);
  }

  /** 会话删除时把仍引用它的 active 记忆的来源置空（界面显示“来源已删除”）。 */
  markSourcesDeleted(sessionId: string): void {
    for (const ref of this.allScopeFiles()) {
      if (!existsSync(ref.file) || ref.corrupt) continue;
      const text = readFileSync(ref.file, 'utf8');
      const parsed = ref.scope.startsWith('project:')
        ? parseProjectMemoryFile(text, ref.file)
        : parseMemoryFile(text, ref.file);
      let changed = false;
      for (const entry of parsed.entries) {
        if (entry.source?.sessionId !== sessionId) continue;
        // 保留 sessionId 作为审计线索，改写 excerpt 作为界面“来源已删除”标记；不物理丢证据链。
        entry.source = { ...entry.source, excerpt: '来源已删除' };
        changed = true;
      }
      if (!changed) continue;
      atomicWrite(ref.file, `${JSON.stringify(parsed, null, 2)}\n`);
      this.replaceScopeIndex(ref, parsed.entries);
    }
  }

  /** 隐私清理：按 sessionId 从全部真相源文件删除条目（pending 也在其中）。 */
  deleteMemoryEntriesBySession(sessionId: string): string[] {
    const removed: string[] = [];
    for (const ref of this.allScopeFiles()) {
      if (!existsSync(ref.file) || ref.corrupt) continue;
      const text = readFileSync(ref.file, 'utf8');
      const parsed = ref.scope.startsWith('project:')
        ? parseProjectMemoryFile(text, ref.file)
        : parseMemoryFile(text, ref.file);
      let localCount = 0;
      const kept = parsed.entries.filter((entry) => {
        if (entry.source?.sessionId === sessionId) { removed.push(entry.id); localCount += 1; return false; }
        return true;
      });
      if (localCount === 0) continue;
      atomicWrite(ref.file, `${JSON.stringify({ ...parsed, entries: kept }, null, 2)}\n`);
      this.replaceScopeIndex(ref, kept);
    }
    for (const id of new Set(removed)) this.removeIndexed(id);
    this.deleteEpisodesForSession(sessionId);
    return [...new Set(removed)];
  }
}

