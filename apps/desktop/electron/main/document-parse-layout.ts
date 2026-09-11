import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeRoot } from './runtime-layout.js';

export const DOCUMENT_PARSE_ARCHIVE_NAME = 'sparkii-document-parse.7z.exe';

export interface DocumentParsePaths {
  root: string;
  exe: string;
  ready: string;
  models: string;
}

export interface EnsureDocumentParseOptions {
  archivePath?: string | null;
  resourcesPath?: string;
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
export const MIN_DOCUMENT_PARSE_DISK_BYTES = 512 * 1024 ** 2;

/** True when the exe or baseline READY sentinel is missing. */
export function needsDocumentParse(env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = resolveDocumentParsePaths(env);
  return !existsSync(paths.exe) || !existsSync(paths.ready);
}

function repoArchiveCandidates(): string[] {
  const fromModule = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../runtime/document-parse',
    DOCUMENT_PARSE_ARCHIVE_NAME,
  );
  const fromCwdDesktop = join(process.cwd(), 'apps/desktop/runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
  const fromCwdRuntime = join(process.cwd(), 'runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
  return [fromModule, fromCwdDesktop, fromCwdRuntime];
}

export function documentParseArchivePath(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath?: string,
): string | null {
  const override = env.SPARKII_DOCUMENT_PARSE_ARCHIVE;
  if (override) {
    return existsSync(override) ? override : null;
  }
  const candidates = [
    resourcesPath ? join(resourcesPath, 'runtime', 'document-parse', DOCUMENT_PARSE_ARCHIVE_NAME) : undefined,
    ...repoArchiveCandidates(),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Extract the 7z SFX when present. If the archive is missing, skip — do not throw.
 * `document.read` still fails with NOT_READY when nothing was extracted.
 */
export async function ensureDocumentParse(
  env: NodeJS.ProcessEnv = process.env,
  opts: EnsureDocumentParseOptions = {},
): Promise<void> {
  if (!needsDocumentParse(env)) return;
  const archivePath = opts.archivePath !== undefined
    ? opts.archivePath
    : documentParseArchivePath(env, opts.resourcesPath);
  if (!archivePath || !existsSync(archivePath)) {
    return;
  }
  const dest = resolveDocumentParsePaths(env).root;
  mkdirSync(dest, { recursive: true });
  await extractArchive(archivePath, dest);
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

function extractArchive(archivePath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(archivePath, [`-o${dest}`, '-y'], { windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`document-parse extraction failed with exit code ${code}`));
    });
  });
}
