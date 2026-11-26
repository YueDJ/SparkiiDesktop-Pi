import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Logger } from '../logger.js';
import type { ErrorStore } from '../error-store.js';
import { MemoryStore, CorruptMemoryError, ScopeConflictError, TruthSnapshotChangedError, parseMemoryFile, parseProjectMemoryFile, type ScopeFileRef, type TruthReconciliation } from './store.js';
import {
  agentMemoryFile,
  atomicWrite,
  episodesFile,
  episodeProposalFile,
  extractionStateFile,
  loadMemorySettings,
  loadProjectRegistry,
  memoryDir,
  normalizeWorkspacePath,
  parseProjectRegistry,
  projectMemoryFile,
  projectRegistryFile,
  readProjectRegistry,
  saveMemorySettings,
  upsertProjectRef,
  upsertProjectRefInRegistry,
} from './settings.js';
import { assertTruthAvailable, assertTruthRootSafe, commitTruthBatch, recoverTruthBatch, TruthPathSafetyError, truthPathKey, type TruthBatchOptions } from './truth-batch.js';
import { assertTruthPathSafe, inspectTruthFile, inspectTruthFiles, inspectTruthFilesTwice, readTruthFilesVerified, readTruthFileVerified, removeTruthPathVerified, truthFileIdentity, type TruthAttributeProbe } from './truth-path.js';
import { isPendingSchemaKey, isPendingStructuralFieldValid, newMemoryId, normalizeTextHash } from './types.js';
import type {
  MemoryEntry,
  MemoryEntryView,
  EpisodeRecord,
  MemoryListResult,
  MemoryScopeKind,
  MemorySearchHit,
  MemorySettings,
  ProjectMemoryFileV1,
  ScopeView,
} from './types.js';
import { buildMemoryBlock, halfLifeFor, selectWithinBudget } from './scoring.js';

export interface MemoryServiceDeps {
  dataDir: string;
  errors?: ErrorStore;
  logger?: Logger;
  audit?: { redactTexts(texts: string[]): unknown };
  gate?: { redactTexts(texts: string[]): unknown };
  now?: () => number;
  forceLike?: boolean;
  sessionExists?: (sessionId: string) => boolean;
  sessionFileOf?: (sessionId: string) => string | undefined;
  workspacePathOf?: (sessionId: string) => string | undefined;
  workspacePathsOf?: () => string[];
  projectWorkspacePathsOf?: () => string[];
  probeAttributes?: TruthAttributeProbe;
  removePath?: TruthBatchOptions['removePath'];
  registerChatSessionRedactions?: (texts: string[]) => void;
  deleteChatSession?: (sessionId: string, texts?: string[]) => void;
  agents?: () => Array<{ id: string; name: string }>;
  emit?: (type: 'pending_added' | 'memory_changed' | 'repair_needed', payload: Record<string, unknown>) => void;
}

export interface AddMemoryRequest {
  /** 'user' | 'agent:<id>' | 'project:<projectId>' | 'agent' | 'project' */
  scope: string;
  text: string;
  pinned?: boolean;
  agentId?: string;
  workspacePath?: string;
  workspaceKind?: 'auto' | 'user';
  sessionId?: string;
  excerpt?: string;
  importance?: number;
  status?: 'active' | 'pending';
  sourceKind?: 'extracted' | 'explicit' | 'consolidated';
  pendingOp?: MemoryEntry['pendingOp'];
}

function pendingContentTexts(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => pendingContentTexts(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...pendingContentTexts(nested)]);
  }
  return [];
}

function pendingOperationTexts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    if ((key === 'op' || key === 'degradedFrom') && isPendingStructuralFieldValid(key, nested)) return [];
    if (isPendingSchemaKey(key)) return pendingContentTexts(nested);
    return [key, ...pendingContentTexts(nested)];
  });
}

function normalizePrivacyTexts(texts: string[]): string[] {
  return [...new Set(texts.filter((text) => text.trim().length > 0))];
}

