import { ConnectorError, SparkiiOntoClient, SparkiiRagClient, type RetrievalResult } from '@sparkii/connectors';
import {
  knowledgeFromManifest,
  ragFromSettings,
  type KnowledgeSelection,
  type ProfileKnowledge,
  type RagSettings,
} from './rag-settings.js';
import type { KnowledgeBackendId } from './knowledge-settings.js';

export type { KnowledgeSelection };

export const SPARKIIRAG_UNCONFIGURED = '请先在设置 → 知识库配置 SparkiiRAG';
export const SPARKIIRAG_EMPTY = '请先在 SparkiiRAG 建库';
export const SESSION_DATASET_GONE = '所选知识库已不可见，请重新选择';

export function denied(message: string): { ok: false; error: { code: 'CONNECTOR_DENIED'; message: string } } {
  return { ok: false, error: { code: 'CONNECTOR_DENIED', message } };
}

/** 远端知识服务的最小客户端面（`SparkiiRagClient` / `SparkiiOntoClient` 都满足）。 */
export type KnowledgeSearchClient = {
  listDatasets(): Promise<Array<{ id: string; name: string }>>;
  retrieve(input: {
    question: string;
    datasetIds: string[];
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    topK?: number;
  }): Promise<RetrievalResult>;
  fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array>;
};

/**
 * 按后端造客户端：`bm25`（本地语料）与缺凭据都返回 `null`；
 * 其余按后端选各自 client（出站字段差异由 client 自己负责，调用方只给该后端的配置）。
 */
export function knowledgeClientFor(
  backend: 'bm25' | KnowledgeBackendId,
  rag: RagSettings,
  credential: string | null,
): KnowledgeSearchClient | null {
  if (backend === 'bm25' || !credential) return null;
  return backend === 'sparkiionto'
    ? new SparkiiOntoClient({ baseUrl: rag.baseUrl, apiKey: credential })
    : new SparkiiRagClient({ baseUrl: rag.baseUrl, apiKey: credential });
}

/** `knowledge.search` 只连 SparkiiRAG（本体已移入 `ontology.*`），文案逐字节保持现状。 */
function unconfiguredFor(_backend: ProfileKnowledge['backend']): string {
  return SPARKIIRAG_UNCONFIGURED;
}

function emptyCorpusFor(_backend: ProfileKnowledge['backend']): string {
  return SPARKIIRAG_EMPTY;
}

/** 把本轮后端写进命中片段/文档，供出处归属使用（`bm25` 不经过这里）。 */
function tagBackend<T>(data: T, backend: ProfileKnowledge['backend']): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const rec = data as Record<string, unknown>;
  const tagged: Record<string, unknown> = { ...rec };
  if (Array.isArray(rec.chunks)) tagged.chunks = rec.chunks.map((item) => withBackend(item, backend));
  if (Array.isArray(rec.documents)) tagged.documents = rec.documents.map((item) => withBackend(item, backend));
  return tagged as T;
}

function withBackend(item: unknown, backend: ProfileKnowledge['backend']): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return { ...(item as Record<string, unknown>), backend };
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

  if (!opts.configured) return denied(unconfiguredFor(opts.backend));

  const datasets = await opts.listDatasets();
  if (datasets.length === 0) return denied(emptyCorpusFor(opts.backend));
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

  return { ok: true, data: tagBackend(await opts.retrieve(datasetIds, query, topK), opts.backend) };
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
  backend: ProfileKnowledge['backend'];
  selection: KnowledgeSelection | null;
  knowledge: ProfileKnowledge;
  rag: RagSettings;
  apiKey: string | null;
  bm25: (query: string, topK: number) => Promise<unknown>;
  persistDefault?: (id: string) => Promise<void>;
}): Promise<{ ok: boolean; data?: RetrievalResult | unknown; error?: { code: string; message: string } }> {
  const client = knowledgeClientFor(opts.backend, opts.rag, opts.apiKey);
  try {
    return await executeKnowledgeSearch({
      args: opts.args,
      profileId: opts.profileId,
      sessionId: opts.sessionId,
      backend: opts.backend,
      picker: opts.knowledge.picker,
      selection: opts.selection,
      configured: Boolean(opts.rag.baseUrl && opts.apiKey),
      defaultDatasetId: opts.rag.bindings.find((b) => b.agentId === opts.profileId)?.defaultDatasetId,
      listDatasets: () => client ? client.listDatasets() : Promise.resolve([]),
      retrieve: (datasetIds, question, topK) => {
        if (!client) throw new ConnectorError('CONNECTOR_DENIED', unconfiguredFor(opts.backend));
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
