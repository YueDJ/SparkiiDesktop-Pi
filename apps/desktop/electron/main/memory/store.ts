import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ErrorStore } from '../error-store.js';
import { PrivacyRedactions } from '../privacy-redactions.js';
import {
  agentMemoryFile,
  episodesFile,
  episodeProposalFile,
  episodeProposalsDir,
  extractionStateFile,
  loadProjectRegistry,
  readProjectRegistry,
  memoryDbPath,
  memoryDir,
  normalizeWorkspacePath,
  projectMemoryFile,
  userMemoryFile,
  workspacePathKey,
} from './settings.js';
import { assertNoReparseOrHardlinks, assertTruthAvailable, commitTruthBatch, TruthPathSafetyError, truthPathKey } from './truth-batch.js';
import {
  assertTruthPathSafe,
  inspectTruthFile,
  inspectTruthFilesTwice,
  readTruthDirectoriesVerified,
  readTruthDirectoryVerified,
  readTruthFileVerified,
  readTruthFileVerifiedResult,
  readTruthFilesVerified,
  removeTruthPathVerified,
  truthFileIdentity,
  type TruthAttributeProbe,
  type TruthFileIdentity,
} from './truth-path.js';
import { canUseTrigram, ftsMatchQuery, ftsWindowQuery, probeFts5Trigram, recordMemoryError } from './fts.js';
import { isPendingSchemaKey, isPendingStructuralFieldValid } from './types.js';
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

export class ScopeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeConflictError';
  }
}

const STATUSES: MemoryStatus[] = ['active', 'pending', 'superseded'];
const EPISODE_ID_PREFIX = 'episode:';

