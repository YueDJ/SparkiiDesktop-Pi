import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { isPathInside } from './workspace.js';

export type DocumentKind = 'pdf' | 'docx' | 'txt' | 'image';

export type ReadDocumentBytesResult =
  | { kind: DocumentKind; fileName: string; fileSize: number; bytes: ArrayBuffer }
  | { error: 'missing' | 'unsupported' | 'too_large' | 'denied' };

export const PREVIEW_EXTENSIONS = ['.pdf', '.docx', '.txt', '.jpg', '.jpeg', '.png'] as const;
export const DEFAULT_CHOOSE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'txt', 'md'] as const;
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

const granted = new Set<string>();

export function normalizeDocPath(path: string, platform = process.platform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function grantDocumentPath(path: string): void {
  const trimmed = path.trim();
  if (trimmed) granted.add(normalizeDocPath(trimmed));
}

export function resetGrantedDocumentPaths(): void {
  granted.clear();
}

export function documentKindOf(path: string): DocumentKind | null {
  let ext = extname(path).toLowerCase();
  if (!ext) {
    const base = basename(path).toLowerCase();
    if (base.startsWith('.')) ext = base;
  }
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt') return 'txt';
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return 'image';
  return null;
}

export function isDocumentPathAllowed(
  path: string,
  access: { inputs?: { path: string }[]; workspacePath?: string | null },
): boolean {
  const normalized = normalizeDocPath(path);
  if (!normalized) return false;
  if (granted.has(normalized)) return true;
  if (access.inputs?.some((item) => normalizeDocPath(item.path) === normalized)) return true;
  if (access.workspacePath && isPathInside(access.workspacePath, path)) return true;
  return false;
}

export async function readGrantedDocumentBytes(
  path: string,
  access: { inputs?: { path: string }[]; workspacePath?: string | null },
  opts?: { maxBytes?: number },
): Promise<ReadDocumentBytesResult> {
  const kind = documentKindOf(path);
  if (!kind) return { error: 'unsupported' };
  if (!isDocumentPathAllowed(path, access)) return { error: 'denied' };
  const maxBytes = opts?.maxBytes ?? MAX_DOCUMENT_BYTES;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { error: 'missing' };
    if (info.size > maxBytes) return { error: 'too_large' };
    const buf = await readFile(path);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { kind, fileName: basename(path), fileSize: info.size, bytes };
  } catch {
    return { error: 'missing' };
  }
}
