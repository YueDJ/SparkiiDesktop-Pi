import type { Logger } from '../logger.js';
import type { ErrorStore } from '../error-store.js';
import type { MemoryService } from './service.js';
import type { InternalSlot, ModelTargetLike } from './extraction.js';
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

  async runOnce(): Promise<ConsolidationResult> {
    const settings = this.deps.service.getSettings();
    if (!settings.enabled || !settings.idleConsolidation) {
      return { skipped: 'disabled', calls: 0, proposals: 0, digests: 0 };
    }
    const now = this.now();
    if (now - this.lastActivityAt < settings.consolidateIdleMinutes * 60_000) {
      return { skipped: 'not-idle', calls: 0, proposals: 0, digests: 0 };
    }
    if (now - this.deps.service.store.getConsolidationLastRun() < settings.consolidateIntervalHours * 3_600_000) {
      return { skipped: 'interval', calls: 0, proposals: 0, digests: 0 };
    }
    if (this.deps.isBusy?.()) return { skipped: 'busy', calls: 0, proposals: 0, digests: 0 };
    if (this.running) return { skipped: 'busy', calls: 0, proposals: 0, digests: 0 };

    const target = await this.deps.target();
    if (!target) return { skipped: 'no-model', calls: 0, proposals: 0, digests: 0 };

    let slot: InternalSlot | null = null;
    if (this.deps.acquireInternalSlot) {
      slot = await this.deps.acquireInternalSlot(target);
      if (!slot) {
        void this.deps.logger?.log({
          level: 'info', msg: 'memory consolidation skipped: no idle slot',
          ctx: { model: `${target.provider}/${target.modelId}` },
        });
        return { skipped: 'no-idle-slot', calls: 0, proposals: 0, digests: 0 };
      }
    }

    this.running = true;
    let calls = 0;
    let proposals = 0;
    let digests = 0;
    const ask = async (prompt: string): Promise<string> => {
      calls += 1;
      return slot?.complete ? slot.complete(prompt, target) : this.deps.complete(prompt, target);
    };

    try {
      const merges = await this.mergePhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      proposals += merges;
      const compressed = await this.compressPhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      digests += compressed;
      const stale = await this.stalePhase(ask, () => calls < CONSOLIDATION_MAX_CALLS);
      proposals += stale;

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
    } catch (error) {
      recordMemoryError(this.deps.errors, 'consolidate-merge', error instanceof Error ? error.message : String(error));
      return 0;
    }
    let parsed: { merges?: Array<{ keepId?: string; dropId?: string; text?: string }> };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'merge 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation merge discarded', ctx: { reason: 'invalid-json' } });
      return 0;
    }
    if (!Array.isArray(parsed.merges)) return 0;
    const pairIds = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
    let proposals = 0;
    for (const merge of parsed.merges.slice(0, PHASE_LIMIT)) {
      const keepId = String(merge.keepId ?? '');
      const dropId = String(merge.dropId ?? '');
      const text = String(merge.text ?? '').trim();
      if (!keepId || !dropId || !text || text.length > 200) continue;
      if (!pairIds.has(keepId) || !pairIds.has(dropId) || keepId === dropId) continue;
      const keep = this.deps.service.store.rowFor(keepId);
      if (!keep || keep.status !== 'active') continue;
      const drop = this.deps.service.store.rowFor(dropId);
      if (!drop || drop.status !== 'active') continue;

      // 合并提案：保留 keep，替换为合并后的陈述；drop 在批准时一并作废（mergeIds）。
      this.deps.service.addMemory({
        scope: keep.scope,
        text,
        status: 'pending',
        sourceKind: 'consolidated',
        ...this.workspaceOf(keep),
        excerpt: `整合：合并「${keep.text}」与「${dropId}」`,
        pendingOp: { op: 'SUPERSEDE', targetId: keepId, proposedText: text, mergeIds: [dropId] },
      });
      proposals += 1;
    }
    return proposals;
  }

  /** B：30 天以上的长情景摘要 → 二次压缩。 */
  private async compressPhase(ask: (prompt: string) => Promise<string>, canCall: () => boolean): Promise<number> {
    const cutoff = this.now() - EPISODE_COMPRESS_AFTER_DAYS * 86_400_000;
    const stale = this.deps.service.store
      .listEpisodes()
      .filter((e) => e.ts < cutoff && e.summary.length > 80)
      .slice(0, PHASE_LIMIT);
    if (!stale.length || !canCall()) return 0;
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
    } catch (error) {
      recordMemoryError(this.deps.errors, 'consolidate-compress', error instanceof Error ? error.message : String(error));
      return 0;
    }
    let parsed: { digests?: Array<{ sessionId?: string; summary?: string }> };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'compress 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation compress discarded', ctx: { reason: 'invalid-json' } });
      return 0;
    }
    if (!Array.isArray(parsed.digests)) return 0;
    const known = new Set(stale.map((e) => e.sessionId));
    let digests = 0;
    for (const item of parsed.digests) {
      const sessionId = String(item.sessionId ?? '');
      const summary = String(item.summary ?? '').trim();
      if (!known.has(sessionId) || !summary || summary.length > 160) continue;
      this.deps.service.store.updateEpisodeSummary(sessionId, summary);
      digests += 1;
    }
    return digests;
  }

  /** C：长期未更新的项目事实 → 过期复核提案（仍走 pending）。 */
  private async stalePhase(ask: (prompt: string) => Promise<string>, canCall: () => boolean): Promise<number> {
    const cutoff = this.now() - 180 * 86_400_000;
    const rows = this.deps.service.store.db.prepare(
      "SELECT id, scope, text, updated_at FROM memories WHERE status = 'active' AND scope LIKE 'project:%' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
    ).all(cutoff, PHASE_LIMIT) as Array<{ id: string; scope: string; text: string; updated_at: number }>;
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
    } catch (error) {
      recordMemoryError(this.deps.errors, 'consolidate-stale', error instanceof Error ? error.message : String(error));
      return 0;
    }
    let parsed: { ops?: Array<{ targetId?: string; replacementText?: string }> };
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      recordMemoryError(this.deps.errors, 'consolidate-parse', 'stale 阶段输出不是合法 JSON');
      void this.deps.logger?.log({ level: 'warn', msg: 'memory consolidation stale discarded', ctx: { reason: 'invalid-json' } });
      return 0;
    }
    if (!Array.isArray(parsed.ops)) return 0;
    const allowed = new Set(rows.map((r) => r.id));
    let proposals = 0;
    for (const op of parsed.ops.slice(0, PHASE_LIMIT)) {
      const targetId = String(op.targetId ?? '');
      const replacementText = String(op.replacementText ?? '').trim();
      if (!allowed.has(targetId) || !replacementText || replacementText.length > 200) continue;
      const row = this.deps.service.store.rowFor(targetId);
      if (!row || row.status !== 'active') continue;
      this.deps.service.addMemory({
        scope: row.scope,
        text: replacementText,
        status: 'pending',
        sourceKind: 'consolidated',
        ...this.workspaceOf(row),
        excerpt: `整合：复核过期项目事实 ${targetId}`,
        pendingOp: { op: 'SUPERSEDE', targetId, proposedText: replacementText },
      });
      proposals += 1;
    }
    return proposals;
  }

  /** 项目层提案要带回工作区，否则真相源解析不出文件。 */
  private workspaceOf(row: { workspace_path: string | null }): { workspacePath?: string; workspaceKind?: 'user' } {
    return row.workspace_path ? { workspacePath: row.workspace_path, workspaceKind: 'user' } : {};
  }

  /** 同 scope 内相似度 ≥0.85 的 active 记忆对（取前 PHASE_LIMIT 组，id 去重）。 */
  private findSimilarPairs(): Array<[MemoryRow, MemoryRow]> {
    const rows = this.deps.service.store.db.prepare(
      "SELECT id, scope, text, updated_at FROM memories WHERE status = 'active' ORDER BY scope, updated_at DESC",
    ).all() as MemoryRow[];
    const pairs: Array<[MemoryRow, MemoryRow]> = [];
    const used = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.scope !== b.scope) continue;
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

type MemoryRow = { id: string; scope: string; text: string; updated_at: number };
