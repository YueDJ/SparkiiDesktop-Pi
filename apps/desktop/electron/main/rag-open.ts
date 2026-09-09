import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export async function fetchAndCacheDocument(opts: {
  client: { fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array> };
  cacheDir: string;
  datasetId: string;
  documentId: string;
  fileName?: string;
}): Promise<{ path: string }> {
  await mkdir(opts.cacheDir, { recursive: true });
  const ext = extname(opts.fileName ?? '') || '';
  const safeId = opts.documentId.replace(/[<>:"/\\|?*]/g, '_');
  const path = join(opts.cacheDir, `${safeId}${ext}`);
  if (existsSync(path)) return { path };
  const bytes = await opts.client.fetchDocument(opts.datasetId, opts.documentId);
  await writeFile(path, Buffer.from(bytes));
  return { path };
}

export async function openCachedDocument(opts: {
  path: string;
  openFile: (path: string) => Promise<string>;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const error = await opts.openFile(opts.path);
  if (error) return { ok: false, error };
  return { ok: true, path: opts.path };
}
