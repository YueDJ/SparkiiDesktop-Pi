import { describe, it, expect } from 'vitest';
import { Bm25Index } from '../src/knowledge/index.js';

describe('Bm25Index', () => {
  const idx = new Bm25Index([
    { id: '1', text: '逾期付款违约金按日万分之五计算' },
    { id: '2', text: '设备检修周期为每季度一次' },
  ]);
  it('ranks relevant clause first', () => {
    const hits = idx.search('违约金 逾期', 2);
    expect(hits[0].id).toBe('1');
  });
});
