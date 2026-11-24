import { describe, expect, it } from 'vitest';
import { buildMemoryBlock, decayScore, selectWithinBudget, sanitizeInjectionText } from '../electron/main/memory/scoring.js';
import type { MemoryEntry } from '../electron/main/memory/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function entry(id: string, text: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id, text, status: 'active', pinned: false, importance: 2,
    createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY,
    source: null, supersededBy: null, pendingOp: null, ...overrides,
  };
}

describe('memory scoring', () => {
  it('pinned 豁免衰减', () => {
    const score = decayScore({
      importance: 1, pinned: true, lastAccessedAt: 0, createdAt: 0,
      now: NOW, halfLifeDays: 1,
    });
    expect(score).toBe(Number.POSITIVE_INFINITY);
  });

  it('半衰期边界恰好剩一半，注入不重置时钟', () => {
    const halfLifeDays = 60;
    const anchor = NOW - halfLifeDays * DAY;
    const score = decayScore({
      importance: 3, pinned: false, lastAccessedAt: anchor, createdAt: anchor - DAY,
      now: NOW, halfLifeDays,
    });
    expect(score).toBeCloseTo(1.5, 10);
    // 再次以同一 anchor 计算（注入只加计数，不写 lastAccessedAt）分数不变。
    expect(decayScore({
      importance: 3, pinned: false, lastAccessedAt: anchor, createdAt: anchor - DAY,
      now: NOW, halfLifeDays,
    })).toBeCloseTo(score, 10);
  });

  it('预算截断：低分条目不注入但仍在候选中可检索', () => {
    const entries = [
      { entry: entry('m1', '一二三'), usage: { lastAccessedAt: null, accessCount: 0 } },
      { entry: entry('m2', '四五六七八'), usage: { lastAccessedAt: NOW, accessCount: 3 } },
    ];
    const result = selectWithinBudget(entries, { now: NOW, halfLifeDays: 60, budget: 5 });
    expect(result.selected.map((s) => s.entry.id)).toEqual(['m2']);
    expect(result.omitted.map((s) => s.entry.id)).toEqual(['m1']);
  });

  it('pinned 恒在最前；超预算按 updatedAt 保留最新者并给出警示', () => {
    const result = selectWithinBudget([
      { entry: entry('old', '旧置顶内容', { pinned: true, updatedAt: NOW - DAY }), usage: { lastAccessedAt: null, accessCount: 0 } },
      { entry: entry('new', '新置顶内容', { pinned: true, updatedAt: NOW }), usage: { lastAccessedAt: null, accessCount: 0 } },
    ], { now: NOW, halfLifeDays: 60, budget: 5 });
    expect(result.selected.map((s) => s.entry.id)).toEqual(['new']);
    expect(result.omitted.map((s) => s.entry.id)).toEqual(['old']);
    expect(result.warning).toContain('置顶记忆超出注入预算');
  });

  it('注入块带日期、空记忆不注入、控制字符被清洗', () => {
    const block = buildMemoryBlock([{
      kind: 'user', scope: 'user',
      items: [{ text: '用户\u0007要求先给结论', updatedAt: NOW }],
    }]);
    expect(block).toContain('<memory>');
    expect(block).toContain('[用户]');
    expect(block).toContain('用户 要求先给结论');
    expect(buildMemoryBlock([])).toBe('');
    expect(sanitizeInjectionText('a\u001fb')).toBe('a b');
  });

  it('强化重置时钟后可复算：分数回到满值，再按新锚点继续衰减', () => {
    const createdAt = NOW - 200 * DAY;
    // 从未强化：200 天前创建，半年半衰期 → 0.5^(200/180)
    const cold = decayScore({
      importance: 3, pinned: false, lastAccessedAt: null, createdAt, now: NOW, halfLifeDays: 180,
    });
    expect(cold).toBeCloseTo(3 * Math.pow(0.5, 200 / 180), 10);

    // 强化发生在 10 天前：时钟被重置到那时，只剩 10 天衰减
    const reinforcedAt = NOW - 10 * DAY;
    const warm = decayScore({
      importance: 3, pinned: false, lastAccessedAt: reinforcedAt, createdAt, now: NOW, halfLifeDays: 180,
    });
    expect(warm).toBeCloseTo(3 * Math.pow(0.5, 10 / 180), 10);
    expect(warm).toBeGreaterThan(cold);

    // 同一锚点再走 180 天：恰好剩满值的一半（可复算）
    const half = decayScore({
      importance: 3, pinned: false, lastAccessedAt: reinforcedAt, createdAt,
      now: reinforcedAt + 180 * DAY, halfLifeDays: 180,
    });
    expect(half).toBeCloseTo(3 / 2, 10);
  });
});
