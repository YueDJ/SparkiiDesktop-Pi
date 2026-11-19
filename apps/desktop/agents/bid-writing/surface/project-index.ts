/**
 * T1 — project-private material on-demand retrieval (agent-local, no platform IPC).
 *
 * Implements the "A project-level index" goal with a portable, renderer-safe
 * design: at import time materials are split into chunks and a lightweight JSON
 * index is written under `input/.index/` via P1 workspace IPC. A new session
 * loads the index and retrieves matching chunks by keyword scoring, then reads
 * the source file on demand. Falls back to `input/manifest.md` summary list for
 * short queries. No platform-side search capability is added (P6 stays idle).
 */
import type { SparkiiApi, WorkspaceFileResult } from '../../../src/types/sparkii-api.js';

export interface IndexChunk {
  file: string;
  chunk: number;
  text: string;
}

export interface ProjectIndex {
  builtAt: number;
  chunks: IndexChunk[];
}

export interface RetrievalHit {
  file: string;
  chunk: number;
  text: string;
  score: number;
}

const INDEX_PATH = 'input/.index/chunks.json';

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export function chunkText(text: string, size = 800, overlap = 100): string[] {
  const clean = text.replace(/\r/g, '');
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + size);
    out.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return out;
}

/** Build the index from a map of input-file -> extracted text. */
export async function buildIndex(sessionId: string, docs: Record<string, string>): Promise<boolean> {
  const chunks: IndexChunk[] = [];
  for (const [file, text] of Object.entries(docs)) {
    chunkText(text).forEach((part, i) => chunks.push({ file, chunk: i, text: part }));
  }
  const index: ProjectIndex = { builtAt: Date.now(), chunks };
  const r: WorkspaceFileResult = await api().workspaceWrite({
    sessionId, path: INDEX_PATH, content: JSON.stringify(index),
  });
  return r.ok;
}

export async function loadIndex(sessionId: string): Promise<ProjectIndex | null> {
  const r: WorkspaceFileResult = await api().workspaceRead({ sessionId, path: INDEX_PATH });
  if (!r.ok || typeof r.content !== 'string') return null;
  try { return JSON.parse(r.content) as ProjectIndex; } catch { return null; }
}

/** Score chunks by query term overlaps. Chinese-friendly: uses n-gram fallback. */
export function retrieve(index: ProjectIndex, query: string, topK = 5): RetrievalHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits: RetrievalHit[] = [];
  for (const c of index.chunks) {
    const lower = c.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const count = lower.split(t).length - 1;
      if (count > 0) score += Math.min(count, 5) * t.length;
    }
    if (score > 0) hits.push({ file: c.file, chunk: c.chunk, text: c.text, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function queryTerms(query: string): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/[\s，。、；：,.!?！？/\\]+/).filter((w) => w.length >= 2);
  // For CJK runs ≥3 chars also add trigrams to improve substring matching.
  const grams: string[] = [];
  for (const w of words) {
    grams.push(w);
    if (/[\u4e00-\u9fa5]/.test(w) && w.length >= 3) {
      for (let i = 0; i + 3 <= w.length; i++) grams.push(w.slice(i, i + 3));
    }
  }
  return [...new Set(grams)];
}

export async function loadManifest(sessionId: string): Promise<string> {
  const r: WorkspaceFileResult = await api().workspaceRead({ sessionId, path: 'input/manifest.md' });
  return r.ok && typeof r.content === 'string' ? r.content : '';
}

/**
 * Rebuild the docs map from the persisted manifest so an incremental add
 * (e.g. from the setup panel) can re-index WITHOUT dropping previously
 * imported material. Returns the docs map and the file list with text.
 */
export async function loadMaterialDocs(sessionId: string): Promise<{
  docs: Record<string, string>;
  files: Array<{ name: string; text: string }>;
}> {
  const manifest = await loadManifest(sessionId);
  const docs: Record<string, string> = {};
  const files: Array<{ name: string; text: string }> = [];
  for (const line of manifest.split('\n')) {
    const name = line.trim().replace(/^-\s*/, '');
    if (!name || name.startsWith('#')) continue;
    const rel = `input/${name}`;
    const r: WorkspaceFileResult = await api().workspaceRead({ sessionId, path: rel });
    if (r.ok && typeof r.content === 'string') {
      docs[rel] = r.content;
      files.push({ name, text: r.content });
    }
  }
  return { docs, files };
}
