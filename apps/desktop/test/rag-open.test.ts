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

  it('keeps the same documentId in separate caches per backend', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'rag-cache-'));
    dirs.push(cacheDir);
    const fetchDocument = vi.fn(async () => new Uint8Array([9, 9]));
    const rag = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      backend: 'sparkiirag',
      datasetId: 'law',
      documentId: 'shared-doc',
      fileName: '办法.pdf',
    });
    const onto = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      backend: 'sparkiionto',
      datasetId: 'd264d494',
      documentId: 'shared-doc',
      fileName: '办法.pdf',
    });
    const norm = (p: string) => p.replace(/\\/g, '/');
    expect(norm(rag.path)).toMatch(/\/sparkiirag\/law\/shared-doc\.pdf$/);
    expect(norm(onto.path)).toMatch(/\/sparkiionto\/d264d494\/shared-doc\.pdf$/);
    expect(onto.path).not.toBe(rag.path);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it('still reads the legacy flat cache path instead of re-downloading', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'rag-cache-'));
    dirs.push(cacheDir);
    await writeFile(join(cacheDir, 'legacy.pdf'), Buffer.from([7]));
    const fetchDocument = vi.fn(async () => new Uint8Array([1]));
    const out = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      backend: 'sparkiionto',
      datasetId: 'd264d494',
      documentId: 'legacy',
      fileName: 'legacy.pdf',
    });
    expect(out.path).toBe(join(cacheDir, 'legacy.pdf'));
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it('does not let a dataset id escape the cache directory', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'rag-cache-'));
    dirs.push(cacheDir);
    const fetchDocument = vi.fn(async () => new Uint8Array([1]));
    const out = await fetchAndCacheDocument({
      client: { fetchDocument },
      cacheDir,
      backend: 'sparkiionto',
      datasetId: '../..',
      documentId: '../escape',
      fileName: 'a.pdf',
    });
    expect(out.path.startsWith(cacheDir)).toBe(true);
  });
});
