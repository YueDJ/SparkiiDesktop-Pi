import { describe, expect, it, vi } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
      }),
    }),
  }),
}));

import { probePdf } from '../src/document/native-markdown.js';

describe('probePdf empty text layer', () => {
  it('returns empty string textLayer on success with no text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probe-empty-'));
    const path = join(dir, 'a.pdf');
    await writeFile(path, '%PDF-1.4 fake');
    const result = await probePdf(path);
    expect(result).toEqual({ textLayer: '', pageCount: 2, pages: ['', ''] });
    expect(result.textLayer).not.toBeNull();
  });
});
