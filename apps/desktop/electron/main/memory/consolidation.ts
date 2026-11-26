import type { Logger } from '../logger.js';
import type { ErrorStore } from '../error-store.js';
import type { MemoryService } from './service.js';
import type { InternalSlot, ModelTargetLike } from './extraction.js';
import type { AddMemoryRequest } from './service.js';
import { recordMemoryError } from './fts.js';
import { trigramSimilarity } from './ops.js';

/** 一次整合最多借几次模型（§9）：超出顺延到下一个空闲窗口。 */
export const CONSOLIDATION_MAX_CALLS = 3;
/** 情景摘要超过这个天数才二次压缩。 */
export const EPISODE_COMPRESS_AFTER_DAYS = 30;
/** 每阶段最多处理的条目数，避免单次 prompt 过长。 */
const PHASE_LIMIT = 6;

export interface ConsolidationDeps {
  service: MemoryService;
  errors?: ErrorStore;
  logger?: Logger;
  now?: () => number;
  /** 有交互会话在跑就不整合（不抢用户的时间）。 */
  isBusy?: () => boolean;
  /** 返回 null 表示没有空闲槽：本窗口顺延，绝不排队。 */
  acquireInternalSlot?(target: ModelTargetLike): Promise<InternalSlot | null>;
  complete(prompt: string, target: ModelTargetLike): Promise<string>;
  target(): ModelTargetLike | null | Promise<ModelTargetLike | null>;
}

export interface ConsolidationResult {
  skipped?: 'disabled' | 'not-idle' | 'interval' | 'busy' | 'no-model' | 'no-idle-slot' | 'nothing-to-do';
  /** 实际发出的模型调用次数（≤ CONSOLIDATION_MAX_CALLS）。 */
  calls: number;
  proposals: number;
  digests: number;
}

/**
 * 空闲整合（"睡眠机制"）。三个可选阶段，各自最多 1 次调用，合计 ≤3：
 * A 同 scope 相似记忆 → 合并提案（pending SUPERSEDE，绝不自动改 active）
 * B 30 天以上的情景摘要 → 二次压缩（情景是系统产物，不是用户记忆）
 * C 长期未动的项目事实 → 过期复核提案（pending SUPERSEDE）
 */
