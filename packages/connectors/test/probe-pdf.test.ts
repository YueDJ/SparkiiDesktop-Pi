import { describe, expect, it, vi } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.reject(new Error('Invalid PDF structure')),
  }),
}));

import { probePdf } from '../src/document/native-markdown.js';
import { ConnectorError } from '../src/types.js';

describe('probePdf failure', () => {
  it('throws ConnectorError instead of faking an empty text layer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probe-'));
    const path = join(dir, 'a.pdf');
    await writeFile(path, '%PDF-1.4 fake');
    await expect(probePdf(path)).rejects.toBeInstanceOf(ConnectorError);
    await expect(probePdf(path)).rejects.toMatchObject({
      code: 'CONNECTOR_IO',
      message: '无法读取该文件。',
    });
  });
});
