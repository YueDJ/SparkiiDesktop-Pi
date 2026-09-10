import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveRuntimeRoot } from './runtime-layout.js';

export interface DocumentParsePaths {
  root: string;
  exe: string;
  ready: string;
  models: string;
}

export function resolveDocumentParsePaths(env: NodeJS.ProcessEnv = process.env): DocumentParsePaths {
  const root = join(resolveRuntimeRoot(env), 'document-parse');
  return {
    root,
    exe: join(root, 'bin', 'sparkii-document-parse.exe'),
    ready: join(root, 'models', 'baseline', 'READY'),
    models: join(root, 'models'),
  };
}

export const DOCUMENT_PARSE_NOT_READY = '文档解析尚未就绪，请到设置 → 文档解析查看。';
export const DOCUMENT_PARSE_DISK_FULL = '磁盘空间不足，无法准备文档解析。';
export const MIN_DOCUMENT_PARSE_DISK_BYTES = 2 * 1024 ** 3;

/** True when the exe or baseline READY sentinel is missing. Ensure/extract is Task 9. */
export function needsDocumentParse(env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = resolveDocumentParsePaths(env);
  return !existsSync(paths.exe) || !existsSync(paths.ready);
}

/** Task 9 will unzip; this stub only fails when the runtime is not ready. */
export async function ensureDocumentParse(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (needsDocumentParse(env)) {
    throw new Error(DOCUMENT_PARSE_NOT_READY);
  }
}

export async function diskFreeBytes(targetPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const probe = targetPath ?? resolveDocumentParsePaths(env).root;
  try {
    const stats = await statfs(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    try {
      const stats = await statfs(dirname(probe));
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}
