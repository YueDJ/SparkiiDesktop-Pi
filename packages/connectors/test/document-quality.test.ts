import { describe, it, expect } from 'vitest';
import { recognitionLevel, averageQuality } from '../src/document/quality.js';

describe('recognitionLevel', () => {
  it('uses locked thresholds', () => {
    expect(recognitionLevel(0.85)).toBe('high');
    expect(recognitionLevel(0.849)).toBe('mid');
    expect(recognitionLevel(0.70)).toBe('mid');
    expect(recognitionLevel(0.699)).toBe('low');
  });
});

describe('averageQuality', () => {
  it('averages pages equally and omits empty pages', () => {
    const q = averageQuality([{ page: 1, score: 0.9 }, { page: 2, score: 0.7 }]);
    expect(q.score).toBeCloseTo(0.8);
    expect(q.level).toBe('mid');
    expect(q.pages).toHaveLength(2);
  });

  it('returns score 0 and level low for empty pages', () => {
    const q = averageQuality([]);
    expect(q).toEqual({ score: 0, level: 'low', pages: [] });
  });

  it('returns score 0 and level low when all scores are non-finite', () => {
    const q = averageQuality([
      { page: 1, score: NaN },
      { page: 2, score: Infinity },
      { page: 3, score: -Infinity },
    ]);
    expect(q).toEqual({ score: 0, level: 'low', pages: [] });
  });

  it('averages only finite scores when mixed with non-finite values', () => {
    const q = averageQuality([
      { page: 1, score: 0.8 },
      { page: 2, score: NaN },
      { page: 3, score: 0.6 },
      { page: 4, score: Infinity },
    ]);
    expect(q.score).toBeCloseTo(0.7);
    expect(q.level).toBe('mid');
    expect(q.pages).toEqual([
      { page: 1, score: 0.8, level: 'mid' },
      { page: 3, score: 0.6, level: 'low' },
    ]);
  });
});
