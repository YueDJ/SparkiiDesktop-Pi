import { loadSettings, saveSettings, type AppSettings } from './settings.js';

export const DEFAULT_RAG_BASE_URL = 'http://127.0.0.1:9380';

export type AgentKnowledgeBinding = {
  agentId: string;
  defaultDatasetId: string;
};

export type RagSettings = {
  baseUrl: string;
  similarityThreshold: number;
  vectorSimilarityWeight: number;
  bindings: AgentKnowledgeBinding[];
};

export type KnowledgeSelection =
  | { mode: 'ids'; datasetIds: string[] }
  | { mode: 'all' };

export type ProfileKnowledge = {
  enabled: boolean;
  backend: 'bm25' | 'sparkiirag';
  picker: 'hidden' | 'session';
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBindings(value: unknown): AgentKnowledgeBinding[] {
  if (!Array.isArray(value)) return [];
  const out: AgentKnowledgeBinding[] = [];
  for (const item of value) {
    const rec = (item ?? {}) as Record<string, unknown>;
    if (typeof rec.agentId !== 'string' || typeof rec.defaultDatasetId !== 'string') continue;
    if (!rec.agentId || !rec.defaultDatasetId) continue;
    out.push({ agentId: rec.agentId, defaultDatasetId: rec.defaultDatasetId });
  }
  return out;
}

export function ragFromSettings(s: AppSettings): RagSettings {
  const rag = s.rag ?? {};
  const baseUrl = typeof rag.baseUrl === 'string' && rag.baseUrl.trim()
    ? rag.baseUrl.replace(/\/+$/, '')
    : DEFAULT_RAG_BASE_URL;
  return {
    baseUrl,
    similarityThreshold: asNumber(rag.similarityThreshold, 0.2),
    vectorSimilarityWeight: asNumber(rag.vectorSimilarityWeight, 0.3),
    bindings: asBindings(rag.bindings),
  };
}

export function knowledgeFromManifest(manifest: unknown): ProfileKnowledge {
  const knowledge = (manifest as { knowledge?: Record<string, unknown> } | undefined)?.knowledge;
  return {
    enabled: knowledge?.enabled === true,
    backend: knowledge?.backend === 'sparkiirag' ? 'sparkiirag' : 'bm25',
    picker: knowledge?.picker === 'session' ? 'session' : 'hidden',
  };
}

export async function patchRagSettings(
  dataDir: string,
  partial: Partial<RagSettings>,
): Promise<RagSettings> {
  const prev = await loadSettings(dataDir);
  const current = ragFromSettings(prev);
  const next: RagSettings = {
    baseUrl: typeof partial.baseUrl === 'string' && partial.baseUrl.trim()
      ? partial.baseUrl.replace(/\/+$/, '')
      : current.baseUrl,
    similarityThreshold: partial.similarityThreshold ?? current.similarityThreshold,
    vectorSimilarityWeight: partial.vectorSimilarityWeight ?? current.vectorSimilarityWeight,
    bindings: partial.bindings ?? current.bindings,
  };
  await saveSettings(dataDir, { ...prev, rag: next });
  return next;
}
