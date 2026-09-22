import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { KnowledgeBackendId } from './knowledge-settings.js';

export async function fetchAndCacheDocument(opts: {
  client: { fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array> };
  cacheDir: string;
  /** 缺省 = `sparkiirag`（既有调用方不传时的行为不变）。 */
  backend?: KnowledgeBackendId;
  datasetId: string;
  documentId: string;
  fileName?: string;
}): Promise<{ path: string }> {
  const backend: KnowledgeBackendId = opts.backend ?? 'sparkiirag';
  const ext = extname(opts.fileName ?? '') || '';
  const safeId = sanitizeSegment(opts.documentId);
  const safeDataset = sanitizeSegment(opts.datasetId);
  // 按后端分段：同一个 documentId 在两个后端下不再撞车。
  const scoped = join(opts.cacheDir, backend, safeDataset, `${safeId}${ext}`);
  if (existsSync(scoped)) return { path: scoped };
  // 旧版本的扁平路径仍可读（既有缓存不失效）；读不到才回落到分段路径。
  const legacy = join(opts.cacheDir, `${safeId}${ext}`);
  if (existsSync(legacy)) return { path: legacy };
  const bytes = await opts.client.fetchDocument(opts.datasetId, opts.documentId);
  await mkdir(join(opts.cacheDir, backend, safeDataset), { recursive: true });
  await writeFile(scoped, Buffer.from(bytes));
  return { path: scoped };
}

/** 目录/文件名分段：挡掉路径分隔符与 Windows 保留字符，顺带挡住 `..` 之类的穿越。 */
function sanitizeSegment(value: string): string {
  const safe = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
  return safe || '_';
}

export async function openCachedDocument(opts: {
  path: string;
  openFile: (path: string) => Promise<string>;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const error = await opts.openFile(opts.path);
  if (error) return { ok: false, error };
  return { ok: true, path: opts.path };
}
