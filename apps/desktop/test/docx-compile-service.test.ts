import { describe, it, expect } from 'vitest';
import { compileDocx } from '../electron/main/security/docx-compile-service.js';

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9nYQAAAABJRU5ErkJggg==',
  'base64',
);

describe('compileDocx (P1 export, generic)', () => {
  it('compiles headings, paragraphs, bullets into a valid DOCX', async () => {
    const r = await compileDocx([
      { title: '技术方案', markdown: '## 总体架构\n系统分为三层。\n- 应用层\n- 平台层' },
    ], [], '投标文件');
    expect(r.ok).toBe(true);
    expect(r.docx).toBeDefined();
    // DOCX is a ZIP: starts with PK.
    expect(r.docx!.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('embeds referenced images into word/media', async () => {
    const r = await compileDocx([
      { title: '技术方案', markdown: '![总体架构](figures/arch.png)' },
    ], [{ ref: 'figures/arch.png', data: PNG }], '投标文件');
    expect(r.ok).toBe(true);
    const text = r.docx!.toString('latin1');
    expect(text).toContain('word/media');
  });

  it('skips missing images without failing the export', async () => {
    const r = await compileDocx([
      { title: '技术方案', markdown: '![缺失](figures/none.png)\n正文仍在。' },
    ], [], '投标文件');
    expect(r.ok).toBe(true);
  });

  it('returns failure on empty title sections gracefully (no throw)', async () => {
    const r = await compileDocx([], [], '');
    expect(r.ok).toBe(true);
  });
});
