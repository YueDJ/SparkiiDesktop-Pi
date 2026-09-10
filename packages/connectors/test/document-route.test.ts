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
    expect(shouldUseStructure({ ext: '.pdf', textLayer: 'a'.repeat(49 * 2), pageCount: 2 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '\uFFFD'.repeat(40) + 'ok'.repeat(10), pageCount: 1 })).toBe(true);
  });
  it('keeps a dense electronic pdf native', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '合同条款'.repeat(80), pageCount: 2 })).toBe(false);
  });
});
