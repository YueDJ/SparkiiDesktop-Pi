import { ConnectorError, SparkiiRagClient, type RetrievalResult } from '@sparkii/connectors';
import {
  knowledgeFromManifest,
  ragFromSettings,
  type KnowledgeSelection,
  type ProfileKnowledge,
  type RagSettings,
} from './rag-settings.js';

export type { KnowledgeSelection };

export const SPARKIIRAG_UNCONFIGURED = '请先在设置 → 知识库配置 SparkiiRAG';
export const SPARKIIRAG_EMPTY = '请先在 SparkiiRAG 建库';
export const SESSION_DATASET_GONE = '所选知识库已不可见，请重新选择';

export function denied(message: string): { ok: false; error: { code: 'CONNECTOR_DENIED'; message: string } } {
  return { ok: false, error: { code: 'CONNECTOR_DENIED', message } };
}

export async function executeKnowledgeSearch(opts: {
  args: Record<string, unknown>;
  profileId: string;
  sessionId: string;
  backend: 'bm25' | 'sparkiirag';
  picker: 'hidden' | 'session';
  selection: KnowledgeSelection | null;
  configured: boolean;
  listDatasets: () => Promise<Array<{ id: string; name: string }>>;
  retrieve: (datasetIds: string[], question: string, topK: number) => Promise<RetrievalResult>;
  bm25: (query: string, topK: number) => Promise<unknown>;
  defaultDatasetId?: string;
  persistDefault?: (id: string) => Promise<void>;
}): Promise<{ ok: boolean; data?: RetrievalResult | unknown; error?: { code: string; message: string } }> {
  const query = String(opts.args.query ?? '');
  const topK = Number(opts.args.topK ?? 6);

  if (opts.backend === 'bm25') {
    return { ok: true, data: await opts.bm25(query, topK) };
  }

  if (!opts.configured) return denied(SPARKIIRAG_UNCONFIGURED);

  const datasets = await opts.listDatasets();
  if (datasets.length === 0) return denied(SPARKIIRAG_EMPTY);
  const allowed = new Set(datasets.map((d) => d.id));

  let datasetIds: string[];
  if (opts.picker === 'session' && opts.selection?.mode === 'ids') {
    if (!opts.selection.datasetIds.length || !opts.selection.datasetIds.every((id) => allowed.has(id))) {
      return denied(SESSION_DATASET_GONE);
    }
    datasetIds = opts.selection.datasetIds;
  } else if (opts.picker === 'session' && opts.selection?.mode === 'all') {
    datasetIds = datasets.map((d) => d.id);
  } else {
    const fallback = opts.defaultDatasetId && allowed.has(opts.defaultDatasetId)
      ? opts.defaultDatasetId
      : datasets[0].id;
    if (fallback !== opts.defaultDatasetId) await opts.persistDefault?.(fallback);
    datasetIds = [fallback];
  }

  return { ok: true, data: await opts.retrieve(datasetIds, query, topK) };
}

export function searchAuditSummary(query: string, data: unknown): string {
  const names = documentNames(data);
  return `${query.slice(0, 120)}${names ? ` ${names}` : ''}`;
}

function documentNames(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as { documents?: Array<{ documentName?: unknown }>; id?: unknown };
  if (Array.isArray(rec.documents)) {
    return rec.documents
      .map((d) => (typeof d.documentName === 'string' ? d.documentName : ''))
      .filter(Boolean)
      .join(',');
  }
  return '';
}

export async function runMainKnowledgeSearch(opts: {
  args: Record<string, unknown>;
  profileId: string;
  sessionId: string;
  selection: KnowledgeSelection | null;
  knowledge: ProfileKnowledge;
  rag: RagSettings;
  apiKey: string | null;
  bm25: (query: string, topK: number) => Promise<unknown>;
  persistDefault?: (id: string) => Promise<void>;
}): Promise<{ ok: boolean; data?: RetrievalResult | unknown; error?: { code: string; message: string } }> {
  const client = opts.apiKey
    ? new SparkiiRagClient({ baseUrl: opts.rag.baseUrl, apiKey: opts.apiKey })
    : null;
  try {
    return await executeKnowledgeSearch({
      args: opts.args,
      profileId: opts.profileId,
      sessionId: opts.sessionId,
      backend: opts.knowledge.backend,
      picker: opts.knowledge.picker,
      selection: opts.selection,
      configured: Boolean(opts.rag.baseUrl && opts.apiKey),
      defaultDatasetId: opts.rag.bindings.find((b) => b.agentId === opts.profileId)?.defaultDatasetId,
      listDatasets: () => client ? client.listDatasets() : Promise.resolve([]),
      retrieve: (datasetIds, question, topK) => {
        if (!client) throw new ConnectorError('CONNECTOR_DENIED', SPARKIIRAG_UNCONFIGURED);
        return client.retrieve({
          question,
          datasetIds,
          similarityThreshold: opts.rag.similarityThreshold,
          vectorSimilarityWeight: opts.rag.vectorSimilarityWeight,
          topK,
        });
      },
      bm25: opts.bm25,
      persistDefault: opts.persistDefault,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      error: {
        code: err instanceof ConnectorError ? err.code : 'CONNECTOR_IO',
        message: err.message ?? String(e),
      },
    };
  }
}

export { knowledgeFromManifest, ragFromSettings };
