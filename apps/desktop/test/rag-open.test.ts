import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAndCacheDocument } from '../electron/main/rag-open.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe('fetchAndCacheDocument', () => {
  it('writes bytes once and skips fetch on the second call', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'rag-cache-'));
    dirs.push(cacheDir);
    const fetchDocument = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const first = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      datasetId: 'law',
      documentId: 'd1',
      fileName: '高温作业津贴办法.pdf',
    });
    expect(first.path).toMatch(/d1\.pdf$/);
    expect(await readFile(first.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchDocument).toHaveBeenCalledTimes(1);

    const second = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      datasetId: 'law',
      documentId: 'd1',
      fileName: '高温作业津贴办法.pdf',
    });
    expect(second.path).toBe(first.path);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });
});
