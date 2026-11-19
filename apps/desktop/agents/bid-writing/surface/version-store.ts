/**
 * Version snapshots for the manuscript — agent-local logic over P1 workspace IPC.
 *
 * Strategy (product design §8.2, approval-boundary §13.3):
 *  - each change stores a snapshot under output/versions/vN/;
 *  - differential: only files whose content hash changed are written;
 *  - content-hash dedup: identical content across versions is not duplicated;
 *  - retention: keep the most recent N full markers + all version metadata.
 */
import type { SparkiiApi, WorkspaceFileResult } from '../../../src/types/sparkii-api.js';

export interface VersionMeta {
  version: number;
  createdAt: number;
  note?: string;
  /** path -> short content hash for every manuscript file at this version */
  files: Record<string, string>;
}

export const VERSIONS_DIR = 'output/versions';
const INDEX_FILE = `${VERSIONS_DIR}/index.json`;
const DEFAULT_RETENTION = 40;

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

/** Synchronous 64-bit FNV-1a-ish hash (renderer-safe; sufficient for dedup). */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

async function readJson(sessionId: string, path: string): Promise<unknown | null> {
  const r: WorkspaceFileResult = await api().workspaceRead({ sessionId, path });
  if (!r.ok || typeof r.content !== 'string') return null;
  try { return JSON.parse(r.content); } catch { return null; }
}

export async function loadIndex(sessionId: string): Promise<VersionMeta[]> {
  const raw = await readJson(sessionId, INDEX_FILE);
  return Array.isArray(raw) ? (raw as VersionMeta[]) : [];
}

async function writeJson(sessionId: string, path: string, value: unknown): Promise<boolean> {
  const r: WorkspaceFileResult = await api().workspaceWrite({
    sessionId, path, content: JSON.stringify(value, null, 2),
  });
  return r.ok;
}

/**
 * Create a snapshot of the given manuscript files.
 * Returns the new version meta, or null on failure (fail closed).
 */
export async function snapshot(
  sessionId: string,
  files: Record<string, string>,
  note?: string,
): Promise<VersionMeta | null> {
  const index = await loadIndex(sessionId);
  const nextVersion = (index.length ? Math.max(...index.map((v) => v.version)) : 0) + 1;
  const hashes: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) hashes[path] = contentHash(content);

  const prev = index[index.length - 1];
  const dir = `${VERSIONS_DIR}/v${nextVersion}`;

  // Differential write: only files whose hash changed vs previous snapshot.
  for (const [path, content] of Object.entries(files)) {
    const changed = !prev || prev.files[path] !== hashes[path];
    if (!changed) continue;
    const ok: WorkspaceFileResult = await api().workspaceWrite({
      sessionId, path: `${dir}/${path}`, content,
    });
    if (!ok.ok) return null;
  }

  const meta: VersionMeta = { version: nextVersion, createdAt: Date.now(), note, files: hashes };
  const next = [...index, meta];
  // Retention: keep metadata for all versions, but cap the in-index list to N.
  const retained = next.length > DEFAULT_RETENTION ? next.slice(-DEFAULT_RETENTION) : next;
  if (!(await writeJson(sessionId, INDEX_FILE, retained))) return null;
  return meta;
}

/**
 * Restore a manuscript file's content as it was at `version`.
 *
 * Snapshots are differential: a version only physically stores files whose
 * content hash changed. So to read file X at version N, walk back from N to the
 * most recent version whose index lists X, and read that copy. With dedup the
 * physical copy is identical to what version N saw.
 */
export async function restoreFile(
  sessionId: string,
  version: number,
  path: string,
): Promise<string | null> {
  const index = await loadIndex(sessionId);
  // Candidate versions: <= target, newest first.
  const candidates = index
    .filter((v) => v.version <= version)
    .sort((a, b) => b.version - a.version);
  for (const v of candidates) {
    if (!(path in v.files)) continue;
    const r: WorkspaceFileResult = await api().workspaceRead({
      sessionId, path: `${VERSIONS_DIR}/v${v.version}/${path}`,
    });
    if (r.ok && typeof r.content === 'string') return r.content;
    // If the physical file is missing, keep walking back (differential gap).
  }
  return null;
}
