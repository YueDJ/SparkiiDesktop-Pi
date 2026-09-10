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
});
