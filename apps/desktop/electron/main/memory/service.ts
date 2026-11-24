import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { ErrorStore } from '../error-store.js';
import { MemoryStore, CorruptMemoryError, parseMemoryFile, parseProjectMemoryFile, type ScopeFileRef } from './store.js';
import {
  agentMemoryFile,
  atomicWrite,
  loadMemorySettings,
  loadProjectRegistry,
  memoryDir,
  normalizeWorkspacePath,
  projectMemoryFile,
  saveMemorySettings,
  upsertProjectRef,
} from './settings.js';
import { newMemoryId, normalizeTextHash } from './types.js';
import type {
  MemoryEntry,
  MemoryEntryView,
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
  now?: () => number;
  forceLike?: boolean;
  sessionExists?: (sessionId: string) => boolean;
  sessionFileOf?: (sessionId: string) => string | undefined;
  deleteChatSession?: (sessionId: string) => void;
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

/** 平台层记忆编排：文件真相源 + 派生索引 + 注入 + 确认队列。 */
export class MemoryService {
  readonly store: MemoryStore;
  private settings: MemorySettings;
  private readonly deps: MemoryServiceDeps;
  private readonly now: () => number;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.store = new MemoryStore({ dataDir: deps.dataDir, errors: deps.errors, now: this.now, forceLike: deps.forceLike });
    this.settings = loadMemorySettings(deps.dataDir);
  }

  /** registerIpc 装配后接上 renderer 事件通道；主进程逻辑不依赖窗口存在。 */
  setEmitter(fn: (type: 'pending_added' | 'memory_changed' | 'repair_needed', payload: Record<string, unknown>) => void): void {
    this.deps.emit = fn;
  }

  getSettings(): MemorySettings { return structuredClone(this.settings); }

  saveSettings(partial: Partial<MemorySettings>): MemorySettings {
    this.settings = saveMemorySettings(this.deps.dataDir, partial);
    return this.getSettings();
  }

  get ftsAvailable(): boolean { return this.store.ftsAvailable; }
  get sqliteVersion(): string { return this.store.sqliteVersion; }

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
    if (!workspacePath || workspaceKind !== 'user') return null;
    const file = projectMemoryFile(workspacePath);
    if (!existsSync(file)) return null;
    let parsed: ProjectMemoryFileV1;
    try {
      parsed = parseProjectMemoryFile(readFileSync(file, 'utf8'), file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emit('repair_needed', { workspacePath, file, detail });
      return null;
    }
    upsertProjectRef(this.deps.dataDir, {
      projectId: parsed.projectId,
      workspacePath: normalizeWorkspacePath(workspacePath),
    });
    const ref: ScopeFileRef = {
      scope: `project:${parsed.projectId}`,
      file,
      projectId: parsed.projectId,
      workspacePath: normalizeWorkspacePath(workspacePath),
      archived: parsed.archived,
    };
    const indexed = this.store.db.prepare('SELECT count(*) AS c FROM memories WHERE scope = ? AND file_ref = ?').get(ref.scope, file) as { c: number };
    if (indexed.c === 0) this.store.replaceScopeIndex(ref, parsed.entries, parsed.archived);
    return ref;
  }

  /** 提炼候选解析实际 scope；auto 工作区的项目候选归用户层。 */
  previewScope(ctx: { profileId: string; workspacePath?: string; workspaceKind?: 'auto' | 'user' }, scope: string): string | null {
    if (scope === 'user') return 'user';
    if (scope === 'agent') return `agent:${ctx.profileId}`;
    if (scope === 'project') {
      if (ctx.workspaceKind !== 'user' || !ctx.workspacePath) return 'user';
      const file = projectMemoryFile(ctx.workspacePath);
      // 首条项目记忆由提炼产生时文件还不存在：与 resolveScope 一致地分配 projectId（§126 创建时生成），
      // 否则候选会被静默丢弃。文件存在但损坏时仍返回 null（损坏即拒绝，绝不覆盖）。
      if (!existsSync(file)) return `project:proj_${newMemoryId().slice(4)}`;
      try {
        return `project:${parseProjectMemoryFile(readFileSync(file, 'utf8'), file).projectId}`;
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
    if (raw === 'agent' || raw.startsWith('agent:')) {
      return this.agentRef(raw.startsWith('agent:') ? raw.slice(6) : String(req.agentId ?? ''));
    }
    if (raw === 'project' || raw.startsWith('project:')) {
      const path = String(req.workspacePath ?? '').trim();
      if (!path) throw new Error('项目记忆需要工作区路径');
      if (req.workspaceKind !== 'user') throw new Error('临时工作区不建立项目记忆');
      const file = projectMemoryFile(path);
      if (existsSync(file)) {
        const parsed = parseProjectMemoryFile(readFileSync(file, 'utf8'), file);
        const ref: ScopeFileRef = {
          scope: `project:${parsed.projectId}`, file,
          projectId: parsed.projectId, workspacePath: normalizeWorkspacePath(path), archived: parsed.archived,
        };
        upsertProjectRef(this.deps.dataDir, { projectId: parsed.projectId, workspacePath: normalizeWorkspacePath(path) });
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

  private writeRef(ref: ScopeFileRef, entries: MemoryEntry[], archived?: boolean): void {
    if (ref.scope.startsWith('project:')) {
      const payload: ProjectMemoryFileV1 = {
        version: 1,
        projectId: ref.projectId!,
        ...(archived !== undefined ? { archived } : {}),
        entries,
      };
      atomicWrite(ref.file, `${JSON.stringify(payload, null, 2)}\n`);
      upsertProjectRef(this.deps.dataDir, {
        projectId: ref.projectId!, workspacePath: ref.workspacePath!,
      });
    } else {
      atomicWrite(ref.file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
    }
    this.store.replaceScopeIndex(ref, entries, archived);
  }

  private readRef(ref: ScopeFileRef): { entries: MemoryEntry[]; archived?: boolean } {
    if (!existsSync(ref.file)) return { entries: [] };
    const text = readFileSync(ref.file, 'utf8');
    if (ref.scope.startsWith('project:')) {
      const parsed = parseProjectMemoryFile(text, ref.file);
      return { entries: parsed.entries, archived: parsed.archived };
    }
    return { entries: parseMemoryFile(text, ref.file).entries };
  }

  private view(row: ReturnType<MemoryStore['rowFor']>): MemoryEntryView | null {
    if (!row) return null;
    return this.store.viewOf(row, (id) => this.sessionExists(id));
  }

  /** 记忆块在鞍文本末尾追加；注入只 +accessCount，不重置衰减时钟。 */
  buildBlock(ctx: { sessionId?: string; profileId: string; workspacePath?: string; workspaceKind?: 'auto' | 'user' }): string {
    if (!this.settings.enabled) return '';
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
        ctx: { sessionId: ctx.sessionId ?? '', agentId: ctx.profileId, workspacePath: ctx.workspacePath ?? '', block },
      });
    }
    return block;
  }

  list(): MemoryListResult {
    const refs = this.store.allScopeFiles();
    const warnings: string[] = [];
    const scopes: ScopeView[] = refs.map((ref) => {
      const kind = this.scopeKind(ref.scope);
      const base: ScopeView = {
        scope: ref.scope,
        kind,
        label: this.scopeLabel(ref),
        ...(kind === 'agent' ? { agentId: ref.scope.slice(6) } : {}),
        ...(ref.projectId ? { projectId: ref.projectId } : {}),
        ...(ref.workspacePath ? { workspacePath: ref.workspacePath } : {}),
        ...(ref.archived !== undefined ? { archived: ref.archived } : {}),
        ...(ref.corrupt ? { corrupt: true } : {}),
        entries: [],
      };
      if (ref.corrupt) {
        warnings.push(`${this.scopeLabel(ref)} 记忆文件损坏，已停止注入；请在设置页修复`);
        return base;
      }
      const entries = this.store.viewsByIds(
        (this.store.db.prepare('SELECT id FROM memories WHERE scope = ? ORDER BY updated_at DESC').all(ref.scope) as Array<{ id: string }>).map((r) => r.id),
        (id) => this.sessionExists(id),
      );
      const active = entries.filter((e) => e.status === 'active');
      const result = selectWithinBudget(
        active.map((e) => ({ entry: e, usage: e.usage })),
        {
          now: this.now(),
          halfLifeDays: halfLifeFor(this.settings, kind),
          budget: this.settings.budgets[kind as 'user' | 'agent' | 'project'] ?? 500,
        },
      );
      if (result.warning) warnings.push(`${this.scopeLabel(ref)}：${result.warning}`);
      return { ...base, warning: result.warning, entries };
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
    const text = String(req.text ?? '').trim();
    if (!text || text.length > 200) throw new Error('记忆内容需为 1–200 字');
    const ref = this.resolveScope(req);
    const { entries, archived } = this.readRef(ref);
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
    return this.view(this.store.rowFor(entry.id))!;
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
    return this.view(this.store.rowFor(id))!;
  }

  private refOf(row: { scope: string; file_ref: string; project_id: string | null; workspace_path: string | null; id: string }): ScopeFileRef {
    return {
      scope: row.scope,
      file: row.file_ref,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    };
  }

  /** 普通删除保留 superseded 历史；includeHistory 才连同历史版本真删。 */
  deleteMemory(id: string, opts: { mode?: 'normal' | 'privacy'; includeHistory?: boolean } = {}): { ok: true; removed: string[] } {
    const row = this.store.rowFor(id);
    if (!row) throw new Error('记忆不存在');
    if (opts.mode === 'privacy') {
      const sessionId = row.source_session ?? this.view(row)?.source?.sessionId;
      if (!sessionId) throw new Error('该记忆没有来源会话，无法执行隐私删除');
      return this.privacyDeleteBySession(sessionId);
    }
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

  /** 隐私删除：条目+FTS+episodes+黑名单+JSONL+chat_sessions 全清。 */
  privacyDeleteBySession(sessionId: string): { ok: true; removed: string[]; invalidatedPending: number } {
    const pending = this.store.rowsBySession(sessionId).filter((row) => row.status === 'pending');
    const removed = this.store.deleteMemoryEntriesBySession(sessionId);
    const file = this.deps.sessionFileOf?.(sessionId);
    if (file) rmSync(file, { force: true });
    this.deps.deleteChatSession?.(sessionId);
    this.store.db.prepare('DELETE FROM extraction_state WHERE session_id = ?').run(sessionId);
    const invalidatedPending = pending.length;
    this.emit('memory_changed', { sessionId, op: 'privacy-delete', removed, invalidatedPending });
    return { ok: true, removed, invalidatedPending };
  }

  /** 普通删除会话：保留记忆但把来源链接标成“来源已删除”。 */
  markSourcesDeleted(sessionId: string): void {
    this.store.markSourcesDeleted(sessionId);
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
        degradedFrom: op,
      };
      entry.text = proposedText;
      entry.updatedAt = this.now();
      this.writeRef(ref, entries, archived);
      this.emit('memory_changed', { id, scope: ref.scope, op: 'degraded' });
      return { ok: true, message, entry: this.view(this.store.rowFor(id)) ?? undefined };
    }
    if (op === 'ADD' || !target) {
      entry.status = 'active';
      entry.pendingOp = null;
      entry.updatedAt = this.now();
      this.writeRef(ref, entries, archived);
      this.store.touchAccess([id], true);
      this.emit('memory_changed', { id, scope: ref.scope, op: 'approve-add' });
      return { ok: true, entry: this.view(this.store.rowFor(id)) ?? undefined };
    }
    const ts = this.now();
    if (op === 'UPDATE') {
      target.text = entry.pendingOp?.proposedText ?? entry.text;
      target.updatedAt = ts;
      if (entry.source) target.source = entry.source;
      const kept = entries.filter((e) => e.id !== id);
      this.writeRef(ref, kept, archived);
      this.store.touchAccess([targetId!], true);
      this.emit('memory_changed', { id: targetId, scope: ref.scope, op: 'approve-update' });
      return { ok: true, entry: this.view(this.store.rowFor(targetId!)) ?? undefined };
    }
    target.status = 'superseded';
    target.supersededBy = id;
    target.updatedAt = ts;
    // 整合提案可能一次合并多条：被合并掉的兄弟条目一并作废，避免留下重复的 active。
    const mergeIds = Array.isArray(entry.pendingOp?.mergeIds)
      ? (entry.pendingOp?.mergeIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    for (const mergeId of mergeIds) {
      const sibling = entries.find((e) => e.id === mergeId);
      if (!sibling || sibling.status !== 'active') continue;
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
    return { ok: true, entry: this.view(this.store.rowFor(id)) ?? undefined };
  }

  archiveProject(workspacePath: string, archived: boolean): { ok: true } {
    const file = projectMemoryFile(workspacePath);
    if (!existsSync(file)) throw new Error('项目记忆不存在');
    const parsed = parseProjectMemoryFile(readFileSync(file, 'utf8'), file);
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
    const file = projectMemoryFile(workspacePath);
    let projectId = `proj_${newMemoryId().slice(4)}`;
    try {
      projectId = parseProjectMemoryFile(readFileSync(file, 'utf8'), file).projectId;
    } catch {
      const match = readFileSync(file, 'utf8').match(/"projectId"\s*:\s*"([^"]+)"/);
      if (match) projectId = match[1];
    }
    const entries = mode === 'replace'
      ? parseProjectMemoryFile(String(content ?? ''), file).entries
      : [];
    const ref: ScopeFileRef = {
      scope: `project:${projectId}`, file, projectId,
      workspacePath: normalizeWorkspacePath(workspacePath), archived: false,
    };
    this.writeRef(ref, entries, false);
    this.emit('memory_changed', { scope: ref.scope, op: 'repair', workspacePath });
    return { ok: true };
  }

  searchMemory(query: string, opts: { limit?: number; includeHistory?: boolean } = {}): MemorySearchHit[] {
    if (!this.settings.enabled) return [];
    const hits = this.store.search(query, opts);
    // 命中即强化：记忆条目与情景摘要都算（情景摘要的 id 带 `episode:` 前缀，store 按前缀分派）。
    this.store.touchAccess(hits.map((h) => h.id), true);
    return hits;
  }

  close(): void { this.store.close(); }
}

