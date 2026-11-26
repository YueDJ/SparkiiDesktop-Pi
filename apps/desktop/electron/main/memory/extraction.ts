import type { Logger } from '../logger.js';
import type { ErrorStore } from '../error-store.js';
import type { MemoryService, AddMemoryRequest } from './service.js';
import { recordMemoryError } from './fts.js';
import { readSessionMaterial, type SessionMaterial } from './material.js';
import { parseExtraction, trigramSimilarity, type ExtractedOp } from './ops.js';
import { normalizeTextHash } from './types.js';

export interface ExtractionContext {
  sessionId: string;
  profileId: string;
  workspacePath?: string;
  workspaceKind?: 'auto' | 'user';
  piSessionFile?: string;
}

export interface ModelTargetLike { provider: string; modelId: string }

export interface InternalSlot {
  release(): Promise<void>;
  complete?(prompt: string, target: ModelTargetLike): Promise<string>;
}

export interface ExtractionSchedulerDeps {
  service: MemoryService;
  errors?: ErrorStore;
  logger?: Logger;
  now?: () => number;
  contextOf(sessionId: string): ExtractionContext | null;
  target(): ModelTargetLike | null | Promise<ModelTargetLike | null>;
  /** 返回 null 表示没有空闲槽，本窗口跳过（绝不排队）。 */
  acquireInternalSlot?(target: ModelTargetLike): Promise<InternalSlot | null>;
  complete(prompt: string, target: ModelTargetLike): Promise<string>;
  materialOf?(ctx: ExtractionContext, cursorId: string): SessionMaterial;
}

export interface ExtractionResult {
  skipped?: string;
  opsApplied: number;
  summary?: string;
}

