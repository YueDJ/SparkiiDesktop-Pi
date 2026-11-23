import type { MemoryEntry, MemorySettings, MemoryUsage, MemoryScopeKind } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DecayInput {
  importance: number;
  pinned: boolean;
  /** 上次使用时间；null 表示从未强化，按创建时间计。 */
  lastAccessedAt: number | null;
  createdAt: number;
  now: number;
  halfLifeDays: number;
}

/** 艾宾浩斯式指数衰减。pinned 豁免；半衰期边界恰好剩一半。 */
export function decayScore(input: DecayInput): number {
  if (input.pinned) return Number.POSITIVE_INFINITY;
  const halfLife = Number.isFinite(input.halfLifeDays) && input.halfLifeDays > 0
    ? input.halfLifeDays
    : 1;
  const anchor = input.lastAccessedAt ?? input.createdAt;
  const days = Math.max(0, (input.now - anchor) / DAY_MS);
  const importance = Number.isFinite(input.importance) ? input.importance : 1;
  return importance * Math.pow(0.5, days / halfLife);
}

export interface Scored<T> {
  entry: T;
  score: number;
  usage: MemoryUsage;
}

export interface SelectionResult<T> {
  selected: Array<Scored<T>>;
  omitted: Array<Scored<T>>;
  warning?: string;
}

/**
 * 按分数（pinned 恒在最前）与字符预算选取。
 * 注意：注入只累加 accessCount，不重置 lastAccessedAt —— 强化只由检索命中/显式操作触发。
 */
export function selectWithinBudget<T extends Pick<MemoryEntry, 'id' | 'text' | 'pinned' | 'importance' | 'createdAt' | 'updatedAt'>>(
  entries: Array<{ entry: T; usage: MemoryUsage }>,
  opts: { now: number; halfLifeDays: number; budget: number },
): SelectionResult<T> {
  const scored: Array<Scored<T>> = entries.map(({ entry, usage }) => ({
    entry,
    usage,
    score: decayScore({
      importance: entry.importance,
      pinned: entry.pinned,
      lastAccessedAt: usage.lastAccessedAt,
      createdAt: entry.createdAt,
      now: opts.now,
      halfLifeDays: opts.halfLifeDays,
    }),
  }));
  scored.sort((a, b) => {
    if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1;
    if (a.entry.pinned && b.entry.pinned && a.entry.updatedAt !== b.entry.updatedAt) {
      return b.entry.updatedAt - a.entry.updatedAt;
    }
    if (a.score !== b.score) return b.score - a.score;
    return b.entry.updatedAt - a.entry.updatedAt;
  });
  let used = 0;
  const selected: Array<Scored<T>> = [];
  const omitted: Array<Scored<T>> = [];
  for (const item of scored) {
    const cost = item.entry.text.length;
    if (used + cost > opts.budget) {
      omitted.push(item);
      continue;
    }
    used += cost;
    selected.push(item);
  }
  const pinnedOmitted = omitted.filter((item) => item.entry.pinned).length;
  return {
    selected,
    omitted,
    ...(pinnedOmitted > 0
      ? { warning: `置顶记忆超出注入预算：${pinnedOmitted} 条置顶记忆未注入（按更新时间保留最新者）` }
      : {}),
  };
}

/** 入 prompt 前的清洗：控制字符不可进 system prompt。 */
export function sanitizeInjectionText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface InjectionSection {
  kind: MemoryScopeKind;
  scope: string;
  items: Array<{ text: string; updatedAt: number }>;
}

const LABELS: Record<MemoryScopeKind, string> = {
  user: '用户',
  agent: '习惯',
  project: '项目',
  episode: '情景',
};

function dateOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 空记忆整块不注入；块放在鞍文本末尾（其后尚有 skills 目录与 cwd 行）。 */
export function buildMemoryBlock(sections: InjectionSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      const text = sanitizeInjectionText(item.text);
      if (text) lines.push(`[${LABELS[section.kind]}] (${dateOf(item.updatedAt)}) ${text}`);
    }
  }
  if (!lines.length) return '';
  return [
    '<memory>',
    '以下是关于用户、你的工作习惯与本项目的已确认记忆。与当前对话冲突时以当前对话为准；',
    '引用记忆做重要判断前，如记忆陈旧（标注了日期），先向用户核实。',
    ...lines,
    '</memory>',
  ].join('\n');
}

export function halfLifeFor(settings: MemorySettings, kind: MemoryScopeKind): number {
  if (kind === 'episode') return settings.halfLifeDays.episode;
  return settings.halfLifeDays[kind];
}