export class IdleConsolidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number;
  private readonly now: () => number;
  private running = false;

  constructor(private readonly deps: ConsolidationDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.lastActivityAt = this.now();
  }

  /** 交互侧每次活动（settle 后）调用：把空闲计时推到现在。 */
  noteActivity(): void {
    this.lastActivityAt = this.now();
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        recordMemoryError(this.deps.errors, 'consolidate', error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    // 定时器不该拖住进程退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private assertAvailable(): void {
    this.deps.service.store.assertReadAvailable();
  }

  async runOnce(): Promise<ConsolidationResult> {
    const settings = this.deps.service.getSettings();
    if (!settings.enabled || !settings.idleConsolidation) {
      return { skipped: 'disabled', calls: 0, proposals: 0, digests: 0 };
    }
    this.assertAvailable();
    const now = this.now();
    if (now - this.lastActivityAt < settings.consolidateIdleMinutes * 60_000) {
      return { skipped: 'not-idle', calls: 0, proposals: 0, digests: 0 };
    }
    if (now - this.deps.service.store.getConsolidationLastRun() < settings.consolidateIntervalHours * 3_600_000) {
      return { skipped: 'interval', calls: 0, proposals: 0, digests: 0 };
    }
    if (this.deps.isBusy?.()) return { skipped: 'busy', calls: 0, proposals: 0, digests: 0 };
    if (this.running) return { skipped: 'busy', calls: 0, proposals: 0, digests: 0 };

    this.running = true;
    let slot: InternalSlot | null = null;
    let calls = 0;
    let proposals = 0;
    let digests = 0;
    try {
      const target = await this.deps.target();
      this.assertAvailable();
      if (!target) return { skipped: 'no-model', calls: 0, proposals: 0, digests: 0 };
      if (this.deps.acquireInternalSlot) {
        slot = await this.deps.acquireInternalSlot(target);
        this.assertAvailable();
        if (!slot) {
          void this.deps.logger?.log({
            level: 'info', msg: 'memory consolidation skipped: no idle slot',
            ctx: { model: `${target.provider}/${target.modelId}` },
          });
          return { skipped: 'no-idle-slot', calls: 0, proposals: 0, digests: 0 };
        }
      }
      const ask = async (prompt: string): Promise<string> => {
        this.assertAvailable();
        calls += 1;
        try {
          const raw = await (slot?.complete ? slot.complete(prompt, target) : this.deps.complete(prompt, target));
          this.assertAvailable();
          return raw;
        } catch (error) {
          this.assertAvailable();
          throw error;
        }
      };
      this.assertAvailable();
      this.deps.service.synchronize();
      this.assertAvailable();
      const merges = await this.mergePhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      proposals += merges;
      const compressed = await this.compressPhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      proposals += compressed.proposals;
      digests += compressed.digests;
      const stale = await this.stalePhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      proposals += stale;

      this.assertAvailable();
      this.deps.service.store.setConsolidationLastRun(now);
      void this.deps.logger?.log({
        level: 'info', msg: 'memory consolidation finished',
        ctx: { calls, proposals, digests },
      });
      if (!calls) return { skipped: 'nothing-to-do', calls, proposals, digests };
      return { calls, proposals, digests };
    } finally {
      this.running = false;
      await slot?.release();
    }
  }

  /** A：同 scope 高相似 active 记忆 → 合并成一条的提案。 */
  private async mergePhase(ask: (prompt: string) => Promise<string>, canCall: () => boolean): Promise<number> {
    this.assertAvailable();
    const pairs = this.findSimilarPairs();
    if (!pairs.length || !canCall()) return 0;
    const list = pairs
      .map((p, i) => `${i + 1}. A=${p[0].id} 「${p[0].text}」 / B=${p[1].id} 「${p[1].text}」`)
      .join('\n');
    const prompt = [
      '你是记忆整理器。只输出一个 JSON 对象，不要解释、不要代码块。',
      '下面每组是同一层级里语义重复的两条已确认记忆。请把它们各合并成一句陈述，保留不冲突的信息，不复述原文。',
      'schema: {"merges":[{"keepId":"保留的条目id","dropId":"被合并掉的条目id","text":"合并后的陈述，≤200字"}]}',
      '无法合并且没有信息增量的组直接省略。',
      list,
    ].join('\n\n');
    let raw: string;
    try {
      raw = await ask(prompt);
    } catch {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-merge', '记忆整合模型调用失败');
      return 0;
    }
    let parsed: { merges?: unknown };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'merge 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation merge discarded', ctx: { reason: 'invalid-json' } });
      return 0;
    }
    if (!parsed || !Array.isArray(parsed.merges)) return 0;
    const requests: AddMemoryRequest[] = [];
    for (const merge of parsed.merges.slice(0, PHASE_LIMIT)) {
      if (!merge || typeof merge !== 'object' || Array.isArray(merge)) return 0;
      const item = merge as Record<string, unknown>;
      if (typeof item.keepId !== 'string' || typeof item.dropId !== 'string' || typeof item.text !== 'string') return 0;
      const keepId = item.keepId;
      const dropId = item.dropId;
      const text = item.text.trim();
      if (!keepId || !dropId || !text || text.length > 200 || keepId === dropId) return 0;
      if (!pairs.some(([a, b]) => (a.id === keepId && b.id === dropId) || (a.id === dropId && b.id === keepId))) return 0;
      const keep = this.deps.service.store.rowFor(keepId);
      if (!keep || keep.status !== 'active') return 0;
      const drop = this.deps.service.store.rowFor(dropId);
      if (!drop || drop.status !== 'active' || drop.file_ref !== keep.file_ref || drop.scope !== keep.scope) return 0;
      requests.push({
        scope: keep.scope,
        text,
        status: 'pending',
        sourceKind: 'consolidated',
        ...this.workspaceOf(keep),
        excerpt: `整合：合并「${keep.text}」与「${dropId}」`,
        pendingOp: {
          op: 'SUPERSEDE', targetId: keepId, proposedText: text, mergeIds: [dropId],
          idempotencyKey: `merge:${[keepId, dropId].sort().join(':')}:${text}`,
        },
      });
    }
    if (!requests.length) return 0;
    this.assertAvailable();
    try {
      return this.deps.service.addMemoriesBatch(requests).ids.length;
    } catch (error) {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-merge', error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  /** B：30 天以上的长情景摘要 → 二次压缩。 */
  private async compressPhase(ask: (prompt: string) => Promise<string>, canCall: () => boolean): Promise<{ proposals: number; digests: number }> {
    this.assertAvailable();
    const empty = { proposals: 0, digests: 0 };
    const cutoff = this.now() - EPISODE_COMPRESS_AFTER_DAYS * 86_400_000;
    const stale = this.deps.service.store
      .listEpisodes()
      .filter((e) => e.ts < cutoff && e.summary.length > 80)
      .slice(0, PHASE_LIMIT);
    if (!stale.length || !canCall()) return empty;
    const list = stale.map((e) => `${e.sessionId}\t${e.summary}`).join('\n');
    const prompt = [
      '你是记忆压缩器。只输出一个 JSON 对象，不要解释、不要代码块。',
      '下面每行是「会话id\\t摘要」。请把每条摘要压成不超过 40 字，只保留结论性事实与项目线索。',
      'schema: {"digests":[{"sessionId":"会话id","summary":"压缩后的摘要"}]}',
      list,
    ].join('\n\n');
    let raw: string;
    try {
      raw = await ask(prompt);
    } catch {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-compress', '记忆压缩模型调用失败');
      return empty;
    }
    let parsed: { digests?: unknown };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'compress 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation compress discarded', ctx: { reason: 'invalid-json' } });
      return empty;
    }
    if (!parsed || !Array.isArray(parsed.digests)) return empty;
    const known = new Set(stale.map((e) => e.sessionId));
    const requests: AddMemoryRequest[] = [];
    for (const digest of parsed.digests.slice(0, PHASE_LIMIT)) {
      if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return empty;
      const item = digest as Record<string, unknown>;
      if (typeof item.sessionId !== 'string' || typeof item.summary !== 'string') return empty;
      const sessionId = item.sessionId;
      const summary = item.summary.trim();
      if (!known.has(sessionId) || !summary || summary.length > 40) return empty;
      requests.push({
        scope: `episode:${sessionId}`,
        text: summary,
        status: 'pending',
        sourceKind: 'consolidated',
        excerpt: '空闲整合：压缩会话摘要',
        pendingOp: {
          op: 'EPISODE_UPDATE', targetId: sessionId, proposedText: summary,
          idempotencyKey: `episode:${sessionId}:${summary}`,
        },
      });
    }
    if (!requests.length) return empty;
    this.assertAvailable();
    try {
      const result = this.deps.service.addMemoriesBatch(requests);
      return { proposals: result.ids.length, digests: requests.length };
    } catch (error) {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-compress', error instanceof Error ? error.message : String(error));
      return empty;
    }
  }

  /** C：长期未更新的项目事实 → 过期复核提案（仍走 pending）。 */
  private async stalePhase(ask: (prompt: string) => Promise<string>, canCall: () => boolean): Promise<number> {
    this.assertAvailable();
    const cutoff = this.now() - 180 * 86_400_000;
    const rows = this.deps.service.store.consolidationStaleProjectRows(cutoff, PHASE_LIMIT);
    if (!rows.length || !canCall()) return 0;
    const list = rows.map((r) => `${r.id} 「${r.text}」`).join('\n');
    const prompt = [
      '你是记忆复核器。只输出一个 JSON 对象，不要解释、不要代码块。',
      '下面是半年未更新的项目事实。若某条明显带有会过期的时效信息（报价、排期、人员、阶段性结论），给出更保守的表述；若是稳定事实就不要输出。',
      'schema: {"ops":[{"targetId":"条目id","replacementText":"更保守的表述，≤200字"}]}',
      list,
    ].join('\n\n');
    let raw: string;
    try {
      raw = await ask(prompt);
    } catch {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-stale', '记忆复核模型调用失败');
      return 0;
    }
    let parsed: { ops?: unknown };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'stale 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation stale discarded', ctx: { reason: 'invalid-json' } });
      return 0;
    }
    if (!parsed || !Array.isArray(parsed.ops)) return 0;
    const allowed = new Set(rows.map((r) => r.id));
    const requests: AddMemoryRequest[] = [];
    for (const op of parsed.ops.slice(0, PHASE_LIMIT)) {
      if (!op || typeof op !== 'object' || Array.isArray(op)) return 0;
      const item = op as Record<string, unknown>;
      if (typeof item.targetId !== 'string' || typeof item.replacementText !== 'string') return 0;
      const targetId = item.targetId;
      const replacementText = item.replacementText.trim();
      if (!allowed.has(targetId) || !replacementText || replacementText.length > 200) return 0;
      const row = this.deps.service.store.rowFor(targetId);
      if (!row || row.status !== 'active') return 0;
      requests.push({
        scope: row.scope,
        text: replacementText,
        status: 'pending',
        sourceKind: 'consolidated',
        ...this.workspaceOf(row),
        excerpt: `整合：复核过期项目事实 ${targetId}`,
        pendingOp: {
          op: 'SUPERSEDE', targetId, proposedText: replacementText,
          idempotencyKey: `stale:${targetId}:${replacementText}`,
        },
      });
    }
    if (!requests.length) return 0;
    this.assertAvailable();
    try {
      return this.deps.service.addMemoriesBatch(requests).ids.length;
    } catch (error) {
      this.assertAvailable();
      recordMemoryError(this.deps.errors, 'consolidate-stale', error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  /** 项目层提案要带回工作区，否则真相源解析不出文件。 */
  private workspaceOf(row: { workspace_path: string | null }): { workspacePath?: string; workspaceKind?: 'user' } {
    return row.workspace_path ? { workspacePath: row.workspace_path, workspaceKind: 'user' } : {};
  }

  /** 同 scope 内相似度 ≥0.85 的 active 记忆对（取前 PHASE_LIMIT 组，id 去重）。 */
  private findSimilarPairs(): Array<[MemoryRow, MemoryRow]> {
    this.assertAvailable();
    const rows = this.deps.service.store.consolidationSimilarRows();
    const pairs: Array<[MemoryRow, MemoryRow]> = [];
    const used = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.scope !== b.scope || a.file_ref !== b.file_ref) continue;
        if (used.has(a.id) || used.has(b.id)) continue;
        if (trigramSimilarity(a.text, b.text) < 0.85) continue;
        pairs.push([a, b]);
        used.add(a.id);
        used.add(b.id);
        if (pairs.length >= PHASE_LIMIT) return pairs;
      }
    }
    return pairs;
  }
}

type MemoryRow = { id: string; scope: string; text: string; updated_at: number; file_ref: string };