/** 平台层记忆编排：文件真相源 + 派生索引 + 注入 + 确认队列。 */
export class MemoryService {
  readonly store: MemoryStore;
  private settings: MemorySettings;
  private readonly deps: MemoryServiceDeps;
  private readonly now: () => number;
  private readonly generations = new Map<string, number>();
  private readonly deletedSessions = new Set<string>();
  private readonly pendingPrivacyTexts = new Map<string, string[]>();
  private readonly pendingPrivacyWorkspaces = new Map<string, string[]>();
  private readonly pendingPrivacyMemorySessions = new Map<string, string>();
  private readonly completedPrivacyMemorySessions = new Map<string, string>();
  private readonly pendingPrivacyMemoryIds = new Map<string, Set<string>>();
  private readonly pendingPrivacyJournalIdentities = new Map<string, string>();
  private privacyJournalFailure = '';
  private readonly recoveryWarnings: string[] = [];

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    assertTruthRootSafe(deps.dataDir, deps.probeAttributes);
    this.loadPrivacyWriteBlock();
    this.loadPendingPrivacyJournals();
    this.registerPendingPrivacySinks();
    const truthRecoveryWarnings = recoverTruthBatch(deps.dataDir, {
      projectFiles: deps.projectWorkspacePathsOf?.().map((workspacePath) => projectMemoryFile(workspacePath)),
      probeAttributes: deps.probeAttributes,
    });
    this.recoveryWarnings.push(...truthRecoveryWarnings);
    if (truthRecoveryWarnings.length && !this.privacyJournalFailure) this.resumePendingPrivacyCarriers();
    try { this.deps.logger?.redactMemoryPromptLogs(); } catch (error) {
      this.recoveryWarnings.push(`旧记忆提示日志清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    assertTruthAvailable(deps.dataDir, deps.probeAttributes);
    this.store = new MemoryStore({
      dataDir: deps.dataDir,
      probeAttributes: deps.probeAttributes,
      errors: deps.errors,
      now: this.now,
      forceLike: deps.forceLike,
      unavailable: () => this.privacyUnavailableWarnings(),
    });
    this.settings = loadMemorySettings(deps.dataDir);
    this.recoveryWarnings.push(...this.store.recoveryWarnings);
    if (!this.privacyJournalFailure) this.resumePendingPrivacy();
  }

  privacyDeletePending(sessionId: string): boolean {
    return this.pendingPrivacyTexts.has(sessionId);
  }

  private privacyUnavailableWarnings(): string[] {
    if (this.privacyJournalFailure) return [this.privacyJournalFailure];
    return this.pendingPrivacyTexts.size
      ? ['隐私删除尚未完成，记忆读取已阻断']
      : [];
  }

  private registerPendingPrivacySinks(): void {
    for (const [sessionId, texts] of this.pendingPrivacyTexts) {
      const failures: Array<() => unknown> = [
        () => this.deps.gate?.redactTexts(texts),
        () => this.deps.audit?.redactTexts(texts),
        () => this.deps.errors?.redactTexts(texts),
        () => this.deps.registerChatSessionRedactions?.(texts),
        () => this.deps.logger?.redactSession(sessionId, texts),
      ];
      for (const operation of failures) {
        try { operation(); } catch { /* the pending journal keeps cleanup retryable */ }
      }
    }
  }

  private resumePendingPrivacyCarriers(): void {
    for (const [sessionId, texts] of [...this.pendingPrivacyTexts]) {
      try {
        this.cleanupPrivacyCarriers(sessionId, texts);
      } catch (error) {
        this.recoveryWarnings.push(`隐私会话载体清理未完成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private cleanupPrivacyCarriers(sessionId: string, texts: string[]): void {
    const file = this.deps.sessionFileOf?.(sessionId);
    if (file) {
      if (!isAbsolute(file)) throw new Error('隐私会话载体路径必须是绝对路径');
      this.assertPrivacyPathSafe(file);
      let before;
      try {
        before = lstatSync(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (before) {
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
          throw new Error('隐私会话载体不是普通单链接文件');
        }
        const identity = `${before.dev}:${before.ino}:${before.mode}:${before.nlink}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
        this.assertPrivacyPathSafe(file);
        const immediatelyBefore = lstatSync(file, { bigint: true });
        if (!immediatelyBefore.isFile() || immediatelyBefore.isSymbolicLink() || immediatelyBefore.nlink !== 1n
          || `${immediatelyBefore.dev}:${immediatelyBefore.ino}:${immediatelyBefore.mode}:${immediatelyBefore.nlink}:${immediatelyBefore.size}:${immediatelyBefore.mtimeNs}:${immediatelyBefore.ctimeNs}` !== identity) {
          throw new Error('隐私会话载体身份已变化');
        }
        (this.deps.removePath ?? rmSync)(file, { force: false });
        this.assertPrivacyPathSafe(file);
        try {
          lstatSync(file, { bigint: true });
          throw new Error('隐私会话载体清理失败');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    this.deps.deleteChatSession?.(sessionId, texts);
  }

  private truthRecoveryBlocked(): boolean {
    try {
      assertTruthAvailable(this.deps.dataDir, this.deps.probeAttributes);
      return false;
    } catch {
      return true;
    }
  }

  private resumePendingPrivacy(): void {
    for (const [sessionId, workspacePaths] of [...this.pendingPrivacyWorkspaces]) {
      const memoryIds = [...(this.pendingPrivacyMemoryIds.get(sessionId) ?? [])];
      try {
        this.privacyDeleteBySession(sessionId, workspacePaths, memoryIds[0]);
        for (const id of memoryIds) this.completedPrivacyMemorySessions.set(id, sessionId);
      } catch (error) {
        this.recoveryWarnings.push(`隐私删除恢复未完成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** registerIpc 装配后接上 renderer 事件通道；主进程逻辑不依赖窗口存在。 */
  setEmitter(fn: (type: 'pending_added' | 'memory_changed' | 'repair_needed', payload: Record<string, unknown>) => void): void {
    this.deps.emit = fn;
    for (const detail of this.recoveryWarnings) this.emit('repair_needed', { file: 'memory', detail });
  }

  getSettings(): MemorySettings { return structuredClone(this.settings); }

  saveSettings(partial: Partial<MemorySettings>): MemorySettings {
    this.settings = saveMemorySettings(this.deps.dataDir, partial);
    return this.getSettings();
  }

  get ftsAvailable(): boolean { return this.store.ftsAvailable; }
  get sqliteVersion(): string { return this.store.sqliteVersion; }

  extractionGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  invalidateExtraction(sessionId: string): number {
    const generation = this.extractionGeneration(sessionId) + 1;
    this.generations.set(sessionId, generation);
    return generation;
  }

  assertExtractionCurrent(sessionId: string, generation: number): void {
    if (this.deletedSessions.has(sessionId) || this.extractionGeneration(sessionId) !== generation) {
      throw new Error(`memory-session-invalidated:${sessionId}`);
    }
    if (this.deps.sessionExists && !this.sessionExists(sessionId)) {
      this.invalidateExtraction(sessionId);
      throw new Error(`memory-session-invalidated:${sessionId}`);
    }
  }

  synchronize(): string[] {
    return this.synchronizeWithTruth().warnings;
  }

  private synchronizeWithTruth(): { truth?: TruthReconciliation; warnings: string[] } {
    try { this.store.assertReadAvailable(); } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { file: 'memory.db', detail });
      throw error;
    }
    try {
      const truth = this.store.reconcileAllWithTruth();
      return { truth, warnings: truth.warnings };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { file: 'memory.db', detail });
      return { warnings: [detail] };
    }
  }

  private truthWorkspacePaths(extra: string[] = []): string[] {
    return [...new Set([
      ...extra,
      ...(this.deps.workspacePathsOf?.() ?? []),
      ...this.store.recoverableProjectWorkspaces(),
    ].filter((workspacePath) => workspacePath.length > 0))];
  }

  private sessionExists(id: string): boolean {
    return this.deps.sessionExists?.(id) ?? false;
  }

  private emit(type: 'pending_added' | 'memory_changed' | 'repair_needed', payload: Record<string, unknown>): void {
    this.deps.emit?.(type, payload);
  }

  private scopeLabel(ref: ScopeFileRef): string {
    if (ref.scope === 'user') return '用户记忆';
    if (ref.scope.startsWith('agent:')) return `智能体习惯 · ${ref.scope.slice(6)}`;
    return `项目记忆 · ${ref.workspacePath ?? ref.projectId ?? ''}`;
  }

  private scopeKind(scope: string): MemoryScopeKind {
    if (scope === 'user') return 'user';
    if (scope.startsWith('agent:')) return 'agent';
    if (scope.startsWith('project:')) return 'project';
    return 'episode';
  }

  /**
   * 会话打开时的项目自愈：文件在、索引没跟上（搬迁/新索引）则按 projectId 重索引。
   * auto 工作区不建项目层，绝不在这里创建文件。
   */
  ensureProject(workspacePath: string | undefined, workspaceKind?: 'auto' | 'user'): ScopeFileRef | null {
    this.store.assertReadAvailable();
    if (!workspacePath || workspaceKind !== 'user') return null;
    const normalized = normalizeWorkspacePath(workspacePath);
    const file = projectMemoryFile(workspacePath);
    let existing;
    try {
      existing = inspectTruthFile(file, this.deps.probeAttributes, { allowMissing: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { workspacePath, file, detail });
      return null;
    }
    if (!existing) return null;
    let parsed: ProjectMemoryFileV1;
    try {
      parsed = parseProjectMemoryFile(readTruthFileVerified(file, { probeAttributes: this.deps.probeAttributes }).toString('utf8'), file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { workspacePath, file, detail });
      return null;
    }
    let ref: ScopeFileRef;
    try {
      upsertProjectRef(this.deps.dataDir, {
        projectId: parsed.projectId,
        workspacePath: normalizeWorkspacePath(workspacePath),
        archived: parsed.archived,
      });
      ref = {
        scope: `project:${parsed.projectId}`,
        file,
        projectId: parsed.projectId,
        workspacePath: normalizeWorkspacePath(workspacePath),
        archived: parsed.archived,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { scope: `project:${parsed.projectId}`, file, workspacePath: normalized, detail });
      return null;
    }
    this.synchronize();
    return ref;
  }

  /** 提炼候选解析实际 scope；auto 工作区的项目候选归用户层。 */
  previewScope(ctx: { profileId: string; workspacePath?: string; workspaceKind?: 'auto' | 'user' }, scope: string): string | null {
    this.store.assertReadAvailable();
    if (scope === 'user') return 'user';
    if (scope === 'agent') return `agent:${ctx.profileId}`;
    if (scope === 'project') {
      if (ctx.workspaceKind !== 'user' || !ctx.workspacePath) return 'user';
      const file = projectMemoryFile(ctx.workspacePath);
      if (!inspectTruthFile(file, this.deps.probeAttributes, { allowMissing: true })) return `project:proj_${newMemoryId().slice(4)}`;
      try {
        return `project:${parseProjectMemoryFile(readTruthFileVerified(file, { probeAttributes: this.deps.probeAttributes }).toString('utf8'), file).projectId}`;
      } catch {
        return null;
      }
    }
    return null;
  }

  private userRef(): ScopeFileRef {
    return { scope: 'user', file: join(memoryDir(this.deps.dataDir), 'user.json') };
  }

  private agentRef(agentId: string): ScopeFileRef {
    if (!agentId || /[\\/]/.test(agentId)) throw new Error('agentId 非法');
    return { scope: `agent:${agentId}`, file: agentMemoryFile(this.deps.dataDir, agentId) };
  }

  /** 把外部传入的 scope 解析成真相源文件；新建项目记忆仅限 user 工作区。 */
  private resolveScope(req: AddMemoryRequest): ScopeFileRef {
    const raw = String(req.scope ?? 'user');
    if (raw === 'user') return this.userRef();
    if (raw.startsWith('episode:')) {
      const sessionId = raw.slice('episode:'.length);
      if (!sessionId || /[\\/]/.test(sessionId)) throw new Error('会话 id 非法');
      return { scope: raw, file: episodeProposalFile(this.deps.dataDir, sessionId) };
    }
    if (raw === 'agent' || raw.startsWith('agent:')) {
      const agentId = raw.startsWith('agent:') ? raw.slice(6) : String(req.agentId ?? '');
      if (this.deps.agents && !this.deps.agents().some((agent) => agent.id === agentId)) {
        throw new Error(`智能体不存在：${agentId}`);
      }
      return this.agentRef(agentId);
    }
    if (raw === 'project' || raw.startsWith('project:')) {
      const path = String(req.workspacePath ?? '').trim();
      if (!path) throw new Error('项目记忆需要工作区路径');
      if (req.workspaceKind !== 'user') throw new Error('临时工作区不建立项目记忆');
      const file = projectMemoryFile(path);
      if (inspectTruthFile(file, this.deps.probeAttributes, { allowMissing: true })) {
        const parsed = parseProjectMemoryFile(readTruthFileVerified(file, { probeAttributes: this.deps.probeAttributes }).toString('utf8'), file);
        const ref: ScopeFileRef = {
          scope: `project:${parsed.projectId}`, file,
          projectId: parsed.projectId, workspacePath: normalizeWorkspacePath(path), archived: parsed.archived,
        };
        return ref;
      }
      const projectId = raw.startsWith('project:') && raw.slice(8)
        ? raw.slice(8)
        : `proj_${newMemoryId().slice(4)}`;
      return {
        scope: `project:${projectId}`, file, projectId,
        workspacePath: normalizeWorkspacePath(path), archived: false,
      };
    }
    throw new Error(`未知记忆层级：${raw}`);
  }

  private stageProjectRef(changes: Map<string, string>, ref: ScopeFileRef, archived?: boolean): void {
    const path = projectRegistryFile(this.deps.dataDir);
    const staged = changes.get(path);
    const registry = staged !== undefined
      ? parseProjectRegistry(staged, path)
      : readProjectRegistry(this.deps.dataDir);
    const next = upsertProjectRefInRegistry(registry, {
      projectId: ref.projectId!, workspacePath: ref.workspacePath!,
      archived: archived ?? ref.archived,
    });
    changes.set(path, `${JSON.stringify(next, null, 2)}\n`);
  }

  private writeRef(ref: ScopeFileRef, entries: MemoryEntry[], archived?: boolean): void {
    entries = entries.map((entry) => this.store.redactEntryForPrivacy(entry));
    const changes = new Map<string, string>();
    let content: string;
    if (ref.scope.startsWith('project:')) {
      const payload: ProjectMemoryFileV1 = {
        version: 1,
        projectId: ref.projectId!,
        ...(archived !== undefined ? { archived } : {}),
        entries,
      };
      content = `${JSON.stringify(payload, null, 2)}\n`;
      changes.set(ref.file, content);
      this.stageProjectRef(changes, ref, archived);
    } else {
      content = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
      changes.set(ref.file, content);
    }
    const identities = commitTruthBatch(this.deps.dataDir, changes, { probeAttributes: this.deps.probeAttributes });
    const identity = identities.get(ref.file);
    const snapshot = identity ? {
      text: content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      entries,
      ...(ref.projectId ? { projectId: ref.projectId } : {}),
      ...(archived !== undefined ? { archived } : {}),
      identity,
    } : undefined;
    try { this.store.replaceScopeIndex(ref, entries, archived, snapshot); } catch (error) {
      this.emit('repair_needed', { scope: ref.scope, file: ref.file, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  private readRef(ref: ScopeFileRef): { entries: MemoryEntry[]; archived?: boolean } {
    const snapshot = this.store.readScopeSnapshot(ref);
    if (!snapshot) return { entries: [] };
    return { entries: snapshot.entries, archived: snapshot.archived };
  }

  private view(row: ReturnType<MemoryStore['rowFor']>): MemoryEntryView | null {
    if (!row) return null;
    return this.store.viewOf(row, (id) => this.sessionExists(id));
  }

  /** 记忆块在鞍文本末尾追加；注入只 +accessCount，不重置衰减时钟。 */
  buildBlock(ctx: { sessionId?: string; profileId: string; workspacePath?: string; workspaceKind?: 'auto' | 'user' }): string {
    if (!this.settings.enabled) return '';
    this.synchronize();
    let identity: ReturnType<MemoryStore['identityConflicts']>;
    try {
      identity = this.store.identityConflicts(this.store.allScopeFiles());
    } catch (error) {
      this.emit('repair_needed', { file: 'memory', detail: error instanceof Error ? error.message : String(error) });
      return '';
    }
    if (identity.warnings.length) {
      this.emit('repair_needed', { file: 'memory', detail: identity.warnings.join('；') });
      return '';
    }
    const sections: Array<{ kind: MemoryScopeKind; scope: string; ref: ScopeFileRef; entries: MemoryEntry[]; archived?: boolean }> = [];
    const push = (kind: MemoryScopeKind, ref: ScopeFileRef | null) => {
      if (!ref || !existsSync(ref.file)) return;
      try {
        const read = this.readRef(ref);
        if (read.archived) return;
        sections.push({ kind, scope: ref.scope, ref, entries: read.entries, archived: read.archived });
      } catch (error) {
        if (error instanceof CorruptMemoryError) {
          this.emit('repair_needed', {
            scope: ref.scope, file: ref.file,
            workspacePath: ref.workspacePath, detail: error.message,
          });
          return;
        }
        throw error;
      }
    };
    push('user', this.userRef());
    push('agent', this.agentRef(ctx.profileId));
    if (ctx.workspacePath && ctx.workspaceKind === 'user') {
      push('project', this.ensureProject(ctx.workspacePath, ctx.workspaceKind));
    }
    const blocks: Array<{ kind: MemoryScopeKind; scope: string; items: Array<{ text: string; updatedAt: number }> }> = [];
    for (const section of sections) {
      const active = section.entries.filter((e) => e.status === 'active');
      const usage = active.map((e) => ({ entry: e, usage: this.store.usageFor(e.id) }));
      const result = selectWithinBudget(usage, {
        now: this.now(),
        halfLifeDays: halfLifeFor(this.settings, section.kind),
        budget: this.settings.budgets[section.kind as 'user' | 'agent' | 'project'],
      });
      this.store.touchAccess(result.selected.map((s) => s.entry.id), false);
      blocks.push({
        kind: section.kind,
        scope: section.scope,
        items: result.selected.map((s) => ({ text: s.entry.text, updatedAt: s.entry.updatedAt })),
      });
    }
    const block = buildMemoryBlock(blocks);
    if (block && this.deps.logger) {
      void this.deps.logger.log({
        level: 'info',
        msg: 'memory prompt block appended to saddle',
        ctx: {
          sessionId: ctx.sessionId ?? '', agentId: ctx.profileId,
          workspacePath: ctx.workspacePath ?? '', sections: blocks.length,
          characters: block.length,
        },
      });
    }
    return block;
  }

  list(): MemoryListResult {
    const synchronized = this.synchronizeWithTruth();
    const warnings = [...this.recoveryWarnings, ...synchronized.warnings];
    let refs: Array<ScopeFileRef & { corrupt?: string }>;
    let snapshots: Map<string, ReturnType<MemoryStore['readScopeSnapshot']>> | undefined;
    let identity: ReturnType<MemoryStore['identityConflicts']>;
    if (synchronized.truth) {
      refs = synchronized.truth.refs;
      snapshots = synchronized.truth.snapshots;
      identity = synchronized.truth.identity;
    } else {
      try {
        refs = this.store.allScopeFiles();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.emit('repair_needed', { file: projectRegistryFile(this.deps.dataDir), detail });
        if (!warnings.includes(detail)) warnings.push(detail);
        refs = this.store.allScopeFiles({ strictProjects: false });
      }
      identity = this.store.identityConflicts(refs);
    }
    warnings.push(...identity.warnings);
    const blockedFiles = new Set([...identity.projectFiles, ...identity.idFiles]);
    const scopes: ScopeView[] = refs.map((ref) => {
      const kind = this.scopeKind(ref.scope);
      const base: ScopeView = {
        scope: ref.scope,
        kind,
        label: ref.scope.startsWith('episode:') ? `会话摘要提案 · ${ref.scope.slice(8)}` : this.scopeLabel(ref),
        ...(kind === 'agent' ? { agentId: ref.scope.slice(6) } : {}),
        ...(ref.projectId ? { projectId: ref.projectId } : {}),
        ...(ref.workspacePath ? { workspacePath: ref.workspacePath } : {}),
        ...(ref.archived !== undefined ? { archived: ref.archived } : {}),
        ...(ref.corrupt ? { corrupt: true } : {}),
        entries: [],
      };
      if (ref.corrupt) {
        warnings.push(`${base.label} 记忆文件损坏，已停止注入；请在设置页修复`);
        return base;
      }
      if (blockedFiles.has(ref.file)) {
        warnings.push(`${base.label} 记忆身份冲突，已停止列出和注入；请修复重复内容`);
        return { ...base, warning: '记忆身份冲突，已停止列出和注入' };
      }
      const read = snapshots
        ? { entries: snapshots.get(truthPathKey(ref.file))?.entries ?? [], archived: snapshots.get(truthPathKey(ref.file))?.archived }
        : this.readRef(ref);
      const entries: MemoryEntryView[] = read.entries.map((entry) => ({
        ...entry,
        scope: ref.scope,
        usage: this.store.usageFor(entry.id),
        sourceDeleted: Boolean(entry.source?.sessionId && !this.sessionExists(entry.source.sessionId)),
        ...(ref.projectId ? { projectId: ref.projectId } : {}),
        ...(ref.workspacePath ? { workspacePath: ref.workspacePath } : {}),
      }));
      const active = entries.filter((e) => e.status === 'active');
      const result = selectWithinBudget(
        active.map((e) => ({ entry: e, usage: e.usage })),
        {
          now: this.now(),
          halfLifeDays: halfLifeFor(this.settings, kind),
          budget: this.settings.budgets[kind as 'user' | 'agent' | 'project'] ?? 500,
        },
      );
      if (result.warning) warnings.push(`${base.label}：${result.warning}`);
      return { ...base, archived: read.archived ?? base.archived, warning: result.warning, entries };
    });
    const pending = scopes.flatMap((scope) => scope.entries.filter((e) => e.status === 'pending'));
    return {
      scopes,
      pending,
      agents: this.deps.agents?.() ?? [],
      projects: loadProjectRegistry(this.deps.dataDir).projects,
      settings: this.getSettings(),
      ftsAvailable: this.ftsAvailable,
      warnings,
    };
  }

  addMemory(req: AddMemoryRequest): MemoryEntryView {
    if (!this.settings.enabled) throw new Error('记忆功能已关闭');
    if (req.sessionId && (
      this.deletedSessions.has(req.sessionId)
      || (req.scope.startsWith('episode:') && !this.sessionExists(req.sessionId))
    )) {
      throw new Error('来源会话已删除，不能写入记忆');
    }
    const synchronized = this.synchronizeWithTruth();
    const ref = this.resolveScope(req);
    let identity = synchronized.truth?.identity ?? { warnings: synchronized.warnings, projectFiles: new Set<string>(), idFiles: new Set<string>() };
    if (synchronized.truth && ref.scope.startsWith('project:')
      && !synchronized.truth.refs.some((candidate) => truthPathKey(candidate.file) === truthPathKey(ref.file))) {
      identity = this.store.identityConflicts(this.store.allScopeFiles({
        workspacePaths: [...this.store.recoverableProjectWorkspaces(), ...(ref.workspacePath ? [ref.workspacePath] : [])],
      }));
    }
    if (identity.warnings.length) throw new ScopeConflictError(identity.warnings.join('；'));
    const text = String(req.text ?? '').trim();
    if (!text || text.length > 200) throw new Error('记忆内容需为 1–200 字');
    const { entries, archived } = this.readRef(ref);
    const idempotencyKey = req.pendingOp?.idempotencyKey;
    if (idempotencyKey) {
      const existing = entries.find((entry) => entry.status === 'pending' && entry.pendingOp?.idempotencyKey === idempotencyKey);
      if (existing) return this.view(this.store.indexedRowFor(existing.id) ?? this.store.rowFor(existing.id))!;
    }
    const ts = this.now();
    const entry: MemoryEntry = {
      id: newMemoryId(),
      text,
      status: req.status ?? 'active',
      pinned: req.pinned === true,
      importance: req.importance ?? (req.pinned ? 3 : 2),
      createdAt: ts,
      updatedAt: ts,
      source: req.sessionId
        ? { sessionId: req.sessionId, excerpt: String(req.excerpt ?? text).slice(0, 120), kind: req.sourceKind ?? 'explicit' }
        // 整合提案不来自某次会话：留空 sessionId 只作来源说明，不参与按会话清理。
        : req.sourceKind === 'consolidated'
          ? { sessionId: '', excerpt: String(req.excerpt ?? '整合提案').slice(0, 120), kind: 'consolidated' }
          : null,
      supersededBy: null,
      pendingOp: req.pendingOp ?? null,
    };
    entries.push(entry);
    this.writeRef(ref, entries, archived);
    if (entry.status === 'pending') this.emit('pending_added', { id: entry.id, scope: ref.scope });
    else this.emit('memory_changed', { id: entry.id, scope: ref.scope, op: 'add' });
    return this.view(this.store.indexedRowFor(entry.id) ?? this.store.rowFor(entry.id))!;
  }

  addMemoriesBatch(
    requests: AddMemoryRequest[],
    commit?: {
      generation?: { sessionId: string; value: number };
      episode?: EpisodeRecord;
      extractionState?: { sessionId: string; lastEntryId: string; userTurnsSince: number };
    },
  ): { ids: string[]; skipped: number } {
    if (!this.settings.enabled) throw new Error('记忆功能已关闭');
    this.synchronize();
    const identity = this.store.identityConflicts(this.store.allScopeFiles({
      workspacePaths: [
        ...this.store.recoverableProjectWorkspaces(),
        ...requests.map((req) => String(req.workspacePath ?? '').trim()).filter(Boolean),
      ],
    }));
    if (identity.warnings.length) throw new ScopeConflictError(identity.warnings.join('；'));
    if (commit?.generation) this.assertExtractionCurrent(commit.generation.sessionId, commit.generation.value);
    const staged = new Map<string, { ref: ScopeFileRef; entries: MemoryEntry[]; archived?: boolean; base: Record<string, unknown> }>();
    const ids: string[] = [];
    let skipped = 0;
    const ts = this.now();
    for (const req of requests) {
      const text = String(req.text ?? '').trim();
      if (!text || text.length > 200) throw new Error('记忆内容需为 1–200 字');
      const ref = this.resolveScope(req);
      const bucketKey = truthPathKey(ref.file);
      let bucket = staged.get(bucketKey);
      if (!bucket) {
        const read = this.readRef(ref);
        bucket = {
          ref, entries: [...read.entries], archived: read.archived,
          base: ref.scope.startsWith('project:') ? { version: 1, projectId: ref.projectId } : { version: 1 },
        };
        staged.set(bucketKey, bucket);
      }
      const idempotencyKey = req.pendingOp?.idempotencyKey;
      if (idempotencyKey && bucket.entries.some((entry) => entry.status === 'pending' && entry.pendingOp?.idempotencyKey === idempotencyKey)) {
        skipped += 1;
        continue;
      }
      const op = req.pendingOp?.op;
      if (op === 'EPISODE_UPDATE') {
        const sessionId = String(req.pendingOp?.targetId ?? '');
        const proposedText = String(req.pendingOp?.proposedText ?? '').trim();
        if (ref.scope !== `episode:${sessionId}` || !sessionId || !this.store.listEpisodes().some((episode) => episode.sessionId === sessionId)) {
          throw new Error('待确认会话缺失或跨文件');
        }
        if (!proposedText || proposedText.length > 40) throw new Error('提议摘要需为 1–40 字');
      } else if (op && op !== 'ADD') {
        const targetId = String(req.pendingOp?.targetId ?? '');
        const target = targetId ? bucket.entries.find((entry) => entry.id === targetId) : undefined;
        const targetRow = targetId ? this.store.indexedRowFor(targetId) : undefined;
        if (!target || target.status !== 'active' || !targetRow || truthPathKey(targetRow.file_ref) !== bucketKey || targetRow.scope !== bucket.ref.scope) {
          throw new Error(`待确认目标缺失、未生效或跨文件：${targetId || '(empty)'}`);
        }
        const proposedText = String(req.pendingOp?.proposedText ?? '').trim();
        if (!proposedText || proposedText.length > 200) throw new Error('提议内容需为 1–200 字');
        if (req.pendingOp?.mergeIds !== undefined) {
          if (!Array.isArray(req.pendingOp.mergeIds) || !req.pendingOp.mergeIds.every((value) => typeof value === 'string')) {
            throw new Error('mergeIds 结构非法');
          }
          for (const mergeId of req.pendingOp.mergeIds) {
            const sibling = bucket.entries.find((entry) => entry.id === mergeId);
            const siblingRow = this.store.indexedRowFor(mergeId);
            if (!sibling || sibling.status !== 'active' || !siblingRow || truthPathKey(siblingRow.file_ref) !== bucketKey || siblingRow.scope !== bucket.ref.scope) {
              throw new Error(`合并兄弟缺失、未生效或跨文件：${mergeId}`);
            }
          }
        }
      }
      const entry: MemoryEntry = {
        id: newMemoryId(), text, status: req.status ?? 'active', pinned: req.pinned === true,
        importance: req.importance ?? (req.pinned ? 3 : 2), createdAt: ts, updatedAt: ts,
        source: req.sessionId
          ? { sessionId: req.sessionId, excerpt: String(req.excerpt ?? text).slice(0, 120), kind: req.sourceKind ?? 'explicit' }
          : req.sourceKind === 'consolidated'
            ? { sessionId: '', excerpt: String(req.excerpt ?? '整合提案').slice(0, 120), kind: 'consolidated' }
            : null,
        supersededBy: null, pendingOp: req.pendingOp ?? null,
      };
      bucket.entries.push(entry);
      ids.push(entry.id);
    }
    if (commit?.generation) this.assertExtractionCurrent(commit.generation.sessionId, commit.generation.value);
    const changes = new Map<string, string>();
    for (const bucket of staged.values()) {
      changes.set(bucket.ref.file, `${JSON.stringify({
        ...bucket.base,
        ...(bucket.archived !== undefined ? { archived: bucket.archived } : {}),
        entries: bucket.entries.map((entry) => this.store.redactEntryForPrivacy(entry)),
      }, null, 2)}\n`);
      if (bucket.ref.scope.startsWith('project:')) this.stageProjectRef(changes, bucket.ref, bucket.archived);
    }
    const episode = commit?.episode ? this.store.redactEpisodeForPrivacy(commit.episode) : undefined;
    if (episode) {
      const path = episodesFile(this.deps.dataDir);
      const previous = inspectTruthFile(path, this.deps.probeAttributes, { allowMissing: true })
        ? readTruthFileVerified(path, { probeAttributes: this.deps.probeAttributes }).toString('utf8')
        : '';
      changes.set(path, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${JSON.stringify(episode)}\n`);
    }
    if (commit?.extractionState) {
      const states = this.store.extractionStateSnapshot();
      states[commit.extractionState.sessionId] = {
        lastEntryId: commit.extractionState.lastEntryId,
        lastRunAt: ts,
        userTurnsSince: commit.extractionState.userTurnsSince,
      };
      changes.set(extractionStateFile(this.deps.dataDir), `${JSON.stringify(states, null, 2)}\n`);
    }
    commitTruthBatch(this.deps.dataDir, changes, { probeAttributes: this.deps.probeAttributes });
    for (const bucket of staged.values()) {
      try { this.store.replaceScopeIndex(bucket.ref, bucket.entries, bucket.archived); } catch (error) {
        this.emit('repair_needed', { scope: bucket.ref.scope, file: bucket.ref.file, detail: error instanceof Error ? error.message : String(error) });
      }
      for (const entry of bucket.entries.filter((candidate) => ids.includes(candidate.id) && candidate.status === 'pending')) {
        this.emit('pending_added', { id: entry.id, scope: bucket.ref.scope });
      }
    }
    if (episode) {
      try { this.store.indexEpisode(episode); } catch (error) {
        this.emit('repair_needed', { file: episodesFile(this.deps.dataDir), detail: error instanceof Error ? error.message : String(error) });
      }
    }
    if (commit?.extractionState) {
      this.store.setExtractionState(commit.extractionState.sessionId, {
        lastEntryId: commit.extractionState.lastEntryId, lastRunAt: ts,
        userTurnsSince: commit.extractionState.userTurnsSince,
      }, true);
    }
    return { ids, skipped };
  }

  addEpisodeProposal(sessionId: string, summary: string): MemoryEntryView {
    const text = summary.trim();
    if (!text || text.length > 40) throw new Error('会话摘要需为 1–40 字');
    return this.addMemory({
      scope: `episode:${sessionId}`,
      text,
      sessionId,
      status: 'pending',
      sourceKind: 'consolidated',
      excerpt: '空闲整合：压缩会话摘要',
      pendingOp: {
        op: 'EPISODE_UPDATE',
        targetId: sessionId,
        proposedText: text,
        idempotencyKey: `episode:${sessionId}:${text}`,
      },
    });
  }

  updateMemory(id: string, patch: { text?: string; pinned?: boolean; status?: 'active' | 'superseded' }): MemoryEntryView {
    const row = this.store.rowFor(id);
    if (!row) throw new Error('记忆不存在');
    const ref = this.refOf(row);
    const { entries, archived } = this.readRef(ref);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error('记忆不存在于真相源');
    if (typeof patch.text === 'string') {
      const text = patch.text.trim();
      if (!text || text.length > 200) throw new Error('记忆内容需为 1–200 字');
      entry.text = text;
    }
    if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned;
    if (patch.status) entry.status = patch.status;
    entry.updatedAt = this.now();
    this.writeRef(ref, entries, archived);
    this.store.touchAccess([id], true);
    this.emit('memory_changed', { id, scope: ref.scope, op: 'update' });
    return this.view(this.store.indexedRowFor(id) ?? this.store.rowFor(id))!;
  }

  private refOf(row: { scope: string; file_ref: string; project_id: string | null; workspace_path: string | null; id: string }): ScopeFileRef {
    return {
      scope: row.scope,
      file: row.file_ref,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    };
  }

  private privacySourceFor(id: string): { sessionId: string; workspacePath?: string } {
    const pendingSession = this.pendingPrivacyMemorySessions.get(id)
      ?? this.completedPrivacyMemorySessions.get(id);
    if (pendingSession) return { sessionId: pendingSession };
    const indexed = this.store.indexedRowFor(id);
    const recovery = this.store.privacyRecoveryFor(id);
    const sessionId = indexed?.source_session ?? recovery?.sourceSession ?? (indexed ? this.view(indexed)?.source?.sessionId : undefined);
    if (!sessionId) throw new Error('该记忆没有来源会话，无法执行隐私删除');
    return { sessionId, ...(indexed?.workspace_path ?? recovery?.workspacePath
      ? { workspacePath: indexed?.workspace_path ?? recovery?.workspacePath }
      : {}) };
  }

  privacySourceSessionFor(id: string): string {
    return this.privacySourceFor(id).sessionId;
  }

  /** 普通删除保留 superseded 历史；includeHistory 才连同历史版本真删。 */
  deleteMemory(id: string, opts: { mode?: 'normal' | 'privacy'; includeHistory?: boolean } = {}): { ok: true; removed: string[] } {
    if (opts.mode === 'privacy') {
      const source = this.privacySourceFor(id);
      return this.privacyDeleteBySession(source.sessionId, source.workspacePath ? [source.workspacePath] : undefined, id);
    }
    const row = this.store.rowFor(id);
    if (!row) throw new Error('记忆不存在');
    const ref = this.refOf(row);
    const { entries, archived } = this.readRef(ref);
    const historyIds = opts.includeHistory
      ? new Set(entries.filter((e) => e.supersededBy === id || (e.pendingOp?.targetId === id)).map((e) => e.id))
      : new Set<string>();
    historyIds.add(id);
    const kept = entries.filter((e) => !historyIds.has(e.id));
    this.writeRef(ref, kept, archived);
    for (const removed of historyIds) this.store.removeIndexed(removed);
    this.emit('memory_changed', { id, scope: ref.scope, op: 'delete', removed: [...historyIds] });
    return { ok: true, removed: [...historyIds] };
  }

  private privacyJournalPath(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId).digest('hex');
    return join(memoryDir(this.deps.dataDir), 'privacy-pending', `${digest}.json`);
  }

  private assertPrivacyPathSafe(file: string): void {
    assertTruthPathSafe(file, this.deps.probeAttributes);
  }

  private privacyJournalIdentity(file: string, expected?: string): string | undefined {
    this.assertPrivacyPathSafe(file);
    let info;
    try {
      info = lstatSync(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (expected !== undefined) throw new Error('隐私删除恢复日志身份已变化');
        return undefined;
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('隐私删除恢复日志无效');
    const identity = truthFileIdentity(info);
    if (expected !== undefined && identity !== expected) throw new Error('隐私删除恢复日志身份已变化');
    return identity;
  }

  private privacyWriteBlockPath(): string {
    return join(memoryDir(this.deps.dataDir), '.privacy-write-block.json');
  }

  private loadPrivacyWriteBlock(): void {
    try {
      lstatSync(this.privacyWriteBlockPath(), { bigint: true });
      this.privacyJournalFailure = '隐私删除恢复日志无法持久化，记忆读取已阻断';
      this.recoveryWarnings.push(this.privacyJournalFailure);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.privacyJournalFailure = '隐私删除阻断标记无效，记忆读取已阻断';
        this.recoveryWarnings.push(this.privacyJournalFailure);
      }
    }
  }

  private persistPrivacyWriteBlock(): void {
    const file = this.privacyWriteBlockPath();
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      this.assertPrivacyPathSafe(file);
      this.assertPrivacyPathSafe(temp);
      writeFileSync(temp, `${JSON.stringify({ version: 1, reason: this.privacyJournalFailure })}\n`, { flag: 'wx', mode: 0o600 });
      this.assertPrivacyPathSafe(temp);
      this.assertPrivacyPathSafe(file);
      renameSync(temp, file);
    } catch {
      try {
        this.assertPrivacyPathSafe(temp);
        rmSync(temp, { force: true });
      } catch { /* the original failure remains fenced in memory */ }
      this.privacyJournalFailure = '隐私删除阻断标记也无法持久化，记忆读取已阻断';
      this.recoveryWarnings.push(this.privacyJournalFailure);
    }
  }

  private removeZeroedPrivacyFile(file: string, verifiedIdentity?: string): void {
    let descriptor: number | undefined;
    try {
      // A previously verified identity is only an expectation; it never bypasses the pre-zero fence.
      this.assertPrivacyPathSafe(file);
      let before;
      try {
        before = lstatSync(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error('隐私删除恢复日志无效');
      }
      const identity = truthFileIdentity(before);
      if (verifiedIdentity !== undefined && identity !== verifiedIdentity) {
        throw new Error('隐私删除恢复日志身份已变化');
      }
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('隐私删除恢复文件过大');
      const length = Number(before.size);
      this.assertPrivacyPathSafe(file);
      const immediatelyBefore = lstatSync(file, { bigint: true });
      if (truthFileIdentity(immediatelyBefore) !== identity
        || !immediatelyBefore.isFile() || immediatelyBefore.isSymbolicLink() || immediatelyBefore.nlink !== 1n) {
        throw new Error('隐私删除恢复日志身份已变化');
      }
      descriptor = openSync(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n
        || truthFileIdentity(opened) !== identity) {
        throw new Error('隐私删除恢复文件句柄身份已变化');
      }
      ftruncateSync(descriptor, length);
      writeFileSync(descriptor, Buffer.alloc(length));
      fsyncSync(descriptor);
      this.assertPrivacyPathSafe(file);
      const zeroed = Buffer.alloc(length);
      const read = readSync(descriptor, zeroed, 0, length, 0);
      const openedAfterWrite = fstatSync(descriptor, { bigint: true });
      closeSync(descriptor);
      descriptor = undefined;
      if (read !== length || !zeroed.every((byte) => byte === 0)) {
        throw new Error('隐私删除恢复文件清零回读校验失败');
      }
      if (!openedAfterWrite.isFile() || openedAfterWrite.isSymbolicLink() || openedAfterWrite.nlink !== 1n
        || openedAfterWrite.dev !== before.dev || openedAfterWrite.ino !== before.ino
        || openedAfterWrite.size !== before.size) {
        throw new Error('隐私删除恢复文件清零校验失败');
      }
      // removeTruthPathVerified supplies the fresh post-close path fence and
      // double-lstat identity check immediately before the mutation.
      removeTruthPathVerified(file, {
        removePath: this.deps.removePath,
        expectedIdentity: truthFileIdentity(openedAfterWrite),
        probeAttributes: this.deps.probeAttributes,
      });
    } catch (error) {
      this.privacyJournalFailure = `隐私删除恢复文件清理失败，记忆读取已阻断：${error instanceof Error ? error.message : String(error)}`;
      this.recoveryWarnings.push(this.privacyJournalFailure);
      this.persistPrivacyWriteBlock();
      throw new Error(this.privacyJournalFailure);
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the original fenced failure */ }
      }
    }
  }

  private readPrivacyJournal(file: string, identity: string, expectedDigest?: string): {
    sessionId: string; texts: string[]; memoryIds: string[]; workspacePaths: string[];
  } {
    const parsed = JSON.parse(readTruthFileVerified(file, { probeAttributes: this.deps.probeAttributes }).toString('utf8')) as Partial<{
      version: unknown; sessionId: unknown; texts: unknown; memoryIds: unknown; workspacePaths: unknown;
    }>;
    if (parsed.version !== 1 || typeof parsed.sessionId !== 'string' || !parsed.sessionId
      || !Array.isArray(parsed.texts) || parsed.texts.some((text) => typeof text !== 'string')
      || (parsed.memoryIds !== undefined && (!Array.isArray(parsed.memoryIds)
        || parsed.memoryIds.some((id) => typeof id !== 'string' || !id)))
      || (parsed.workspacePaths !== undefined && (!Array.isArray(parsed.workspacePaths)
        || parsed.workspacePaths.some((workspacePath) => typeof workspacePath !== 'string' || !workspacePath)))) {
      throw new Error('invalid privacy journal');
    }
    const digest = createHash('sha256').update(parsed.sessionId).digest('hex');
    if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('privacy journal session digest mismatch');
    if (this.privacyJournalIdentity(file, identity) !== identity) throw new Error('隐私删除恢复日志身份已变化');
    return {
      sessionId: parsed.sessionId,
      texts: normalizePrivacyTexts(parsed.texts as string[]),
      memoryIds: [...new Set((parsed.memoryIds ?? []) as string[])],
      workspacePaths: [...new Set((parsed.workspacePaths ?? []) as string[])],
    };
  }

  private restorePrivacyJournal(parsed: {
    sessionId: string; texts: string[]; memoryIds: string[]; workspacePaths: string[];
  }, identity: string): void {
    this.pendingPrivacyTexts.set(parsed.sessionId, parsed.texts);
    this.pendingPrivacyWorkspaces.set(parsed.sessionId, parsed.workspacePaths);
    this.pendingPrivacyMemoryIds.set(parsed.sessionId, new Set(parsed.memoryIds));
    this.pendingPrivacyJournalIdentities.set(parsed.sessionId, identity);
    this.deletedSessions.add(parsed.sessionId);
    for (const id of parsed.memoryIds) this.pendingPrivacyMemorySessions.set(id, parsed.sessionId);
  }

  private renamePrivacyJournalVerified(source: string, destination: string, expectedSourceIdentity?: string, expectedContent?: Buffer): string {
    const probeAttributes = this.deps.probeAttributes;
    const [sourceBeforeInitial, destinationBefore] = inspectTruthFilesTwice([
      { path: source, options: { regularFile: true, expectedIdentity: expectedSourceIdentity } },
      { path: destination, options: { allowMissing: true, regularFile: true } },
    ], probeAttributes);
    if (!sourceBeforeInitial) throw new Error('隐私删除恢复日志来源缺失');
    let sourceBefore = sourceBeforeInitial;
    if (destinationBefore) {
      this.removeZeroedPrivacyFile(destination, destinationBefore.identity);
      const [refreshedSource, refreshedDestination] = inspectTruthFilesTwice([
        { path: source, options: { regularFile: true, expectedIdentity: sourceBefore.identity } },
        { path: destination, options: { allowMissing: true, regularFile: true } },
      ], probeAttributes);
      if (!refreshedSource) throw new Error('隐私删除恢复日志来源缺失');
      if (refreshedDestination) throw new Error('隐私删除恢复日志重命名目标已存在');
      sourceBefore = refreshedSource;
    }
    const [sourceImmediatelyBefore, destinationImmediatelyBefore] = inspectTruthFilesTwice([
      { path: source, options: { regularFile: true, expectedIdentity: sourceBefore.identity } },
      { path: destination, options: { allowMissing: true, regularFile: true } },
    ], probeAttributes);
    if (!sourceImmediatelyBefore) throw new Error('隐私删除恢复日志来源缺失');
    if (destinationImmediatelyBefore) throw new Error('隐私删除恢复日志重命名目标已存在');
    renameSync(source, destination);
    // The post-rename double-lstat fence is also the pre-read boundary. The
    // batch read still performs an independent fresh native probe and identity
    // comparison after reading the promoted journal.
    const [sourceAfter, destinationRead] = readTruthFilesVerified([
      { path: source, allowMissing: true },
      { path: destination },
    ], probeAttributes);
    if (!destinationRead
      || destinationRead.stats.dev !== sourceBefore.stats.dev || destinationRead.stats.ino !== sourceBefore.stats.ino
      || destinationRead.stats.mode !== sourceBefore.stats.mode || destinationRead.stats.nlink !== sourceBefore.stats.nlink
      || destinationRead.stats.size !== sourceBefore.stats.size) {
      throw new Error('隐私删除恢复日志重命名后身份不一致');
    }
    if (sourceAfter) {
      throw new Error('隐私删除恢复日志重命名后来源仍然存在');
    }
    if (expectedContent && !destinationRead.content.equals(expectedContent)) throw new Error('隐私删除恢复日志重命名后内容不一致');
    return destinationRead.identity;
  }

  private loadPendingPrivacyJournals(): void {
    const dir = join(memoryDir(this.deps.dataDir), 'privacy-pending');
    try {
      let info;
      try {
        info = lstatSync(dir, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      this.assertPrivacyPathSafe(dir);
      const fencedInfo = lstatSync(dir, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()
        || !fencedInfo.isDirectory() || fencedInfo.isSymbolicLink()
        || info.dev !== fencedInfo.dev || info.ino !== fencedInfo.ino) {
        throw new Error('invalid privacy journal directory');
      }
    } catch (error) {
      this.privacyJournalFailure = `隐私删除恢复日志损坏，记忆读取已阻断：${error instanceof Error ? error.message : String(error)}`;
      this.recoveryWarnings.push(this.privacyJournalFailure);
      this.persistPrivacyWriteBlock();
      return;
    }
    try {
      for (const name of readdirSync(dir).sort()) {
        const file = join(dir, name);
        const tempMatch = /^([a-f0-9]{64})\.json\.[a-f0-9-]{36}\.tmp$/.exec(name);
        if (tempMatch) {
          const identity = this.privacyJournalIdentity(file);
          if (!identity) throw new Error('invalid privacy journal temp file');
          const parsed = this.readPrivacyJournal(file, identity, tempMatch[1]);
          const journal = this.privacyJournalPath(parsed.sessionId);
          const promotedIdentity = this.renamePrivacyJournalVerified(file, journal, identity);
          this.restorePrivacyJournal(parsed, promotedIdentity);
          continue;
        }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('隐私删除恢复目录包含未知文件');
        const identity = this.privacyJournalIdentity(file);
        if (!identity) throw new Error('invalid privacy journal');
        const parsed = this.readPrivacyJournal(file, identity, name.slice(0, 64));
        this.restorePrivacyJournal(parsed, identity);
      }
    } catch (error) {
      this.privacyJournalFailure = `隐私删除恢复日志损坏，记忆读取已阻断：${error instanceof Error ? error.message : String(error)}`;
      this.recoveryWarnings.push(this.privacyJournalFailure);
      this.persistPrivacyWriteBlock();
    }
  }

  private persistPendingPrivacy(sessionId: string, texts: string[], workspacePaths: string[] = [], memoryId?: string): void {
    const dir = join(memoryDir(this.deps.dataDir), 'privacy-pending');
    const memoryIds = this.pendingPrivacyMemoryIds.get(sessionId) ?? new Set<string>();
    if (memoryId) memoryIds.add(memoryId);
    texts = normalizePrivacyTexts(texts);
    workspacePaths = [...new Set([...(this.pendingPrivacyWorkspaces.get(sessionId) ?? []), ...workspacePaths])];
    const file = this.privacyJournalPath(sessionId);
    mkdirSync(dir, { recursive: true });
    this.assertPrivacyPathSafe(dir);
    const info = lstatSync(dir, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('隐私删除恢复目录无效');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const payload = Buffer.from(`${JSON.stringify({ version: 1, sessionId, texts, memoryIds: [...memoryIds], workspacePaths })}\n`);
      writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 });
      const identity = this.renamePrivacyJournalVerified(temp, file, undefined, payload);
      this.pendingPrivacyJournalIdentities.set(sessionId, identity);
      this.pendingPrivacyMemoryIds.set(sessionId, memoryIds);
      this.pendingPrivacyWorkspaces.set(sessionId, workspacePaths);
      for (const id of memoryIds) this.pendingPrivacyMemorySessions.set(id, sessionId);
    } catch (error) {
      try {
        this.removeZeroedPrivacyFile(temp);
      } catch (cleanupError) {
        throw new Error(`无法保存隐私删除恢复日志；临时文件清零清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw new Error(`无法保存隐私删除恢复日志：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private clearPendingPrivacy(sessionId: string): void {
    const file = this.privacyJournalPath(sessionId);
    const expectedIdentity = this.pendingPrivacyJournalIdentities.get(sessionId);
    this.removeZeroedPrivacyFile(file, expectedIdentity);
    this.pendingPrivacyJournalIdentities.delete(sessionId);
    for (const id of this.pendingPrivacyMemoryIds.get(sessionId) ?? []) {
      if (this.pendingPrivacyMemorySessions.get(id) === sessionId) this.pendingPrivacyMemorySessions.delete(id);
    }
    this.pendingPrivacyMemoryIds.delete(sessionId);
    this.pendingPrivacyWorkspaces.delete(sessionId);
    this.pendingPrivacyTexts.delete(sessionId);
  }

  /** 隐私删除：条目+FTS+episodes+黑名单+JSONL+chat_sessions 全清。 */
  privacyDeleteBySession(sessionId: string, workspacePaths?: string[], memoryId?: string): { ok: true; removed: string[]; invalidatedPending: number } {
    if (this.privacyJournalFailure) throw new Error(this.privacyJournalFailure);
    const pendingTexts = this.pendingPrivacyTexts.get(sessionId);
    if (pendingTexts && this.truthRecoveryBlocked()) this.cleanupPrivacyCarriers(sessionId, pendingTexts);
    const sessionWorkspace = this.deps.workspacePathOf?.(sessionId);
    const knownWorkspaces = this.truthWorkspacePaths([
      ...(workspacePaths ?? []),
      ...(this.pendingPrivacyWorkspaces.get(sessionId) ?? []),
      ...(sessionWorkspace ? [sessionWorkspace] : []),
    ]);
    const preflight = this.store.runPrivacyCleanup(() =>
      this.store.preflightDeleteBySession(sessionId, knownWorkspaces));
    const { doomed, episodes } = preflight;
    this.invalidateExtraction(sessionId);
    this.deletedSessions.add(sessionId);
    const removedTexts = normalizePrivacyTexts([
      ...(this.pendingPrivacyTexts.get(sessionId) ?? []),
      ...episodes.filter((episode) => episode.sessionId === sessionId)
        .flatMap((episode) => [episode.summary, ...episode.topics]),
      ...doomed.flatMap((entry) => [
        entry.text,
        ...(entry.source?.excerpt ? [entry.source.excerpt] : []),
        ...(entry.pendingOp ? pendingOperationTexts(entry.pendingOp) : []),
      ]),
    ]);
    this.pendingPrivacyTexts.set(sessionId, removedTexts);
    this.pendingPrivacyWorkspaces.set(sessionId, knownWorkspaces);
    const pendingIds = this.pendingPrivacyMemoryIds.get(sessionId) ?? new Set<string>();
    if (memoryId) pendingIds.add(memoryId);
    this.pendingPrivacyMemoryIds.set(sessionId, pendingIds);
    if (memoryId) this.pendingPrivacyMemorySessions.set(memoryId, sessionId);
    try {
      this.persistPendingPrivacy(sessionId, removedTexts, knownWorkspaces, memoryId);
    } catch (error) {
      this.privacyJournalFailure = `隐私删除恢复日志无法持久化，记忆读取已阻断：${error instanceof Error ? error.message : String(error)}`;
      this.recoveryWarnings.push(this.privacyJournalFailure);
      this.registerPendingPrivacySinks();
      this.persistPrivacyWriteBlock();
      throw new Error(this.privacyJournalFailure);
    }
    let cleanupError: unknown;
    try { this.deps.registerChatSessionRedactions?.(removedTexts); } catch (error) {
      cleanupError = error;
      this.emit('repair_needed', { sessionId, detail: '隐私会话登记清理失败' });
    }
    try { this.store.registerPrivacyTexts(removedTexts); } catch (error) {
      cleanupError = error;
      this.emit('repair_needed', { sessionId, detail: '隐私记忆登记清理失败' });
    }
    const invalidatedPending = doomed.filter((entry) => entry.status === 'pending').length;
    try { this.deps.gate?.redactTexts(removedTexts); } catch (error) {
      cleanupError = error;
      this.emit('repair_needed', { sessionId, detail: '隐私审批清理失败' });
    }
    try { this.deps.audit?.redactTexts(removedTexts); } catch (error) {
      cleanupError ??= error;
      this.emit('repair_needed', { sessionId, detail: '隐私审计清理失败' });
    }
    try { this.deps.errors?.redactTexts(removedTexts); } catch (error) {
      cleanupError ??= error;
      this.emit('repair_needed', { sessionId, detail: '隐私诊断清理失败' });
    }
    try { this.deps.logger?.redactSession(sessionId, removedTexts); } catch (error) {
      cleanupError ??= error;
      this.emit('repair_needed', { sessionId, detail: '隐私日志清理失败' });
    }
    if (cleanupError) throw new Error('隐私清理失败，请重试');
    let removed: string[];
    try {
      removed = this.store.runPrivacyCleanup(() =>
        this.store.deleteMemoryEntriesBySession(sessionId, undefined, knownWorkspaces, removedTexts, preflight));
    } catch (error) {
      this.emit('repair_needed', { sessionId, detail: '隐私记忆真相清理失败' });
      throw error;
    }
    try {
      this.cleanupPrivacyCarriers(sessionId, removedTexts);
    } catch (error) {
      this.emit('repair_needed', { sessionId, detail: '隐私会话文件清理失败' });
      const detail = error instanceof Error ? error.message : String(error);
      const safeDetail = this.store.redactPrivacyText(detail);
      throw new Error(`隐私清理失败，请重试：${safeDetail}`);
    }
    this.clearPendingPrivacy(sessionId);
    this.emit('memory_changed', { sessionId, op: 'privacy-delete', removed, invalidatedPending });
    return { ok: true, removed, invalidatedPending };
  }

  /** 普通删除会话：保留记忆但把来源链接标成“来源已删除”。 */
  markSourcesDeleted(sessionId: string, workspacePath?: string): void {
    this.invalidateExtraction(sessionId);
    this.store.markSourcesDeleted(sessionId, this.truthWorkspacePaths(workspacePath ? [workspacePath] : []));
    this.emit('memory_changed', { sessionId, op: 'source-deleted' });
  }

  /** pending 出口穷举：批准/驳回/目标失效/源会话删除/搬迁/索引重建。 */
  resolvePending(id: string, decision: 'approve' | 'reject'): { ok: true; message?: string; entry?: MemoryEntryView } {
    const row = this.store.rowFor(id);
    if (!row || row.status !== 'pending') throw new Error('待确认记忆不存在');
    const ref = this.refOf(row);
    const { entries, archived } = this.readRef(ref);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error('待确认记忆不存在于真相源');
    const rawMergeIds = entry.pendingOp?.mergeIds;
    if (rawMergeIds !== undefined && (!Array.isArray(rawMergeIds) || rawMergeIds.some((value) => typeof value !== 'string'))) {
      throw new Error('合并目标列表非法');
    }
    const mergeIds = (rawMergeIds ?? []) as string[];
    if (ref.scope.startsWith('episode:')) {
      if (decision === 'reject') {
        entry.status = 'superseded';
        entry.pendingOp = null;
        entry.updatedAt = this.now();
        this.writeRef(ref, entries);
        this.emit('memory_changed', { id, scope: ref.scope, op: 'reject' });
        return { ok: true, message: '已驳回摘要压缩' };
      }
      const sessionId = ref.scope.slice('episode:'.length);
      const summary = String(entry.pendingOp?.proposedText ?? '').trim();
      const current = this.store.listEpisodes().find((episode) => episode.sessionId === sessionId);
      if (!current) throw new Error('原会话摘要已不存在');
      if (!summary || summary.length > 40) throw new Error('会话摘要需为 1–40 字');
      const next = { ...current, summary, compressedAt: this.now() };
      const episodePath = episodesFile(this.deps.dataDir);
      const previous = inspectTruthFile(episodePath, this.deps.probeAttributes, { allowMissing: true })
        ? readTruthFileVerified(episodePath, { probeAttributes: this.deps.probeAttributes }).toString('utf8')
        : '';
      entry.status = 'superseded';
      entry.pendingOp = null;
      entry.updatedAt = this.now();
      commitTruthBatch(this.deps.dataDir, new Map([
        [episodePath, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${JSON.stringify(next)}\n`],
        [ref.file, `${JSON.stringify({ version: 1, entries: entries.map((item) => this.store.redactEntryForPrivacy(item)) }, null, 2)}\n`],
      ]), { probeAttributes: this.deps.probeAttributes });
      try { this.store.indexEpisode(next); } catch (error) {
        this.emit('repair_needed', { file: episodePath, detail: error instanceof Error ? error.message : String(error) });
      }
      this.emit('memory_changed', { id, scope: ref.scope, op: 'approve-episode-update' });
      return { ok: true, message: '已确认摘要压缩' };
    }
    let message: string | undefined;
    if (decision === 'reject') {
      const hash = normalizeTextHash(entry.pendingOp?.proposedText ?? entry.text);
      this.store.addRejectedHash(hash, entry.source?.sessionId ?? '');
      const kept = entries.filter((e) => e.id !== id);
      this.writeRef(ref, kept, archived);
      this.store.removeIndexed(id);
      this.emit('memory_changed', { id, scope: ref.scope, op: 'reject' });
      return { ok: true, message: '已驳回，后续不再提案同类内容' };
    }
    const op = entry.pendingOp?.op ?? 'ADD';
    const targetId = entry.pendingOp?.targetId;
    const target = targetId ? entries.find((e) => e.id === targetId) : undefined;
    if (targetId && (!target || target.status !== 'active')) {
      message = '原目标已变化，已降级为新记忆候选，请重新确认';
      const proposedText = entry.pendingOp?.proposedText ?? entry.text;
      entry.pendingOp = {
        ...entry.pendingOp,
        op: 'ADD',
        text: proposedText,
        degradedFrom: op === 'EPISODE_UPDATE' ? undefined : op,
      };
      entry.text = proposedText;
      entry.updatedAt = this.now();
      this.writeRef(ref, entries, archived);
      this.emit('memory_changed', { id, scope: ref.scope, op: 'degraded' });
      return { ok: true, message, entry: this.view(this.store.indexedRowFor(id) ?? this.store.rowFor(id)) ?? undefined };
    }
    if (op === 'ADD' || !target) {
      entry.status = 'active';
      entry.pendingOp = null;
      entry.updatedAt = this.now();
      this.writeRef(ref, entries, archived);
      this.store.touchAccess([id], true);
      this.emit('memory_changed', { id, scope: ref.scope, op: 'approve-add' });
      return { ok: true, entry: this.view(this.store.indexedRowFor(id) ?? this.store.rowFor(id)) ?? undefined };
    }
    const ts = this.now();
    for (const mergeId of new Set(mergeIds)) {
      const sibling = this.store.rowFor(mergeId);
      if (!sibling || sibling.status !== 'active' || sibling.file_ref !== ref.file || sibling.scope !== ref.scope) {
        throw new Error(`合并目标缺失或不属于同一记忆文件：${mergeId}`);
      }
    }
    if (op === 'UPDATE') {
      target.text = entry.pendingOp?.proposedText ?? entry.text;
      target.updatedAt = ts;
      if (entry.source) target.source = entry.source;
      const kept = entries.filter((e) => e.id !== id);
      this.writeRef(ref, kept, archived);
      this.store.touchAccess([targetId!], true);
      this.emit('memory_changed', { id: targetId, scope: ref.scope, op: 'approve-update' });
      return { ok: true, entry: this.view(this.store.indexedRowFor(targetId!) ?? this.store.rowFor(targetId!)) ?? undefined };
    }
    target.status = 'superseded';
    target.supersededBy = id;
    target.updatedAt = ts;
    // 整合提案可能一次合并多条：被合并掉的兄弟条目一并作废，避免留下重复的 active。
    for (const mergeId of new Set(mergeIds)) {
      const sibling = entries.find((e) => e.id === mergeId);
      if (!sibling || sibling.status !== 'active') throw new Error(`合并目标状态已变化：${mergeId}`);
      sibling.status = 'superseded';
      sibling.supersededBy = id;
      sibling.updatedAt = ts;
    }
    entry.status = 'active';
    entry.text = entry.pendingOp?.proposedText ?? entry.text;
    entry.pendingOp = null;
    entry.updatedAt = ts;
    this.writeRef(ref, entries, archived);
    this.store.touchAccess([id, targetId!, ...mergeIds], true);
    this.emit('memory_changed', { id, scope: ref.scope, op: 'approve-supersede' });
    return { ok: true, entry: this.view(this.store.indexedRowFor(id) ?? this.store.rowFor(id)) ?? undefined };
  }

  archiveProject(workspacePath: string, archived: boolean): { ok: true } {
    this.store.assertReadAvailable();
    const file = projectMemoryFile(workspacePath);
    const parsed = this.store.readProjectTruth(file);
    const ref: ScopeFileRef = {
      scope: `project:${parsed.projectId}`, file, projectId: parsed.projectId,
      workspacePath: normalizeWorkspacePath(workspacePath), archived,
    };
    this.writeRef(ref, parsed.entries, archived);
    this.emit('memory_changed', { scope: ref.scope, op: archived ? 'archive' : 'unarchive' });
    return { ok: true };
  }

  rebuildIndex(): { entries: number; corrupt: string[] } {
    const result = this.store.rebuild();
    this.emit('memory_changed', { op: 'rebuild-index', ...result });
    return result;
  }

  /** 项目记忆损坏：不静默覆盖。用户确认后按空文件重建，或提供原文替换。 */
  repairProjectMemory(workspacePath: string, mode: 'empty' | 'replace', content?: string): { ok: true } {
    this.store.assertReadAvailable();
    const file = projectMemoryFile(workspacePath);
    const normalized = normalizeWorkspacePath(workspacePath);
    const registered = readProjectRegistry(this.deps.dataDir).projects
      .find((project) => normalizeWorkspacePath(project.workspacePath).toLowerCase() === normalized.toLowerCase());
    let parsed: ProjectMemoryFileV1 | undefined;
    if (existsSync(file)) {
      try { parsed = this.store.readProjectTruth(file); } catch (error) {
        if (error instanceof TruthPathSafetyError || error instanceof TruthSnapshotChangedError) throw error;
        /* user confirmed repair of corrupt truth */
      }
    }
    const entries = mode === 'replace'
      ? parseProjectMemoryFile(String(content ?? ''), file).entries
      : [];
    const replacementProjectId = mode === 'replace'
      ? parseProjectMemoryFile(String(content ?? ''), file).projectId
      : undefined;
    if (replacementProjectId && parsed && replacementProjectId !== parsed.projectId) {
      throw new Error('修复内容必须保留原 projectId');
    }
    if (replacementProjectId && registered && replacementProjectId !== registered.projectId) {
      throw new Error('修复内容必须保留已注册的 projectId');
    }
    const projectId = parsed?.projectId ?? registered?.projectId ?? replacementProjectId ?? `proj_${newMemoryId().slice(4)}`;
    const archived = parsed?.archived ?? registered?.archived ?? false;
    const ref: ScopeFileRef = {
      scope: `project:${projectId}`, file, projectId,
      workspacePath: normalized, archived,
    };
    this.store.preflightReplacement(file, projectId, entries, this.truthWorkspacePaths());
    this.writeRef(ref, entries, archived);
    this.emit('memory_changed', { scope: ref.scope, op: 'repair', workspacePath });
    return { ok: true };
  }

  searchMemory(query: string, opts: { limit?: number; includeHistory?: boolean } = {}): MemorySearchHit[] {
    if (!this.settings.enabled) return [];
    this.synchronize();
    const hits = this.store.search(query, opts);
    // 命中即强化：记忆条目与情景摘要都算（情景摘要的 id 带 `episode:` 前缀，store 按前缀分派）。
    this.store.touchAccess(hits.map((h) => h.id), true);
    return hits;
  }

  close(): void { this.store.close(); }
}