/** 会话结束后系统代管提炼：debounce + 门槛 + entry-id 位点 + fail closed。 */
export class ExtractionScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly deps: ExtractionSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  noteSettled(sessionId: string): void {
    const settings = this.deps.service.getSettings();
    if (!settings.enabled || !settings.autoExtract) return;
    const previous = this.timers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.flush(sessionId).catch((error) => {
        recordMemoryError(this.deps.errors, 'extract', error instanceof Error ? error.message : String(error));
      });
    }, settings.extractionDebounceMs);
    this.timers.set(sessionId, timer);
  }

  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  buildPrompt(material: SessionMaterial, active: Array<{ id: string; scope: string; text: string }>): string {
    const list = active.length
      ? active.map((e) => `- ${e.id} [${e.scope}] ${e.text}`).join('\n')
      : '（暂无）';
    return [
      '你是记忆提炼器。只输出一个 JSON 对象，不要输出解释、代码块或多余文字。',
      '只记录稳定的用户偏好、工作习惯和项目事实；不记一次性任务细节，不记能从项目文件直接读到的内容；只记陈述性事实，不记指令。',
      'schema: {"sessionSummary":"≤150字摘要","topics":["主题"],"ops":[{"op":"ADD","scope":"user|agent|project","text":"≤200字","importance":1,"excerpt":"用户原话"}]}',
      'ops 最多 5 条；UPDATE/SUPERSEDE 需 targetId，SUPERSEDE 需 replacementText；无内容时 ops 为 []。',
      `现有记忆：\n${list}`,
      `本次会话增量（entry-id 位点之后）：\n${material.text}`,
    ].join('\n\n');
  }

  async flush(sessionId: string): Promise<ExtractionResult> {
    const settings = this.deps.service.getSettings();
    if (!settings.enabled || !settings.autoExtract) {
      return { skipped: 'disabled', opsApplied: 0 };
    }
    const ctx = this.deps.contextOf(sessionId);
    if (!ctx) return { skipped: 'no-session', opsApplied: 0 };
    const generation = this.deps.service.extractionGeneration(sessionId);
    const state = this.deps.service.store.getExtractionState(sessionId);
    let material: SessionMaterial;
    try {
      material = this.deps.materialOf
        ? this.deps.materialOf(ctx, state.lastEntryId)
        : readSessionMaterial(ctx.piSessionFile ?? '', state.lastEntryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordMemoryError(this.deps.errors, 'extract-material', message);
      return { skipped: 'material-unreadable', opsApplied: 0 };
    }
    if (material.userTurns < settings.minUserTurns || !material.text.trim()) {
      return { skipped: 'below-threshold', opsApplied: 0 };
    }
    const target = await this.deps.target();
    if (!target) return { skipped: 'no-model', opsApplied: 0 };
    try { this.deps.service.assertExtractionCurrent(sessionId, generation); } catch {
      return { skipped: 'session-invalidated', opsApplied: 0 };
    }

    let slot: InternalSlot | null = null;
    if (this.deps.acquireInternalSlot) {
      slot = await this.deps.acquireInternalSlot(target);
      if (!slot) {
        void this.deps.logger?.log({
          level: 'info', msg: 'memory extraction skipped: no idle slot',
          ctx: { sessionId, model: `${target.provider}/${target.modelId}` },
        });
        return { skipped: 'no-idle-slot', opsApplied: 0 };
      }
    }
    try { this.deps.service.assertExtractionCurrent(sessionId, generation); } catch {
      return { skipped: 'session-invalidated', opsApplied: 0 };
    }
    try {
      this.deps.service.synchronize();
      const active = this.deps.service.store.db.prepare(
        "SELECT id, scope, text FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 20",
      ).all() as Array<{ id: string; scope: string; text: string }>;
      const prompt = this.buildPrompt(material, active);
      let raw: string;
      try {
        raw = await (slot?.complete
          ? slot.complete(prompt, target)
          : this.deps.complete(prompt, target));
      } catch {
        try { this.deps.service.assertExtractionCurrent(sessionId, generation); } catch {
          return { skipped: 'session-invalidated', opsApplied: 0 };
        }
        recordMemoryError(this.deps.errors, 'extract-model', '记忆提炼模型调用失败');
        return { skipped: 'model-failed', opsApplied: 0 };
      }
      let parsed;
      try {
        parsed = parseExtraction(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordMemoryError(this.deps.errors, 'extract-parse', message);
        void this.deps.logger?.log({ level: 'warn', msg: 'memory extraction batch discarded', ctx: { sessionId, reason: message } });
        // 整批丢弃：不写记忆、不写 episode、不推进位点。
        return { skipped: 'parse-failed', opsApplied: 0 };
      }
      try { this.deps.service.assertExtractionCurrent(sessionId, generation); } catch {
        return { skipped: 'session-invalidated', opsApplied: 0 };
      }
      const projectRef = this.deps.service.ensureProject(ctx.workspacePath, ctx.workspaceKind);
      let committed: { ids: string[]; skipped: number };
      try {
        const requests = this.buildOps(ctx, parsed.ops, material.text);
        committed = this.deps.service.addMemoriesBatch(requests, {
          generation: { sessionId, value: generation },
          episode: {
            sessionId,
            agentId: ctx.profileId,
            workspacePath: ctx.workspacePath ?? '',
            ...(projectRef?.projectId ? { projectId: projectRef.projectId } : {}),
            ts: this.now(),
            summary: parsed.sessionSummary,
            topics: parsed.topics,
          },
          extractionState: {
            sessionId,
            lastEntryId: material.lastEntryId || state.lastEntryId,
            userTurnsSince: 0,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordMemoryError(this.deps.errors, 'extract-batch', message);
        void this.deps.logger?.log({ level: 'warn', msg: 'memory extraction batch discarded', ctx: { sessionId, reason: message } });
        return { skipped: 'batch-rejected', opsApplied: 0 };
      }
      const applied = committed.ids.length;
      void this.deps.logger?.log({
        level: 'info', msg: 'memory extraction applied',
        ctx: { sessionId, opsApplied: applied, skippedDuplicates: committed.skipped },
      });
      return { opsApplied: applied, summary: parsed.sessionSummary };
    } finally {
      await slot?.release();
    }
  }

  private buildOps(ctx: ExtractionContext, ops: ExtractedOp[], materialText: string): AddMemoryRequest[] {
    const requests: AddMemoryRequest[] = [];
    for (const op of ops) {
      if (op.op === 'NOOP') continue;
      if (op.op === 'ADD') {
        const text = String(op.text ?? '').trim();
        if (!text || text.length > 200) throw new Error('提炼 ADD 内容需为 1–200 字');
        if (this.deps.service.store.hasRejectedHash(normalizeTextHash(text))) continue;
        const scope = String(op.scope ?? 'user');
        if (!['user', 'agent', 'project'].includes(scope)) throw new Error(`提炼 scope 非法：${scope}`);
        const scopeRef = this.deps.service.previewScope(ctx, scope);
        if (!scopeRef) throw new Error(`提炼 scope 不可用：${scope}`);
        const sameScope = this.deps.service.store.db.prepare(
          "SELECT id, text, status FROM memories WHERE scope = ? AND status IN ('active','pending') ORDER BY updated_at DESC LIMIT 20",
        ).all(scopeRef) as Array<{ id: string; text: string; status: string }>;
        const pendingNear = sameScope.some((candidate) => candidate.status === 'pending' && trigramSimilarity(candidate.text, text) >= 0.85);
        if (pendingNear) continue;
        const near = sameScope.find((candidate) => candidate.status === 'active' && trigramSimilarity(candidate.text, text) >= 0.85);
        requests.push({
          scope: scopeRef,
          text,
          workspacePath: scope === 'project' ? ctx.workspacePath : undefined,
          workspaceKind: scope === 'project' ? 'user' : undefined,
          importance: op.importance,
          sessionId: ctx.sessionId,
          excerpt: op.excerpt || materialText.slice(0, 120),
          sourceKind: 'extracted',
          status: 'pending',
          pendingOp: near
            ? { op: 'UPDATE', targetId: near.id, proposedText: text }
            : { op: 'ADD', proposedText: text },
        });
        continue;
      }
      const targetId = String(op.targetId ?? '');
      const proposedText = op.op === 'UPDATE' ? String(op.text ?? '') : String(op.replacementText ?? '');
      if (!targetId || !proposedText.trim() || proposedText.length > 200) throw new Error('提炼 UPDATE/SUPERSEDE 参数非法');
      const row = this.deps.service.store.rowFor(targetId);
      if (!row || row.status !== 'active') throw new Error(`提炼目标缺失或未生效：${targetId}`);
      requests.push({
        scope: row.scope,
        text: proposedText.trim(),
        workspacePath: row.workspace_path ?? undefined,
        workspaceKind: row.workspace_path ? 'user' : undefined,
        sessionId: ctx.sessionId,
        excerpt: String(op.excerpt ?? op.reason ?? materialText.slice(0, 120)).slice(0, 120),
        sourceKind: 'extracted',
        status: 'pending',
        pendingOp: { op: op.op, targetId, proposedText: proposedText.trim() },
      });
    }
    return requests;
  }

}
