import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/document/index.js';

describe('parseDocument', () => {
  it('parses plain text by extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello contract');
    expect((await parseDocument(p)).text).toContain('hello contract');
  });
  it('rejects unknown extension with typed error', async () => {
    await expect(parseDocument(join(tmpdir(), 'x.unknownext'))).rejects.toMatchObject({ code: 'CONNECTOR_UNSUPPORTED' });
  });
});
