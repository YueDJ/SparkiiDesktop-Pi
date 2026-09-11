import { describe, it, expect } from 'vitest';
import { shouldUseStructure } from '../src/document/route.js';

describe('shouldUseStructure', () => {
  it('never uses structure for office and text', () => {
    for (const ext of ['.txt', '.md', '.csv', '.docx', '.xlsx']) {
      expect(shouldUseStructure({ ext, textLayer: '', pageCount: 1 })).toBe(false);
    }
  });
  it('always uses structure for photos', () => {
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      expect(shouldUseStructure({ ext, textLayer: '', pageCount: 1 })).toBe(true);
    }
  });
  it('routes empty or short or garbled pdfs to structure', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: null, pageCount: 3 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '', pageCount: 3 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '', pageCount: 0 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: 'a'.repeat(19 * 2), pageCount: 2 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '\uFFFD'.repeat(40) + 'ok'.repeat(10), pageCount: 1 })).toBe(true);
  });
  it('keeps a six-page selectable contract native', () => {
    const page = '甲方应当在本合同生效后十个工作日内支付预付款。'.repeat(2);
    expect(shouldUseStructure({
      ext: '.pdf',
      textLayer: Array.from({ length: 6 }, () => page).join('\n'),
      pageCount: 6,
    })).toBe(false);
  });
  it('treats a short-but-usable chinese page as native', () => {
    const layer = '技术服务合同编号HT-2026-0911-008甲方星火工业';
    expect(layer.replace(/\s/g, '').length).toBeGreaterThanOrEqual(20);
    expect(layer.replace(/\s/g, '').length).toBeLessThan(50);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: layer, pageCount: 1 })).toBe(false);
  });
  it('keeps a dense electronic pdf native', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '合同条款'.repeat(80), pageCount: 2 })).toBe(false);
  });
});