type ExtractionState = { lastEntryId: string; lastRunAt: number; userTurnsSince: number };
type AuxTruthSnapshot = { text: string; contentHash: string; identity: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntries(raw: unknown, file: string): MemoryEntry[] {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw new CorruptMemoryError(file, 'version/entries 结构非法');
  }
  const seen = new Set<string>();
  return raw.entries.map((value, index) => {
    if (!isRecord(value)) throw new CorruptMemoryError(file, `第 ${index + 1} 条不是对象`);
    if (typeof value.id !== 'string' || typeof value.text !== 'string' || typeof value.status !== 'string') {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条字段非法`);
    }
    const id = value.id;
    const text = value.text;
    const status = value.status as MemoryStatus;
    if (!id.startsWith('mem_') || !text.trim() || !STATUSES.includes(status)) {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条字段非法`);
    }
    if (seen.has(id)) throw new CorruptMemoryError(file, `记忆 id 重复：${id}`);
    seen.add(id);
    if (typeof value.pinned !== 'boolean' || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条标记/时间非法`);
    }
    if (typeof value.importance !== 'number' || !Number.isInteger(value.importance) || value.importance < 1 || value.importance > 3) {
      throw new CorruptMemoryError(file, `第 ${index + 1} 条 importance 非法`);
    }
    const importance = value.importance;
    const source = value.source === null || value.source === undefined
      ? null
      : isRecord(value.source)
        ? (() => {
            if (value.source.sessionId !== undefined && typeof value.source.sessionId !== 'string') {
              throw new CorruptMemoryError(file, `第 ${index + 1} 条 source 非法`);
            }
            if (value.source.excerpt !== undefined && typeof value.source.excerpt !== 'string') {
              throw new CorruptMemoryError(file, `第 ${index + 1} 条 source 非法`);
            }
            return {
              sessionId: value.source.sessionId ?? '',
              excerpt: value.source.excerpt ?? '',
              kind: value.source.kind === 'explicit'
                ? 'explicit' as const
                : value.source.kind === 'consolidated' ? 'consolidated' as const : 'extracted' as const,
            };
          })()
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
      pendingOp: isRecord(value.pendingOp) ? value.pendingOp as MemoryEntry['pendingOp'] : null,
    };
  });
}

export function parseMemoryFile(text: string, file: string): MemoryFileV1 {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error('根节点不是对象');
    return { version: 1, entries: parseEntries(parsed, file) };
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

interface TruthFileSnapshot {
  text: string;
  contentHash: string;
  entries: MemoryEntry[];
  projectId?: string;
  archived?: boolean;
  identity: string;
}

export interface TruthReconciliation {
  warnings: string[];
  refs: Array<ScopeFileRef & { corrupt?: string }>;
  snapshots: Map<string, TruthFileSnapshot | undefined>;
  identity: {
    warnings: string[];
    projectFiles: Set<string>;
    idFiles: Set<string>;
  };
}

export interface PrivacyDeletePreflight {
  refs: Array<ScopeFileRef & { corrupt?: string }>;
  doomed: MemoryEntry[];
  episodes: EpisodeRecord[];
  states: Record<string, ExtractionState>;
  snapshots: Array<{ ref: ScopeFileRef; snapshot: TruthFileSnapshot }>;
  episodeSnapshot?: AuxTruthSnapshot;
  extractionSnapshot?: AuxTruthSnapshot;
}

export class TruthSnapshotChangedError extends Error {
  constructor(file: string) {
    super(`记忆真相文件在索引提交前变化：${file}`);
    this.name = 'TruthSnapshotChangedError';
  }
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

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseExtractionStates(text: string, file: string): Record<string, ExtractionState> {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch (error) {
    throw new CorruptMemoryError(file, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) throw new CorruptMemoryError(file, '提取位点不是对象');
  const out: Record<string, ExtractionState> = {};
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new CorruptMemoryError(file, `会话 ${sessionId} 位点非法`);
    const lastEntryId = String(value.lastEntryId ?? '');
    const lastRunAt = Number(value.lastRunAt ?? 0);
    const userTurnsSince = Number(value.userTurnsSince ?? 0);
    if (!Number.isFinite(lastRunAt) || !Number.isFinite(userTurnsSince)) {
      throw new CorruptMemoryError(file, `会话 ${sessionId} 位点数值非法`);
    }
    out[sessionId] = { lastEntryId, lastRunAt, userTurnsSince };
  }
  return out;
}

export class MemoryStore {
  readonly db: Database.Database;
  readonly ftsAvailable: boolean;
  readonly ftsReason?: string;
  readonly sqliteVersion: string;
  readonly recoveryWarnings: string[] = [];
  private readonly now: () => number;
  private readonly dataDir: string;
  private readonly probeAttributes?: TruthAttributeProbe;
  private readonly unavailable?: () => string[];
  private readonly redactions: PrivacyRedactions;
  private readonly readTruthFile: (path: string) => string;
  private readonly truthSnapshots = new Map<string, TruthFileSnapshot>();
  private privacyCleanupDepth = 0;
  private readFenceDepth = 0;

  constructor(opts: { dataDir: string; errors?: ErrorStore; now?: () => number; forceLike?: boolean; unavailable?: () => string[]; readTruthFile?: (path: string) => string; probeAttributes?: TruthAttributeProbe }) {
    this.now = opts.now ?? (() => Date.now());
    this.dataDir = opts.dataDir;
    this.probeAttributes = opts.probeAttributes;
    this.unavailable = opts.unavailable;
    this.readTruthFile = opts.readTruthFile ?? ((path) => readFileSync(path, 'utf8'));
    assertTruthPathSafe(memoryDir(opts.dataDir), opts.probeAttributes);
    mkdirSync(memoryDir(opts.dataDir), { recursive: true });
    this.redactions = new PrivacyRedactions(join(memoryDir(opts.dataDir), 'privacy-redactions.json'));
    mkdirSync(join(memoryDir(opts.dataDir), 'agents'), { recursive: true });
    mkdirSync(episodeProposalsDir(opts.dataDir), { recursive: true });
    const agentsEntries = readTruthDirectoryVerified(join(memoryDir(opts.dataDir), 'agents'), opts.probeAttributes);
    const proposalEntries = readTruthDirectoryVerified(episodeProposalsDir(opts.dataDir), opts.probeAttributes);
    const probe = probeFts5Trigram();
    this.ftsAvailable = opts.forceLike ? false : probe.available;
    this.ftsReason = probe.reason;
    this.sqliteVersion = probe.sqliteVersion;
    if (!this.ftsAvailable && !opts.forceLike) {
      recordMemoryError(opts.errors, 'fts-probe', `FTS5 trigram 不可用，检索退化 LIKE：${probe.reason ?? 'unknown'}`);
    }
    this.db = this.openDatabase(opts.errors);
    try {
      if (this.count('memories') === 0 && this.hasTruthFiles(agentsEntries, proposalEntries)) this.rebuild();
    } catch (error) {
      const message = `派生索引运行失败，已使用内存索引：${error instanceof Error ? error.message : String(error)}`;
      this.recoveryWarnings.push(message);
      recordMemoryError(opts.errors, 'index-runtime', message);
      try { this.db.close(); } catch { /* best effort */ }
      this.db = this.openMemoryDatabase();
      try {
        if (this.hasTruthFiles()) this.rebuild();
      } catch (rebuildError) {
        const detail = `内存索引重建失败：${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`;
        this.recoveryWarnings.push(detail);
        recordMemoryError(opts.errors, 'index-rebuild', detail);
      }
    }
  }

  private count(table: 'memories' | 'episodes'): number {
    return (this.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  private assertDatabasePathsSafe(path: string): void {
    assertNoReparseOrHardlinks([path, `${path}-wal`, `${path}-shm`, `${path}-journal`]);
  }

  private openDiskDatabase(path: string): Database.Database {
    this.assertDatabasePathsSafe(path);
    let db: Database.Database | undefined;
    try {
      db = new Database(path);
      this.assertDatabasePathsSafe(path);
      db.pragma('secure_delete = ON');
      this.initializeSchema(db);
      this.assertDatabasePathsSafe(path);
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* best effort */ }
      throw error;
    }
  }

  private openDatabase(errors?: ErrorStore): Database.Database {
    const path = memoryDbPath(this.dataDir);
    let db: Database.Database | undefined;
    try {
      db = this.openDiskDatabase(path);
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* best effort */ }
      if (error instanceof TruthPathSafetyError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const quarantine = `${path}.corrupt-${Date.now()}`;
      try {
        this.assertDatabasePathsSafe(path);
        assertTruthPathSafe(quarantine, this.probeAttributes);
        renameSync(path, quarantine);
        for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
          assertTruthPathSafe(sidecar, this.probeAttributes);
          rmSync(sidecar, { force: true });
        }
        this.assertDatabasePathsSafe(path);
      } catch (isolationError) {
        if (isolationError instanceof TruthPathSafetyError) throw isolationError;
        /* best effort */
      }
      const message = `SQLite 索引损坏，已隔离到 ${quarantine}：${detail}`;
      this.recoveryWarnings.push(message);
      recordMemoryError(errors, 'index-corrupt', message);
      try {
        return this.openDiskDatabase(path);
      } catch (fallbackError) {
        if (fallbackError instanceof TruthPathSafetyError) throw fallbackError;
        const fallbackMessage = `SQLite 索引无法写盘，已使用内存索引：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
        this.recoveryWarnings.push(fallbackMessage);
        recordMemoryError(errors, 'index-fallback', fallbackMessage);
        return this.openMemoryDatabase();
      }
    }
  }

  private openMemoryDatabase(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('secure_delete = ON');
    this.initializeSchema(db);
    return db;
  }

  private initializeSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT, workspace_path TEXT,
        status TEXT NOT NULL, text TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        importance INTEGER NOT NULL, last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0,
        source_session TEXT, file_ref TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_file ON memories(file_ref);
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
      CREATE TABLE IF NOT EXISTS scope_files (
        file_ref TEXT PRIMARY KEY, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS privacy_recovery (
        memory_id TEXT NOT NULL, source_session TEXT, workspace_path TEXT NOT NULL,
        file_ref TEXT NOT NULL, PRIMARY KEY(memory_id, file_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_privacy_recovery_file ON privacy_recovery(file_ref);
    `);
    for (const row of db.prepare('SELECT file_ref FROM scope_files').all() as Array<{ file_ref: string }>) {
      const normalized = row.file_ref.replace(/\\/g, '/');
      if (!normalized.endsWith('/.sparkii/memory.json')) continue;
      const workspacePath = dirname(dirname(row.file_ref));
      db.prepare('INSERT OR IGNORE INTO privacy_recovery(memory_id, source_session, workspace_path, file_ref) VALUES (?, ?, ?, ?)')
        .run('', null, workspacePath, row.file_ref);
    }
    if (this.ftsAvailable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(session_id UNINDEXED, summary, topics, tokenize='trigram');
      `);
    }
  }

  close(): void { this.db.close(); }

  private assertAvailable(): void {
    if (this.readFenceDepth === 0) assertTruthAvailable(this.dataDir, this.probeAttributes);
    if (this.privacyCleanupDepth === 0) {
      const warnings = this.unavailable?.() ?? [];
      if (warnings.length) throw new Error(warnings.join('；'));
    }
  }

  private withReadFence<T>(operation: () => T): T {
    this.assertAvailable();
    this.readFenceDepth += 1;
    try {
      return operation();
    } finally {
      this.readFenceDepth -= 1;
    }
  }

  assertReadAvailable(): void {
    this.assertAvailable();
  }

  runPrivacyCleanup<T>(operation: () => T): T {
    this.privacyCleanupDepth += 1;
    try {
      this.assertAvailable();
      this.readFenceDepth += 1;
      try { return operation(); } finally { this.readFenceDepth -= 1; }
    } finally {
      this.privacyCleanupDepth -= 1;
    }
  }

  private hasTruthFiles(agentsEntries?: string[], proposalEntries?: string[]): boolean {
    if (existsSync(userMemoryFile(this.dataDir))) return true;
    const agentsDir = join(memoryDir(this.dataDir), 'agents');
    if ((agentsEntries ?? readTruthDirectoryVerified(agentsDir, this.probeAttributes)).some((name) => name.endsWith('.json'))) return true;
    if (existsSync(episodesFile(this.dataDir)) || existsSync(extractionStateFile(this.dataDir))) return true;
    if ((proposalEntries ?? readTruthDirectoryVerified(episodeProposalsDir(this.dataDir), this.probeAttributes)).length) return true;
    return loadProjectRegistry(this.dataDir).projects.some((project) => existsSync(projectMemoryFile(project.workspacePath)));
  }

  private readAuxTruthSnapshot(path: string): AuxTruthSnapshot | undefined {
    this.assertAvailable();
    const result = readTruthFileVerifiedResult(path, {
      allowMissing: true,
      probeAttributes: this.probeAttributes,
      read: (file) => Buffer.from(this.readTruthFile(file)),
    });
    if (!result) return undefined;
    const text = result.content.toString('utf8');
    return { text, contentHash: hash(text), identity: result.identity };
  }

  private readAuxTruthSnapshots(paths: string[]): Array<AuxTruthSnapshot | undefined> {
    this.assertAvailable();
    const results = readTruthFilesVerified(paths.map((path) => ({
      path,
      allowMissing: true,
      read: (file) => Buffer.from(this.readTruthFile(file)),
    })), this.probeAttributes);
    return results.map((result) => {
      if (!result) return undefined;
      const text = result.content.toString('utf8');
      return { text, contentHash: hash(text), identity: result.identity };
    });
  }

  private assertAuxSnapshotCurrent(path: string, snapshot: AuxTruthSnapshot | undefined): void {
    try {
      if (!snapshot) {
        if (inspectTruthFile(path, this.probeAttributes, { allowMissing: true })) throw new TruthSnapshotChangedError(path);
        return;
      }
      const text = readTruthFileVerified(path, {
        probeAttributes: this.probeAttributes,
        expectedIdentity: snapshot.identity,
        read: (file) => Buffer.from(this.readTruthFile(file)),
      }).toString('utf8');
      if (hash(text) !== snapshot.contentHash) throw new TruthSnapshotChangedError(path);
    } catch (error) {
      if (error instanceof TruthSnapshotChangedError) throw error;
      throw new TruthSnapshotChangedError(path);
    }
  }

  readProjectTruth(file: string): ProjectMemoryFileV1 {
    const snapshot = this.readScopeSnapshot({ scope: 'project:read', file });
    if (!snapshot) throw new CorruptMemoryError(file, '项目记忆文件缺失');
    return { version: 1, ...snapshot, projectId: snapshot.projectId!, archived: snapshot.archived! };
  }

  readScopeSnapshot(ref: ScopeFileRef): TruthFileSnapshot | undefined {
    this.assertAvailable();
    return this.readVerifiedScopeSnapshot(ref);
  }

  private snapshotFromVerifiedRead(ref: ScopeFileRef, result: { content: Buffer; identity: string }): TruthFileSnapshot {
    const text = result.content.toString('utf8');
    const parsed = ref.scope.startsWith('project:')
      ? parseProjectMemoryFile(text, ref.file)
      : parseMemoryFile(text, ref.file);
    return {
      text,
      contentHash: hash(text),
      entries: parsed.entries,
      ...(ref.scope.startsWith('project:') ? {
        projectId: (parsed as ProjectMemoryFileV1).projectId,
        archived: (parsed as ProjectMemoryFileV1).archived,
      } : {}),
      identity: result.identity,
    };
  }

  private readVerifiedScopeSnapshots(refs: ScopeFileRef[]): Map<string, TruthFileSnapshot | undefined> {
    const snapshots = new Map<string, TruthFileSnapshot | undefined>();
    if (!refs.length) return snapshots;
    const current = inspectTruthFilesTwice(refs.map((ref) => ({
      path: ref.file,
      options: { allowMissing: true, regularFile: true },
    })), this.probeAttributes);
    const missing: Array<{ ref: ScopeFileRef; identity: TruthFileIdentity }> = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const key = truthPathKey(ref.file);
      const cached = this.truthSnapshots.get(key);
      if (!current[index]) {
        this.truthSnapshots.delete(key);
        snapshots.set(key, undefined);
      } else if (cached?.identity === current[index]!.identity) {
        snapshots.set(key, structuredClone(cached));
      } else {
        missing.push({ ref, identity: current[index]! });
      }
    }
    if (missing.length) {
      const results = readTruthFilesVerified(missing.map(({ ref }) => ({
        path: ref.file,
        allowMissing: true,
        read: (file) => Buffer.from(this.readTruthFile(file)),
      })), this.probeAttributes, missing.map(({ identity }) => identity));
      for (let index = 0; index < missing.length; index += 1) {
        const ref = missing[index].ref;
        const key = truthPathKey(ref.file);
        const result = results[index];
        if (!result) {
          this.truthSnapshots.delete(key);
          snapshots.set(key, undefined);
          continue;
        }
        try {
          const snapshot = this.snapshotFromVerifiedRead(ref, result);
          this.truthSnapshots.set(key, snapshot);
          snapshots.set(key, structuredClone(snapshot));
        } catch (error) {
          this.truthSnapshots.delete(key);
          throw error;
        }
      }
    }
    return snapshots;
  }

  private readVerifiedScopeSnapshot(ref: ScopeFileRef): TruthFileSnapshot | undefined {
    const key = truthPathKey(ref.file);
    const cached = this.truthSnapshots.get(key);
    if (cached) {
      const current = inspectTruthFile(ref.file, this.probeAttributes, { allowMissing: true, regularFile: true });
      if (!current) {
        this.truthSnapshots.delete(key);
        return undefined;
      }
      if (current.identity === cached.identity) return structuredClone(cached);
    }
    const result = readTruthFileVerifiedResult(ref.file, {
      allowMissing: true,
      probeAttributes: this.probeAttributes,
      read: (file) => Buffer.from(this.readTruthFile(file)),
    });
    if (!result) {
      this.truthSnapshots.delete(key);
      return undefined;
    }
    try {
      const snapshot = this.snapshotFromVerifiedRead(ref, result);
      this.truthSnapshots.set(key, snapshot);
      return structuredClone(snapshot);
    } catch (error) {
      this.truthSnapshots.delete(key);
      throw error;
    }
  }

  private assertSnapshotCurrent(ref: ScopeFileRef, snapshot: TruthFileSnapshot): void {
    try {
      const text = readTruthFileVerified(ref.file, {
        probeAttributes: this.probeAttributes,
        expectedIdentity: snapshot.identity,
        read: (file) => Buffer.from(this.readTruthFile(file)),
      }).toString('utf8');
      if (hash(text) !== snapshot.contentHash) throw new TruthSnapshotChangedError(ref.file);
    } catch (error) {
      if (error instanceof TruthSnapshotChangedError) throw error;
      throw new TruthSnapshotChangedError(ref.file);
    }
  }

  allScopeFiles(options: { strictProjects?: boolean; workspacePaths?: string[] } = {}): Array<ScopeFileRef & { corrupt?: string }> {
    this.assertAvailable();
    const files: Array<ScopeFileRef & { corrupt?: string }> = [
      { scope: 'user', file: userMemoryFile(this.dataDir) },
    ];
    const agentsDir = join(memoryDir(this.dataDir), 'agents');
    const proposalsDir = episodeProposalsDir(this.dataDir);
    const existingDirs = [agentsDir, proposalsDir].filter((path) => existsSync(path));
    const directoryEntries = readTruthDirectoriesVerified(existingDirs, this.probeAttributes);
    const entriesByDirectory = new Map(existingDirs.map((path, index) => [path, directoryEntries[index]]));
    for (const name of (entriesByDirectory.get(agentsDir) ?? []).filter((entry) => entry.endsWith('.json')).sort()) {
      const agentId = name.slice(0, -'.json'.length);
      files.push({ scope: `agent:${agentId}`, file: join(agentsDir, name) });
    }
    const projects = options.strictProjects === false
      ? loadProjectRegistry(this.dataDir).projects
      : readProjectRegistry(this.dataDir).projects;
    for (const project of projects) {
      files.push({
        scope: `project:${project.projectId}`,
        file: projectMemoryFile(project.workspacePath),
        projectId: project.projectId,
        workspacePath: normalizeWorkspacePath(project.workspacePath),
        archived: project.archived,
      });
    }
    const registeredWorkspaces = new Set(projects.map((project) => workspacePathKey(project.workspacePath)));
    for (const workspacePath of options.workspacePaths ?? []) {
      const normalized = normalizeWorkspacePath(workspacePath);
      const key = workspacePathKey(normalized);
      if (!normalized || registeredWorkspaces.has(key)) continue;
      const file = projectMemoryFile(normalized);
      if (!existsSync(file)) continue;
      const ref: ScopeFileRef & { corrupt?: string } = {
        scope: `project:unregistered:${key}`,
        file,
        workspacePath: normalized,
      };
      files.push(ref);
      registeredWorkspaces.add(key);
    }
    for (const name of (entriesByDirectory.get(proposalsDir) ?? []).filter((entry) => entry.endsWith('.json')).sort()) {
      const sessionId = name.slice(0, -'.json'.length);
      files.push({ scope: `episode:${sessionId}`, file: join(proposalsDir, name) });
    }
    let snapshots: Map<string, TruthFileSnapshot | undefined>;
    try {
      snapshots = this.readVerifiedScopeSnapshots(files);
    } catch {
      // Preserve per-scope corruption reporting if one member of the read batch fails.
      snapshots = new Map();
      for (const ref of files) {
        try { snapshots.set(truthPathKey(ref.file), this.readVerifiedScopeSnapshot(ref)); } catch { /* reported below */ }
      }
    }
    for (const ref of files) {
      try {
        // Every file is probed again at its actual read boundary; a batch fence is not a read capability.
        const key = truthPathKey(ref.file);
        const snapshot = snapshots.has(key) ? snapshots.get(key) : this.readVerifiedScopeSnapshot(ref);
        if (!snapshot) continue;
        if (ref.scope.startsWith('project:')) {
          const expectedProjectId = ref.projectId;
          ref.scope = `project:${snapshot.projectId}`;
          ref.projectId = snapshot.projectId;
          ref.archived = snapshot.archived;
          if (expectedProjectId && expectedProjectId !== snapshot.projectId) {
            throw new CorruptMemoryError(ref.file, 'projectId 与注册表不一致');
          }
        }
      } catch (error) {
        this.truthSnapshots.delete(truthPathKey(ref.file));
        ref.corrupt = error instanceof Error ? error.message : String(error);
      }
    }
    return files;
  }

  readAllTruth(refs: Array<ScopeFileRef & { corrupt?: string }>): Array<{ ref: ScopeFileRef; entry: MemoryEntry; archived?: boolean }> {
    this.assertAvailable();
    const out: Array<{ ref: ScopeFileRef; entry: MemoryEntry; archived?: boolean }> = [];
    const readable = refs.filter((ref) => !ref.corrupt);
    const snapshots = this.readVerifiedScopeSnapshots(readable);
    for (const ref of readable) {
      const snapshot = snapshots.get(truthPathKey(ref.file));
      if (!snapshot) continue;
      const archived = snapshot.archived;
      if (archived !== undefined) ref.archived = archived;
      for (const entry of snapshot.entries) out.push({ ref, entry, archived });
    }
    return out;
  }

  identityConflicts(refs: Array<ScopeFileRef & { corrupt?: string }>): {
    warnings: string[];
    projectFiles: Set<string>;
    idFiles: Set<string>;
  } {
    return this.identityConflictsFromRows(refs, this.readAllTruth(refs));
  }

  private identityConflictsFromRows(refs: Array<ScopeFileRef & { corrupt?: string }>, rows: Array<{ ref: ScopeFileRef; entry: MemoryEntry }>): {
    warnings: string[];
    projectFiles: Set<string>;
    idFiles: Set<string>;
  } {
    const warnings: string[] = [];
    const projectFiles = new Set<string>();
    const idFiles = new Set<string>();
    const projects = new Map<string, string>();
    const ids = new Map<string, string>();
    for (const ref of refs) {
      if (!ref.projectId) continue;
      const other = projects.get(ref.projectId);
      if (other && other !== ref.file) {
        warnings.push(`projectId 重复：${ref.projectId}`);
        projectFiles.add(other);
        projectFiles.add(ref.file);
      } else projects.set(ref.projectId, ref.file);
    }
    for (const { ref, entry } of rows) {
      const other = ids.get(entry.id);
      if (other && other !== ref.file) {
        warnings.push(`记忆 id 跨文件重复：${entry.id}`);
        idFiles.add(other);
        idFiles.add(ref.file);
      } else ids.set(entry.id, ref.file);
    }
    return { warnings: [...new Set(warnings)], projectFiles, idFiles };
  }

  private identityConflictsFromDiscovery(refs: Array<ScopeFileRef & { corrupt?: string }>): {
    warnings: string[];
    projectFiles: Set<string>;
    idFiles: Set<string>;
  } {
    const rows = refs.flatMap((ref) => {
      if (ref.corrupt) return [];
      const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
      return snapshot ? [{ ref, entries: snapshot.entries }] : [];
    }).flatMap(({ ref, entries }) => entries.map((entry) => ({ ref, entry })));
    return this.identityConflictsFromRows(refs, rows);
  }

  preflightReplacement(file: string, projectId: string, entries: MemoryEntry[], workspacePaths: string[] = []): void {
    const refs = this.allScopeFiles({
      workspacePaths: [...new Set([...workspacePaths, ...this.recoverableProjectWorkspaces()])],
    })
      .filter((ref) => workspacePathKey(ref.file) !== workspacePathKey(file));
    const conflicts = this.conflicts(refs);
    if (conflicts.length) throw new ScopeConflictError(conflicts.join('；'));
    const corrupt = refs.find((ref) => ref.corrupt);
    if (corrupt) throw new CorruptMemoryError(corrupt.file, corrupt.corrupt!);
    if (refs.some((ref) => ref.projectId === projectId)) {
      throw new ScopeConflictError(`projectId 重复：${projectId}`);
    }
    const ids = new Map<string, string>();
    for (const { ref, entry } of this.readAllTruth(refs)) ids.set(entry.id, ref.file);
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new ScopeConflictError(`记忆 id 跨文件重复：${entry.id}`);
      ids.set(entry.id, file);
    }
  }

  recoverableProjectWorkspaces(): string[] {
    const workspaces = new Map<string, string>();
    const add = (workspacePath: string): void => {
      const normalized = normalizeWorkspacePath(workspacePath);
      if (normalized) workspaces.set(workspacePathKey(normalized), normalized);
    };
    for (const row of this.db.prepare('SELECT DISTINCT workspace_path FROM privacy_recovery').all() as Array<{ workspace_path: string }>) {
      add(row.workspace_path);
    }
    for (const row of this.db.prepare('SELECT DISTINCT workspace_path FROM memories WHERE workspace_path IS NOT NULL').all() as Array<{ workspace_path: string }>) {
      add(row.workspace_path);
    }
    for (const row of this.db.prepare("SELECT file_ref FROM scope_files WHERE file_ref <> 'episodes'").all() as Array<{ file_ref: string }>) {
      if (row.file_ref.replace(/\\/g, '/').endsWith('/.sparkii/memory.json')) add(dirname(dirname(row.file_ref)));
    }
    return [...workspaces.values()];
  }

  privacyRecoveryFor(id: string): { sourceSession?: string; workspacePath: string; fileRef: string } | undefined {
    this.assertAvailable();
    const row = this.db.prepare('SELECT source_session, workspace_path, file_ref FROM privacy_recovery WHERE memory_id = ? LIMIT 1').get(id) as { source_session: string | null; workspace_path: string; file_ref: string } | undefined;
    return row ? { ...(row.source_session ? { sourceSession: row.source_session } : {}), workspacePath: row.workspace_path, fileRef: row.file_ref } : undefined;
  }

  indexedRowFor(id: string): IndexedRow | undefined {
    this.assertAvailable();
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as IndexedRow | undefined;
  }

  private rememberRecovery(file: string, workspacePath: string, rows: Array<{ id: string; source_session: string | null }> = []): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO privacy_recovery(memory_id, source_session, workspace_path, file_ref) VALUES (?, ?, ?, ?)');
    insert.run('', null, workspacePath, file);
    for (const row of rows) insert.run(row.id, row.source_session, workspacePath, file);
  }

  conflicts(refs: Array<ScopeFileRef & { corrupt?: string }>): string[] {
    return this.identityConflicts(refs).warnings;
  }

  rebuild(): { entries: number; corrupt: string[]; conflicts: string[] } {
    return this.withReadFence(() => this.rebuildUnfenced());
  }

  private rebuildUnfenced(): { entries: number; corrupt: string[]; conflicts: string[] } {
    this.assertAvailable();
    const refs = this.allScopeFiles();
    const rows = this.readAllTruth(refs);
    const snapshots = refs.flatMap((ref) => {
      const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
      return snapshot ? [{ ref, snapshot }] : [];
    });
    const conflicts = this.identityConflictsFromRows(refs, rows);
    if (conflicts.warnings.length) throw new ScopeConflictError(conflicts.warnings.join('；'));
    const episodeSnapshot = this.readAuxTruthSnapshot(episodesFile(this.dataDir));
    const episodeRecords = episodeSnapshot ? this.parseEpisodesTruth(episodeSnapshot.text, episodesFile(this.dataDir)) : [];
    const extractionSnapshot = this.readAuxTruthSnapshot(extractionStateFile(this.dataDir));
    const states = extractionSnapshot ? parseExtractionStates(extractionSnapshot.text, extractionStateFile(this.dataDir)) : {};
    const recovery = this.db.prepare('SELECT file_ref FROM privacy_recovery').all() as Array<{ file_ref: string }>;
    const tx = this.db.transaction(() => {
      for (const { ref, snapshot } of snapshots) this.assertSnapshotCurrent(ref, snapshot);
      this.assertAuxSnapshotCurrent(episodesFile(this.dataDir), episodeSnapshot);
      this.assertAuxSnapshotCurrent(extractionStateFile(this.dataDir), extractionSnapshot);
      this.db.exec('DELETE FROM memories');
      if (this.ftsAvailable) this.db.exec('DELETE FROM memories_fts');
      this.db.exec('DELETE FROM episodes');
      if (this.ftsAvailable) this.db.exec('DELETE FROM episodes_fts');
      this.db.exec('DELETE FROM extraction_state');
      this.db.exec('DELETE FROM scope_files');
      for (const row of recovery) {
        if (!existsSync(row.file_ref)) this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(row.file_ref);
      }
      for (const ref of refs) this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(ref.file);
      for (const { ref, entry } of rows) this.insertRow(ref, entry, { lastAccessedAt: null, accessCount: 0 });
      for (const rec of episodeRecords) this.indexEpisode(rec);
      for (const [sessionId, state] of Object.entries(states)) this.indexExtractionState(sessionId, state);
      for (const { ref, snapshot } of snapshots) {
        this.db.prepare('INSERT OR REPLACE INTO scope_files(file_ref, content_hash, updated_at) VALUES (?, ?, ?)')
          .run(ref.file, snapshot.contentHash, this.now());
      }
    });
    tx();
    return { entries: rows.length, corrupt: refs.filter((ref) => ref.corrupt).map((ref) => ref.file), conflicts: conflicts.warnings };
  }

  replaceScopeIndex(ref: ScopeFileRef, entries: MemoryEntry[], archived?: boolean, snapshot?: TruthFileSnapshot): void {
    this.withReadFence(() => this.replaceScopeIndexUnfenced(ref, entries, archived, snapshot));
  }

  private replaceScopeIndexUnfenced(ref: ScopeFileRef, entries: MemoryEntry[], archived?: boolean, snapshot?: TruthFileSnapshot): void {
    this.assertAvailable();
    const current = snapshot ?? this.readScopeSnapshot(ref);
    if (!current) throw new CorruptMemoryError(ref.file, '索引提交前真相文件缺失');
    const projectConflict = ref.projectId
      ? this.db.prepare('SELECT DISTINCT file_ref FROM memories WHERE project_id = ? AND file_ref <> ? LIMIT 1').get(ref.projectId, ref.file) as { file_ref: string } | undefined
      : undefined;
    if (projectConflict) throw new ScopeConflictError(`projectId ${ref.projectId} 已索引到 ${projectConflict.file_ref}`);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) throw new ScopeConflictError(`同一文件记忆 id 重复：${entry.id}`);
      seen.add(entry.id);
      const other = this.db.prepare('SELECT file_ref FROM memories WHERE id = ? AND file_ref <> ? LIMIT 1').get(entry.id, ref.file) as { file_ref: string } | undefined;
      if (other) throw new ScopeConflictError(`记忆 id ${entry.id} 已索引到 ${other.file_ref}`);
    }
    const usage = new Map<string, MemoryUsage>();
    for (const row of this.db.prepare('SELECT id, last_accessed_at, access_count FROM memories WHERE file_ref = ?').all(ref.file) as Array<{ id: string; last_accessed_at: number | null; access_count: number }>) {
      usage.set(row.id, { lastAccessedAt: row.last_accessed_at, accessCount: row.access_count });
    }
    const tx = this.db.transaction(() => {
      if (current.identity) {
        const fresh = inspectTruthFile(ref.file, this.probeAttributes, { regularFile: true });
        if (!fresh || fresh.identity !== current.identity) throw new TruthSnapshotChangedError(ref.file);
      } else {
        this.assertSnapshotCurrent(ref, current);
      }
      this.removeFileIndex(ref.file);
      this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(ref.file);
      for (const entry of current.entries) this.insertRow(ref, entry, usage.get(entry.id) ?? { lastAccessedAt: null, accessCount: 0 });
      this.db.prepare('INSERT OR REPLACE INTO scope_files(file_ref, content_hash, updated_at) VALUES (?, ?, ?)')
        .run(ref.file, current.contentHash, this.now());
    });
    tx();
    this.truthSnapshots.set(truthPathKey(ref.file), current);
    void archived;
  }

  private indexCommittedScopes(
    changes: Map<string, string>,
    updates: Map<string, { ref: ScopeFileRef; entries: MemoryEntry[]; archived?: boolean }>,
    identities: Map<string, string>,
    refs: ScopeFileRef[],
  ): void {
    for (const [file, update] of updates) {
      const text = changes.get(file)!;
      const identity = identities.get(file);
      const snapshot: TruthFileSnapshot | undefined = identity ? {
        text,
        contentHash: hash(text),
        entries: update.entries,
        ...(update.ref.scope.startsWith('project:') ? {
          projectId: update.ref.projectId,
          archived: update.archived,
        } : {}),
        identity,
      } : undefined;
      this.replaceScopeIndex(update.ref, update.entries, update.archived, snapshot);
    }
    const episodePath = episodesFile(this.dataDir);
    const episodeText = changes.get(episodePath);
    if (episodeText !== undefined) {
      const identity = identities.get(episodePath);
      this.rebuildEpisodeIndex(identity ? { text: episodeText, contentHash: hash(episodeText), identity } : undefined);
    }
    const clearRecovery = this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?');
    for (const ref of refs) clearRecovery.run(ref.file);
  }

  private removeFileIndex(file: string): void {
    if (this.ftsAvailable) {
      for (const row of this.db.prepare('SELECT rowid AS rid FROM memories WHERE file_ref = ?').all(file) as Array<{ rid: number }>) {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid);
      }
    }
    this.db.prepare('DELETE FROM memories WHERE file_ref = ?').run(file);
  }

  private insertRow(ref: ScopeFileRef, entry: MemoryEntry, usage: MemoryUsage): void {
    this.db.prepare(`
      INSERT INTO memories
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

  reconcileAll(): string[] {
    return this.reconcileAllWithTruth().warnings;
  }

  reconcileAllWithTruth(): TruthReconciliation {
    return this.withReadFence(() => this.reconcileAllUnfenced());
  }

  private reconcileAllUnfenced(): TruthReconciliation {
    this.assertAvailable();
    const refs = this.allScopeFiles();
    const identity = this.identityConflictsFromDiscovery(refs);
    const blockedFiles = new Set([...identity.projectFiles, ...identity.idFiles]);
    const knownFiles = new Set(refs.map((ref) => workspacePathKey(ref.file)));
    const staleFiles = this.db.prepare(`
      SELECT file_ref FROM memories
      UNION
      SELECT file_ref FROM scope_files WHERE file_ref <> 'episodes'
    `).all() as Array<{ file_ref: string }>;
    for (const { file_ref: file } of staleFiles) {
      if (knownFiles.has(workspacePathKey(file))) continue;
      const rows = this.db.prepare('SELECT id, source_session, workspace_path FROM memories WHERE file_ref = ?').all(file) as Array<{ id: string; source_session: string | null; workspace_path: string | null }>;
      const normalized = file.replace(/\\/g, '/');
      if (existsSync(file) && normalized.endsWith('/.sparkii/memory.json')) {
        this.rememberRecovery(file, rows[0]?.workspace_path ?? dirname(dirname(file)), rows);
      }
      this.removeFileIndex(file);
      this.db.prepare('DELETE FROM scope_files WHERE file_ref = ?').run(file);
      if (!existsSync(file)) this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(file);
    }
    for (const ref of refs) {
      if (!existsSync(ref.file) || ref.corrupt || blockedFiles.has(ref.file)) {
        const rows = this.db.prepare('SELECT id, source_session FROM memories WHERE file_ref = ?').all(ref.file) as Array<{ id: string; source_session: string | null }>;
        if (existsSync(ref.file) && ref.scope.startsWith('project:')) {
          this.rememberRecovery(ref.file, ref.workspacePath ?? dirname(dirname(ref.file)), rows);
        } else {
          this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(ref.file);
        }
        this.removeFileIndex(ref.file);
        this.db.prepare('DELETE FROM scope_files WHERE file_ref = ?').run(ref.file);
        continue;
      }
      const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
      if (!snapshot) throw new CorruptMemoryError(ref.file, '索引快照缺失');
      const current = snapshot.contentHash;
      const indexed = this.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(ref.file) as { content_hash: string } | undefined;
      const indexedCount = (this.db.prepare('SELECT count(*) AS count FROM memories WHERE file_ref = ?').get(ref.file) as { count: number }).count;
      if (indexed?.content_hash !== current || indexedCount !== snapshot.entries.length) {
        this.replaceScopeIndex(ref, snapshot.entries, ref.archived, snapshot);
      }
      this.db.prepare('DELETE FROM privacy_recovery WHERE file_ref = ?').run(ref.file);
    }
    const episodePath = episodesFile(this.dataDir);
    const episodeSnapshot = this.readAuxTruthSnapshot(episodePath);
    const indexedEpisodeHash = (this.db.prepare("SELECT content_hash FROM scope_files WHERE file_ref = 'episodes'").get() as { content_hash: string } | undefined)?.content_hash ?? '';
    if (episodeSnapshot?.contentHash !== indexedEpisodeHash || (!episodeSnapshot && indexedEpisodeHash !== '')) {
      this.rebuildEpisodeIndex(episodeSnapshot);
    }
    return {
      warnings: identity.warnings,
      refs,
      snapshots: new Map(refs.map((ref) => {
        const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
        return [truthPathKey(ref.file), snapshot ? structuredClone(snapshot) : undefined];
      })),
      identity,
    };
  }

  usageFor(id: string): MemoryUsage {
    const row = this.db.prepare('SELECT last_accessed_at, access_count FROM memories WHERE id = ?').get(id) as { last_accessed_at: number | null; access_count: number } | undefined;
    return row ? { lastAccessedAt: row.last_accessed_at, accessCount: row.access_count } : { lastAccessedAt: null, accessCount: 0 };
  }

  private searchFts(match: string, limit: number, statusClause: string): MemorySearchHit[] {
    const out: MemorySearchHit[] = [];
    const rows = this.db.prepare(`
      SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?${statusClause} ORDER BY rank ASC, m.id ASC LIMIT ?
    `).all(match, limit) as Array<IndexedRow & { rank: number }>;
    for (const row of rows) out.push({
      id: row.id, scope: row.scope, text: row.text, kind: 'memory', status: row.status, score: -row.rank,
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
      id: `${EPISODE_ID_PREFIX}${row.session_id}`, scope: `episode:${row.session_id}`, text: row.summary,
      kind: 'episode', score: -row.rank, summary: row.summary,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      workspacePath: row.workspace_path, sessionId: row.session_id,
    });
    return out;
  }

  rowFor(id: string): IndexedRow | undefined {
    this.reconcileAll();
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as IndexedRow | undefined;
  }

  rowsBySession(sessionId: string): IndexedRow[] {
    this.reconcileAll();
    return this.db.prepare('SELECT * FROM memories WHERE source_session = ?').all(sessionId) as IndexedRow[];
  }

  touchAccess(ids: string[], resetClock: boolean): void {
    this.assertAvailable();
    if (!ids.length) return;
    const ts = this.now();
    const bumpMemory = this.db.prepare(resetClock
      ? 'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
      : 'UPDATE memories SET access_count = access_count + 1 WHERE id = ?');
    const bumpEpisode = this.db.prepare(resetClock
      ? 'UPDATE episodes SET access_count = access_count + 1, last_accessed_at = ? WHERE session_id = ?'
      : 'UPDATE episodes SET access_count = access_count + 1 WHERE session_id = ?');
    const tx = this.db.transaction(() => {
      for (const id of new Set(ids)) {
        if (id.startsWith(EPISODE_ID_PREFIX)) {
          const sessionId = id.slice(EPISODE_ID_PREFIX.length);
          if (resetClock) bumpEpisode.run(ts, sessionId);
          else bumpEpisode.run(sessionId);
        } else if (resetClock) bumpMemory.run(ts, id);
        else bumpMemory.run(id);
      }
    });
    tx();
  }

  viewOf(row: IndexedRow, sessionExists: (id: string) => boolean): MemoryEntryView | null {
    this.assertAvailable();
    const snapshot = this.readScopeSnapshot({
      scope: row.scope,
      file: row.file_ref,
      projectId: row.project_id ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
    });
    if (!snapshot) return null;
    const entry = snapshot.entries.find((candidate) => candidate.id === row.id);
    return entry ? toView(row, entry, sessionExists) : null;
  }

  viewsByIds(ids: string[], sessionExists: (id: string) => boolean): MemoryEntryView[] {
    return ids.flatMap((id) => {
      const row = this.rowFor(id);
      return row ? this.viewOf(row, sessionExists) ?? [] : [];
    });
  }

  search(query: string, opts: { limit?: number; includeHistory?: boolean } = {}): MemorySearchHit[] {
    this.reconcileAll();
    const term = query.trim();
    if (!term) return [];
    const limit = opts.limit ?? 12;
    const statusClause = opts.includeHistory ? " AND m.status IN ('active','superseded')" : " AND m.status = 'active'";
    const hits: MemorySearchHit[] = [];
    if (canUseTrigram(term, this.ftsAvailable)) {
      hits.push(...this.searchFts(ftsMatchQuery(term), limit, statusClause));
      if (!hits.length) {
        const windows = ftsWindowQuery(term);
        if (windows) hits.push(...this.searchFts(windows, limit, statusClause));
      }
    } else {
      const like = `%${term}%`;
      const rows = this.db.prepare(`
        SELECT m.* FROM memories m WHERE m.text LIKE ?${statusClause}
        ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?
      `).all(like, limit) as IndexedRow[];
      for (const row of rows) hits.push({
        id: row.id, scope: row.scope, text: row.text, kind: 'memory', status: row.status, score: row.importance,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
      });
      const episodes = this.db.prepare(`
        SELECT * FROM episodes WHERE summary LIKE ? OR topics LIKE ? ORDER BY ts DESC LIMIT ?
      `).all(like, like, limit) as Array<{ session_id: string; summary: string; project_id: string | null; workspace_path: string }>;
      for (const row of episodes) hits.push({
        id: `${EPISODE_ID_PREFIX}${row.session_id}`, scope: `episode:${row.session_id}`, text: row.summary,
        kind: 'episode', score: 1, summary: row.summary,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        workspacePath: row.workspace_path, sessionId: row.session_id,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  private parseEpisodesTruth(text: string, path: string): EpisodeRecord[] {
    const out: EpisodeRecord[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.summary !== 'string' || !Array.isArray(value.topics)) {
          throw new Error('字段非法');
        }
        out.push(value as unknown as EpisodeRecord);
      } catch (error) {
        throw new CorruptMemoryError(path, `第 ${index + 1} 行：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  }

  private readEpisodesTruth(): EpisodeRecord[] {
    const snapshot = this.readAuxTruthSnapshot(episodesFile(this.dataDir));
    return snapshot ? this.parseEpisodesTruth(snapshot.text, episodesFile(this.dataDir)) : [];
  }

  private assertPrivacyValues(value: unknown): void {
    if (typeof value === 'string') {
      if (this.redactions.contains(value)) throw new Error('隐私脱敏输出仍包含登记模式');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.assertPrivacyValues(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) this.assertPrivacyValues(nested);
    }
  }

  redactEpisodeForPrivacy(rec: EpisodeRecord): EpisodeRecord {
    const output = {
      ...rec,
      summary: this.redactions.redact(rec.summary),
      topics: rec.topics.map((topic) => this.redactions.redact(topic)),
    };
    this.assertPrivacyValues(output);
    return output;
  }

  indexEpisode(rec: EpisodeRecord): void {
    const safe = this.redactEpisodeForPrivacy(rec);
    this.db.prepare(`
      INSERT OR REPLACE INTO episodes
        (session_id, agent_id, workspace_path, project_id, ts, summary, topics, last_accessed_at, access_count)
      VALUES (@sessionId, @agentId, @workspacePath, @projectId, @ts, @summary, @topics,
        COALESCE((SELECT last_accessed_at FROM episodes WHERE session_id = @sessionId), NULL),
        COALESCE((SELECT access_count FROM episodes WHERE session_id = @sessionId), 0))
    `).run({ ...safe, projectId: safe.projectId ?? null, topics: JSON.stringify(safe.topics) });
  }

  private rebuildEpisodeIndex(snapshot = this.readAuxTruthSnapshot(episodesFile(this.dataDir))): void {
    const path = episodesFile(this.dataDir);
    const records = snapshot ? this.parseEpisodesTruth(snapshot.text, path) : [];
    const tx = this.db.transaction(() => {
      if (snapshot?.identity) {
        const fresh = inspectTruthFile(path, this.probeAttributes, { regularFile: true });
        if (!fresh || fresh.identity !== snapshot.identity) throw new TruthSnapshotChangedError(path);
      } else {
        this.assertAuxSnapshotCurrent(path, snapshot);
      }
      this.db.exec('DELETE FROM episodes');
      if (this.ftsAvailable) this.db.exec('DELETE FROM episodes_fts');
      for (const rec of records) this.indexEpisode(rec);
      if (this.ftsAvailable) {
        for (const row of this.db.prepare('SELECT rowid AS rid, session_id, summary, topics FROM episodes').all() as Array<{ rid: number; session_id: string; summary: string; topics: string }>) {
          this.db.prepare('INSERT INTO episodes_fts(rowid, session_id, summary, topics) VALUES (?, ?, ?, ?)')
            .run(row.rid, row.session_id, row.summary, row.topics);
        }
      }
      this.db.prepare("INSERT OR REPLACE INTO scope_files(file_ref, content_hash, updated_at) VALUES ('episodes', ?, ?)")
        .run(snapshot?.contentHash ?? '', this.now());
    });
    tx();
  }

  appendEpisode(rec: EpisodeRecord): void {
    this.assertAvailable();
    const safe = this.redactEpisodeForPrivacy(rec);
    const path = episodesFile(this.dataDir);
    const snapshot = this.readAuxTruthSnapshot(path);
    mkdirSync(memoryDir(this.dataDir), { recursive: true });
    const content = `${snapshot?.text ?? ''}${snapshot?.text && !snapshot.text.endsWith('\n') ? '\n' : ''}${JSON.stringify(safe)}\n`;
    commitTruthBatch(this.dataDir, new Map([[path, content]]), { probeAttributes: this.probeAttributes });
    try { this.indexEpisode(safe); this.refreshEpisodeFts(); } catch (error) {
      recordMemoryError(undefined, 'episode-index', error instanceof Error ? error.message : String(error));
    }
  }

  private refreshEpisodeFts(): void {
    if (!this.ftsAvailable) return;
    this.db.prepare('DELETE FROM episodes_fts').run();
    for (const row of this.db.prepare('SELECT rowid AS rid, session_id, summary, topics FROM episodes').all() as Array<{ rid: number; session_id: string; summary: string; topics: string }>) {
      this.db.prepare('INSERT INTO episodes_fts(rowid, session_id, summary, topics) VALUES (?, ?, ?, ?)')
        .run(row.rid, row.session_id, row.summary, row.topics);
    }
  }

  episodeRecordsForSession(sessionId: string): EpisodeRecord[] {
    return this.readEpisodesTruth().filter((rec) => rec.sessionId === sessionId)
      .map((rec) => this.redactEpisodeForPrivacy(rec));
  }

  listEpisodes(): EpisodeRecord[] {
    const latest = new Map<string, EpisodeRecord>();
    for (const rec of this.readEpisodesTruth()) latest.set(rec.sessionId, rec);
    return [...latest.values()].sort((a, b) => b.ts - a.ts).map((rec) => this.redactEpisodeForPrivacy(rec));
  }

  updateEpisodeSummary(sessionId: string, summary: string): void {
    this.assertAvailable();
    const path = episodesFile(this.dataDir);
    const snapshot = this.readAuxTruthSnapshot(path);
    const current = (snapshot ? this.parseEpisodesTruth(snapshot.text, path) : [])
      .filter((rec) => rec.sessionId === sessionId).at(-1);
    if (!current) return;
    const updated = { ...current, summary, compressedAt: Date.now() };
    const next = this.redactEpisodeForPrivacy(updated);
    commitTruthBatch(this.dataDir, new Map([[path, `${snapshot!.text}${snapshot!.text && !snapshot!.text.endsWith('\n') ? '\n' : ''}${JSON.stringify(next)}\n`]]), { probeAttributes: this.probeAttributes });
    try { this.indexEpisode(next); this.refreshEpisodeFts(); } catch (error) {
      recordMemoryError(undefined, 'episode-index', error instanceof Error ? error.message : String(error));
    }
  }

  deleteEpisodesForSession(sessionId: string): void {
    this.assertAvailable();
    const path = episodesFile(this.dataDir);
    const snapshot = this.readAuxTruthSnapshot(path);
    if (snapshot) {
      const kept = this.parseEpisodesTruth(snapshot.text, path)
        .filter((rec) => rec.sessionId !== sessionId)
        .map((rec) => JSON.stringify(rec));
      commitTruthBatch(this.dataDir, new Map([[path, kept.length ? `${kept.join('\n')}\n` : '']]), { probeAttributes: this.probeAttributes });
    }
    const tx = this.db.transaction(() => {
      if (this.ftsAvailable) this.db.prepare('DELETE FROM episodes_fts WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM episodes WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM rejected_hashes WHERE session_id = ?').run(sessionId);
    });
    tx();
  }

  addRejectedHash(hashValue: string, sessionId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO rejected_hashes(hash, session_id, created_at) VALUES (?, ?, ?)')
      .run(hashValue, sessionId, this.now());
  }

  hasRejectedHash(hashValue: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM rejected_hashes WHERE hash = ?').get(hashValue));
  }

  private readExtractionTruth(): Record<string, ExtractionState> {
    const snapshot = this.readAuxTruthSnapshot(extractionStateFile(this.dataDir));
    return snapshot ? parseExtractionStates(snapshot.text, extractionStateFile(this.dataDir)) : {};
  }

  private indexExtractionState(sessionId: string, state: ExtractionState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO extraction_state(session_id, last_entry_id, last_run_at, user_turns_since)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, state.lastEntryId, state.lastRunAt, state.userTurnsSince);
  }

  extractionStateSnapshot(): Record<string, ExtractionState> {
    return this.readExtractionTruth();
  }

  getExtractionState(sessionId: string): ExtractionState {
    const states = this.readExtractionTruth();
    return states[sessionId] ?? { lastEntryId: '', lastRunAt: 0, userTurnsSince: 0 };
  }

  setExtractionState(sessionId: string, state: { lastEntryId: string; lastRunAt?: number; userTurnsSince: number }, indexOnly = false): void {
    this.assertAvailable();
    const previous = this.getExtractionState(sessionId);
    const next = { lastEntryId: state.lastEntryId, lastRunAt: state.lastRunAt ?? previous.lastRunAt, userTurnsSince: state.userTurnsSince };
    if (!indexOnly) {
      const states = this.readExtractionTruth();
      states[sessionId] = next;
      commitTruthBatch(this.dataDir, new Map([[extractionStateFile(this.dataDir), `${JSON.stringify(states, null, 2)}\n`]]), { probeAttributes: this.probeAttributes });
    }
    try { this.indexExtractionState(sessionId, next); } catch (error) {
      recordMemoryError(undefined, 'extraction-state-index', error instanceof Error ? error.message : String(error));
    }
  }

  consolidationSimilarRows(): Array<{ id: string; scope: string; text: string; updated_at: number; file_ref: string }> {
    this.assertAvailable();
    return this.db.prepare(
      "SELECT id, scope, text, updated_at, file_ref FROM memories WHERE status = 'active' ORDER BY scope, updated_at DESC",
    ).all() as Array<{ id: string; scope: string; text: string; updated_at: number; file_ref: string }>;
  }

  consolidationStaleProjectRows(cutoff: number, limit: number): Array<{ id: string; scope: string; text: string; updated_at: number }> {
    this.assertAvailable();
    return this.db.prepare(
      "SELECT id, scope, text, updated_at FROM memories WHERE status = 'active' AND scope LIKE 'project:%' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
    ).all(cutoff, limit) as Array<{ id: string; scope: string; text: string; updated_at: number }>;
  }

  getConsolidationLastRun(): number {
    this.assertAvailable();
    const row = this.db.prepare("SELECT last_run_at FROM consolidation_state WHERE id = 'singleton'").get() as { last_run_at: number } | undefined;
    return row?.last_run_at ?? 0;
  }

  setConsolidationLastRun(ts: number): void {
    this.assertAvailable();
    this.db.prepare("INSERT OR REPLACE INTO consolidation_state(id, last_run_at) VALUES ('singleton', ?)").run(ts);
  }

  registerPrivacyTexts(texts: string[]): void {
    const values = [...new Set(texts.filter((text) => text.trim().length > 0))];
    if (values.length) this.redactions.register(values);
  }

  redactPrivacyText(text: string): string {
    return this.redactions.redact(text);
  }

  private assertStructuralPrivacyValue(key: string, value: unknown): void {
    if (key !== 'targetId' && key !== 'projectId' && key !== 'mergeIds') return;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item === 'string' && this.redactions.contains(item))) {
      throw new Error(`隐私结构字段仍包含登记模式：${key}`);
    }
  }

  private assertPendingPrivacyOutput(value: unknown, topLevel = false): void {
    if (typeof value === 'string') {
      if (this.redactions.contains(value)) throw new Error('隐私脱敏输出仍包含登记模式');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.assertPendingPrivacyOutput(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const schema = topLevel && isPendingSchemaKey(key);
      const structural = topLevel && isPendingStructuralFieldValid(key, nested);
      if (structural) {
        this.assertStructuralPrivacyValue(key, nested);
        continue;
      }
      if (!schema && this.redactions.contains(key)) throw new Error('隐私脱敏输出仍包含登记模式');
      this.assertPendingPrivacyOutput(nested);
    }
  }

  private redactPendingValue(value: unknown, preserveStructuralFields: boolean): unknown {
    if (typeof value === 'string') return this.redactions.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactPendingValue(item, false));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const schema = preserveStructuralFields && isPendingSchemaKey(key);
      const structural = preserveStructuralFields && isPendingStructuralFieldValid(key, nested);
      const redactedKey = schema ? key : this.redactions.redact(key);
      if (Object.prototype.hasOwnProperty.call(output, redactedKey)) {
        throw new Error(`隐私脱敏导致动态对象键碰撞或冲突：${redactedKey}`);
      }
      if (structural) this.assertStructuralPrivacyValue(key, nested);
      output[redactedKey] = structural ? nested : this.redactPendingValue(nested, false);
    }
    return output;
  }

  redactPendingOperationForPrivacy(pendingOp: NonNullable<MemoryEntry['pendingOp']>): NonNullable<MemoryEntry['pendingOp']> {
    const output = this.redactPendingValue(pendingOp, true) as NonNullable<MemoryEntry['pendingOp']>;
    this.assertPendingPrivacyOutput(output, true);
    return output;
  }

  redactEntryForPrivacy(entry: MemoryEntry): MemoryEntry {
    const output: MemoryEntry = {
      ...entry,
      text: this.redactions.redact(entry.text),
      ...(entry.source ? { source: { ...entry.source, excerpt: this.redactions.redact(entry.source.excerpt) } } : {}),
      ...(entry.pendingOp ? { pendingOp: this.redactPendingOperationForPrivacy(entry.pendingOp) } : {}),
    };
    for (const value of [output.id, output.status, output.source?.sessionId, output.supersededBy]) {
      if (typeof value === 'string' && this.redactions.contains(value)) {
        throw new Error('隐私脱敏输出仍包含登记模式');
      }
    }
    return output;
  }

  redactTexts(texts: string[]): void {
    this.assertAvailable();
    const values = [...new Set(texts.filter((text) => text.trim().length > 0))];
    if (!values.length) return;
    this.redactions.register(values);
    const redact = (text: string): string => this.redactions.redact(text);
    this.db.pragma('secure_delete = ON');
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT id, text FROM memories').all() as Array<{ id: string; text: string }>) {
        const text = redact(row.text);
        if (text !== row.text) this.db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(text, row.id);
      }
      for (const row of this.db.prepare('SELECT session_id, summary, topics FROM episodes').all() as Array<{ session_id: string; summary: string; topics: string }>) {
        const summary = redact(row.summary);
        const topics = redact(row.topics);
        if (summary !== row.summary || topics !== row.topics) {
          this.db.prepare('UPDATE episodes SET summary = ?, topics = ? WHERE session_id = ?').run(summary, topics, row.session_id);
        }
      }
      if (this.ftsAvailable) {
        this.db.exec('DELETE FROM memories_fts');
        this.db.exec('INSERT INTO memories_fts(rowid, id, text) SELECT rowid, id, text FROM memories');
      }
      this.refreshEpisodeFts();
    })();
    this.compact();
  }

  private zeroAndRemoveDatabaseArtifact(file: string): void {
    let descriptor: number | undefined;
    try {
      assertTruthPathSafe(file, this.probeAttributes);
      const before = lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error('记忆数据库清理目标不是普通单链接文件');
      }
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('记忆数据库清理文件过大');
      const identity = truthFileIdentity(before);
      const length = Number(before.size);
      assertTruthPathSafe(file, this.probeAttributes);
      const immediatelyBefore = lstatSync(file, { bigint: true });
      if (!immediatelyBefore.isFile() || immediatelyBefore.isSymbolicLink() || immediatelyBefore.nlink !== 1n
        || truthFileIdentity(immediatelyBefore) !== identity) {
        throw new Error('记忆数据库清理目标身份已变化');
      }
      descriptor = openSync(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || truthFileIdentity(opened) !== identity) {
        throw new Error('记忆数据库清理文件句柄身份已变化');
      }
      ftruncateSync(descriptor, length);
      writeFileSync(descriptor, Buffer.alloc(length));
      fsyncSync(descriptor);
      assertTruthPathSafe(file, this.probeAttributes);
      const zeroed = Buffer.alloc(length);
      const read = readSync(descriptor, zeroed, 0, length, 0);
      const openedAfterWrite = fstatSync(descriptor, { bigint: true });
      closeSync(descriptor);
      descriptor = undefined;
      assertTruthPathSafe(file, this.probeAttributes);
      const after = lstatSync(file, { bigint: true });
      if (read !== length || !zeroed.every((byte) => byte === 0)) {
        throw new Error('记忆数据库清理文件清零回读校验失败');
      }
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || truthFileIdentity(after) !== truthFileIdentity(openedAfterWrite)) {
        throw new Error('记忆数据库清理文件清零校验失败');
      }
      removeTruthPathVerified(file, {
        expectedIdentity: truthFileIdentity(after),
        probeAttributes: this.probeAttributes,
      });
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the original fenced failure */ }
      }
    }
  }

  compact(): void {
    const path = memoryDbPath(this.dataDir);
    this.assertDatabasePathsSafe(path);
    this.db.pragma('secure_delete = ON');
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((result) => result.busy !== 0)) throw new Error('记忆数据库 WAL 清理被占用');
    this.db.exec('VACUUM');
    this.assertDatabasePathsSafe(path);
    const finalCheckpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (finalCheckpoint.some((result) => result.busy !== 0)) throw new Error('记忆数据库最终 WAL 清理被占用');
    const dir = dirname(path);
    const prefix = `${basename(path)}.corrupt-`;
    if (existsSync(dir)) {
      for (const name of readTruthDirectoryVerified(dir, this.probeAttributes).filter((entry) => entry.startsWith(prefix))) {
        this.zeroAndRemoveDatabaseArtifact(join(dir, name));
      }
    }
    const journal = `${path}-journal`;
    if (existsSync(journal)) this.zeroAndRemoveDatabaseArtifact(journal);
  }

  private trustedProjectRefs(refs: Array<ScopeFileRef & { corrupt?: string }>): Array<ScopeFileRef & { corrupt?: string }> {
    const trusted = new Set<string>();
    for (const project of readProjectRegistry(this.dataDir).projects) {
      trusted.add(workspacePathKey(project.workspacePath));
    }
    for (const workspacePath of this.recoverableProjectWorkspaces()) {
      trusted.add(workspacePathKey(workspacePath));
    }
    return refs.filter((ref) => !ref.scope.startsWith('project:') || (
      ref.workspacePath && trusted.has(workspacePathKey(ref.workspacePath))
    ));
  }

  private trustedProjectFiles(refs: Array<ScopeFileRef & { corrupt?: string }>): string[] {
    return this.trustedProjectRefs(refs)
      .filter((ref) => ref.scope.startsWith('project:') && ref.workspacePath)
      .map((ref) => ref.file);
  }

  markSourcesDeleted(sessionId: string, workspacePaths: string[] = []): void {
    const changes = new Map<string, string>();
    const updates = new Map<string, { ref: ScopeFileRef; entries: MemoryEntry[]; archived?: boolean }>();
    const discovered = this.allScopeFiles({
      workspacePaths: [...new Set([...workspacePaths, ...this.recoverableProjectWorkspaces()])],
    });
    const conflicts = this.identityConflictsFromDiscovery(discovered);
    if (conflicts.warnings.length) throw new ScopeConflictError(conflicts.warnings.join('；'));
    for (const ref of discovered) {
      if (ref.corrupt) throw new CorruptMemoryError(ref.file, ref.corrupt);
    }
    const refs = this.trustedProjectRefs(discovered);
    const snapshots = this.readVerifiedScopeSnapshots(refs);
    for (const ref of refs) {
      const snapshot = snapshots.get(truthPathKey(ref.file));
      if (!snapshot) continue;
      const parsed: MemoryFileV1 | ProjectMemoryFileV1 = ref.scope.startsWith('project:')
        ? { version: 1, projectId: snapshot.projectId!, archived: snapshot.archived!, entries: snapshot.entries }
        : { version: 1, entries: snapshot.entries };
      let dirty = false;
      const entries = parsed.entries.filter((entry) => {
        if (entry.source?.sessionId !== sessionId && ref.file !== episodeProposalFile(this.dataDir, sessionId)) return true;
        dirty = true;
        if (entry.status === 'pending') return false;
        entry.source = { ...entry.source, sessionId, kind: entry.source?.kind ?? 'consolidated', excerpt: '来源已删除' };
        return true;
      });
      if (!dirty) continue;
      changes.set(ref.file, `${JSON.stringify({ ...parsed, entries }, null, 2)}\n`);
      updates.set(ref.file, { ref, entries, archived: snapshot.archived });
    }
    const identities = commitTruthBatch(this.dataDir, changes, {
      projectFiles: this.trustedProjectFiles(refs),
      probeAttributes: this.probeAttributes,
    });
    this.indexCommittedScopes(changes, updates, identities, refs);
  }

  entriesForSession(sessionId: string, workspacePaths: string[] = []): MemoryEntry[] {
    const refs = this.allScopeFiles({ workspacePaths: [...workspacePaths, ...this.recoverableProjectWorkspaces()] });
    return this.readAllTruth(refs)
      .filter(({ ref, entry }) => entry.source?.sessionId === sessionId || ref.file === episodeProposalFile(this.dataDir, sessionId))
      .map(({ entry }) => entry);
  }

  preflightDeleteBySession(sessionId: string, workspacePaths: string[] = []): PrivacyDeletePreflight {
    const discovered = this.allScopeFiles({
      workspacePaths: [...workspacePaths, ...this.recoverableProjectWorkspaces()],
    });
    for (const ref of discovered) {
      if (ref.corrupt) throw new CorruptMemoryError(ref.file, ref.corrupt);
    }
    const conflicts = this.identityConflictsFromDiscovery(discovered);
    if (conflicts.warnings.length) throw new ScopeConflictError(conflicts.warnings.join('；'));
    const refs = this.trustedProjectRefs(discovered);
    const doomed = refs.flatMap((ref) => {
      const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
      return (snapshot?.entries ?? [])
        .filter((entry) => entry.source?.sessionId === sessionId || ref.file === episodeProposalFile(this.dataDir, sessionId))
        .map((entry) => entry);
    });
    const episodePath = episodesFile(this.dataDir);
    const extractionPath = extractionStateFile(this.dataDir);
    const [episodeSnapshot, extractionSnapshot] = this.readAuxTruthSnapshots([episodePath, extractionPath]);
    const episodes = episodeSnapshot ? this.parseEpisodesTruth(episodeSnapshot.text, episodePath) : [];
    const states = extractionSnapshot ? parseExtractionStates(extractionSnapshot.text, extractionPath) : {};
    const snapshots = refs.flatMap((ref) => {
      const snapshot = this.truthSnapshots.get(truthPathKey(ref.file));
      return snapshot ? [{ ref, snapshot }] : [];
    });
    return { refs, doomed, episodes, states, snapshots, episodeSnapshot, extractionSnapshot };
  }

  deleteMemoryEntriesBySession(sessionId: string, onRemove?: (entry: MemoryEntry) => void, workspacePaths: string[] = [], texts: string[] = [], preflight?: PrivacyDeletePreflight): string[] {
    const changes = new Map<string, string>();
    const updates = new Map<string, { ref: ScopeFileRef; entries: MemoryEntry[]; archived?: boolean }>();
    const removed: string[] = [];
    const values = [...new Set(texts.filter((text) => text.trim().length > 0))];
    const { refs, episodes, states, snapshots, episodeSnapshot, extractionSnapshot } = preflight ?? this.preflightDeleteBySession(sessionId, workspacePaths);
    const snapshotByRef = new Map(snapshots.map(({ ref, snapshot }) => [ref, snapshot]));
    if (values.length) this.redactions.register(values);
    const redact = (text: string): string => this.redactions.redact(text);
    // This is the deliberate second read after discovery. Batch only the native
    // probes; each file still has double-lstat pre-read identities, content
    // readback, and a fresh post-read native identity fence.
    const freshReads = readTruthFilesVerified(refs.map((ref) => ({
      path: ref.file,
      allowMissing: true,
      read: (file) => Buffer.from(this.readTruthFile(file)),
    })), this.probeAttributes);
    const freshByRef = new Map<string, TruthFileSnapshot | undefined>();
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const result = freshReads[index];
      const expected = snapshotByRef.get(ref);
      if (expected && (!result || result.identity !== expected.identity || hash(result.content.toString('utf8')) !== expected.contentHash)) {
        throw new TruthSnapshotChangedError(ref.file);
      }
      freshByRef.set(truthPathKey(ref.file), result ? this.snapshotFromVerifiedRead(ref, result) : undefined);
    }
    for (const ref of refs) {
      if (ref.corrupt) throw new CorruptMemoryError(ref.file, ref.corrupt);
      const snapshot = freshByRef.get(truthPathKey(ref.file));
      if (!snapshot) continue;
      const parsed: MemoryFileV1 | ProjectMemoryFileV1 = ref.scope.startsWith('project:')
        ? { version: 1, projectId: snapshot.projectId!, archived: snapshot.archived!, entries: snapshot.entries }
        : { version: 1, entries: snapshot.entries };
      let dirty = false;
      const entries: MemoryEntry[] = [];
      for (const entry of parsed.entries) {
        if (entry.source?.sessionId !== sessionId && ref.file !== episodeProposalFile(this.dataDir, sessionId)) {
          const scrubbed = this.redactEntryForPrivacy(entry);
          if (JSON.stringify(scrubbed) !== JSON.stringify(entry)) dirty = true;
          entries.push(scrubbed);
          continue;
        }
        dirty = true;
        removed.push(entry.id);
        onRemove?.(entry);
      }
      if (!dirty) continue;
      changes.set(ref.file, `${JSON.stringify({ ...parsed, entries }, null, 2)}\n`);
      updates.set(ref.file, { ref, entries, archived: snapshot.archived });
    }
    const episodePath = episodesFile(this.dataDir);
    const statePath = extractionStateFile(this.dataDir);
    const auxReads = readTruthFilesVerified([
      { path: episodePath, allowMissing: true, read: (file) => Buffer.from(this.readTruthFile(file)) },
      { path: statePath, allowMissing: true, read: (file) => Buffer.from(this.readTruthFile(file)) },
    ], this.probeAttributes);
    for (const [index, path, snapshot] of [
      [0, episodePath, episodeSnapshot],
      [1, statePath, extractionSnapshot],
    ] as const) {
      const current = auxReads[index];
      if (snapshot) {
        if (!current || current.identity !== snapshot.identity || hash(current.content.toString('utf8')) !== snapshot.contentHash) {
          throw new TruthSnapshotChangedError(path);
        }
      } else if (current) throw new TruthSnapshotChangedError(path);
    }
    if (episodeSnapshot) {
      const kept = episodes.filter((episode) => episode.sessionId !== sessionId)
        .map((episode) => this.redactEpisodeForPrivacy(episode));
      const content = kept.length ? `${kept.map((episode) => JSON.stringify(episode)).join('\n')}\n` : '';
      this.assertPrivacyValues(content);
      changes.set(episodePath, content);
    }
    if (extractionSnapshot) {
      delete states[sessionId];
      changes.set(statePath, redact(`${JSON.stringify(states, null, 2)}\n`));
    }
    const identities = commitTruthBatch(this.dataDir, changes, {
      projectFiles: this.trustedProjectFiles(refs),
      probeAttributes: this.probeAttributes,
    });
    this.indexCommittedScopes(changes, updates, identities, refs);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rejected_hashes WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM extraction_state WHERE session_id = ?').run(sessionId);
    });
    tx();
    this.compact();
    return [...new Set(removed)];
  }
}
