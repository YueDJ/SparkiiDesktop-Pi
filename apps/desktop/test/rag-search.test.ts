import { describe, it, expect, vi, afterEach } from 'vitest';
import { SparkiiOntoClient, SparkiiRagClient } from '@sparkii/connectors';
import {
  executeKnowledgeSearch,
  knowledgeClientFor,
  runMainKnowledgeSearch,
  SPARKIIONTO_EMPTY,
  SPARKIIONTO_UNCONFIGURED,
} from '../electron/main/rag-search.js';

const datasets = [{ id: 'law', name: '法规' }, { id: 'hr', name: '制度' }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('executeKnowledgeSearch', () => {
  it('ignores model-supplied datasetId and uses default', async () => {
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law']);
      return { chunks: [{ id: 'c', content: 'x', documentId: 'd', documentName: 'f', datasetId: 'law', similarity: 1 }], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q', datasetId: 'hack' },
      profileId: 'any',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      defaultDatasetId: 'law',
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to bm25 when sparkiirag is selected', async () => {
    const bm25 = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'sparkiirag', picker: 'session', selection: null, configured: false,
      listDatasets: async () => [],
      retrieve: async () => { throw new Error('no'); },
      bm25,
    });
    expect(out.ok).toBe(false);
    expect(bm25).not.toHaveBeenCalled();
  });

  it('uses bm25 only when backend is bm25', async () => {
    const retrieve = vi.fn();
    const bm25 = vi.fn(async () => [{ id: 'chunk-0', text: 'hit', score: 1 }]);
    const out = await executeKnowledgeSearch({
      args: { query: 'q', dataset_ids: ['hack'] },
      profileId: 'a',
      sessionId: 's',
      backend: 'bm25',
      picker: 'hidden',
      selection: null,
      configured: false,
      listDatasets: async () => datasets,
      retrieve,
      bm25,
    });
    expect(out.ok).toBe(true);
    expect(bm25).toHaveBeenCalledWith('q', 6);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('replaces a stale default with the first listed dataset and persists it', async () => {
    const persistDefault = vi.fn(async () => {});
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law']);
      return { chunks: [], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      defaultDatasetId: 'gone',
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
      persistDefault,
    });
    expect(out.ok).toBe(true);
    expect(persistDefault).toHaveBeenCalledWith('law');
  });

  it('denies a session selection that is not in the current list', async () => {
    const retrieve = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'session',
      selection: { mode: 'ids', datasetIds: ['gone'] },
      configured: true,
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('CONNECTOR_DENIED');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('uses every listed dataset when session selection is all', async () => {
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law', 'hr']);
      return { chunks: [], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'session',
      selection: { mode: 'all' },
      configured: true,
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('denies when the key can list no datasets', async () => {
    const retrieve = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      listDatasets: async () => [],
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/建库/);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('keeps per-backend "unconfigured" and "empty corpus" wording', async () => {
    const unconfigured = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'sparkiionto', picker: 'hidden', selection: null, configured: false,
      listDatasets: async () => datasets,
      retrieve: async () => { throw new Error('no'); },
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.error?.message).toBe(SPARKIIONTO_UNCONFIGURED);

    const empty = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'sparkiionto', picker: 'hidden', selection: null, configured: true,
      listDatasets: async () => [],
      retrieve: async () => { throw new Error('no'); },
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(empty.ok).toBe(false);
    expect(empty.error?.message).toBe(SPARKIIONTO_EMPTY);
  });

  it('tags onto chunks and documents with the backend, but leaves bm25 untouched', async () => {
    const onto = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'sparkiionto', picker: 'hidden', selection: null, configured: true,
      defaultDatasetId: 'law',
      listDatasets: async () => datasets,
      retrieve: async () => ({
        chunks: [{ id: 'c', content: 'x', documentId: 'd', documentName: 'f', datasetId: 'law', similarity: 1 }],
        documents: [{ documentId: 'd', documentName: 'f', chunkCount: 1 }],
      }),
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect((onto.data as { chunks: Array<{ backend?: string }> }).chunks[0].backend).toBe('sparkiionto');
    expect((onto.data as { documents: Array<{ backend?: string }> }).documents[0].backend).toBe('sparkiionto');

    const bm25Out = [{ id: 'chunk-0', text: 'hit', score: 1 }];
    const bm25 = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'bm25', picker: 'hidden', selection: null, configured: false,
      listDatasets: async () => datasets,
      retrieve: async () => { throw new Error('no'); },
      bm25: async () => bm25Out,
    });
    expect(bm25.data).toEqual(bm25Out);
  });
});

describe('knowledgeClientFor', () => {
  const rag = { baseUrl: 'http://127.0.0.1:9380', similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, bindings: [] };

  it('picks one client per backend and returns null for bm25 or a missing credential', () => {
    expect(knowledgeClientFor('bm25', rag, 'key')).toBeNull();
    expect(knowledgeClientFor('sparkiirag', rag, null)).toBeNull();
    expect(knowledgeClientFor('sparkiirag', rag, 'key')).toBeInstanceOf(SparkiiRagClient);
    expect(knowledgeClientFor('sparkiionto', rag, 'tok')).toBeInstanceOf(SparkiiOntoClient);
  });
});

describe('runMainKnowledgeSearch over SparkiiOnto', () => {
  const ontoInfo = {
    product: 'SparkiiOnto',
    version: '0.6.8',
    api_version: 'v1',
    deployment_profile: 'single-instance',
    retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
    capabilities: { datasets: true, document_fetch: true },
  };

  function stubOnto(options: { chunks: unknown[]; docAggs: unknown[] }) {
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      urls.push(path);
      if (path === '/api/v1/info') {
        return new Response(JSON.stringify(ontoInfo), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/datasets') {
        return new Response('{"code":0,"data":[{"id":"d264d494","name":"水泥工艺知识域"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/retrieval') {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({ code: 0, data: { chunks: options.chunks, doc_aggs: options.docAggs } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    return { bodies, urls };
  }

  const ontoKnowledge = { enabled: true, backend: 'sparkiionto', picker: 'hidden' } as const;

  it('passes the configured threshold/topK to the Onto client and tags the hits', async () => {
    const { bodies } = stubOnto({
      chunks: [{
        id: 'c1', content: '高温津贴按日计发', document_keyword: '水泥工艺.md',
        document_id: 'doc-1', dataset_id: 'd264d494',
        similarity: 0.9, term_similarity: 0.9, vector_similarity: 0,
      }],
      docAggs: [{ doc_id: 'doc-1', doc_name: '水泥工艺.md', count: 1 }],
    });
    const out = await runMainKnowledgeSearch({
      args: { query: '高温津贴按日计发', topK: 50 },
      profileId: 'onto-agent',
      sessionId: 's1',
      backend: 'sparkiionto',
      selection: null,
      knowledge: ontoKnowledge,
      rag: {
        baseUrl: 'http://onto.example:9380',
        similarityThreshold: 0.45,
        vectorSimilarityWeight: 0.3,
        bindings: [{ agentId: 'onto-agent', defaultDatasetId: 'd264d494' }],
      },
      apiKey: 'tok-onto',
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    // 出站 body 必须完整：必填但被忽略的 vector_similarity_weight 也要在（漏传即 422）。
    expect(bodies[0]).toEqual({
      question: '高温津贴按日计发',
      dataset_ids: ['d264d494'],
      similarity_threshold: 0.45,
      vector_similarity_weight: 0.3,
      page_size: 20,
    });
    const data = out.data as { chunks: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>> };
    expect(data.chunks[0]).toMatchObject({
      documentId: 'doc-1', documentName: '水泥工艺.md', datasetId: 'd264d494',
      termSimilarity: 0.9, vectorSimilarity: 0, backend: 'sparkiionto',
    });
    expect(data.documents[0]).toMatchObject({ documentId: 'doc-1', backend: 'sparkiionto' });
  });

  it('returns an empty result for an Onto miss (the refuse decision stays in the caller)', async () => {
    stubOnto({ chunks: [], docAggs: [] });
    const out = await runMainKnowledgeSearch({
      args: { query: '不存在的问句' },
      profileId: 'onto-agent',
      sessionId: 's1',
      backend: 'sparkiionto',
      selection: null,
      knowledge: ontoKnowledge,
      rag: {
        baseUrl: 'http://onto.example:9380',
        similarityThreshold: 0.2,
        vectorSimilarityWeight: 0.3,
        bindings: [{ agentId: 'onto-agent', defaultDatasetId: 'd264d494' }],
      },
      apiKey: 'tok-onto',
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    expect((out.data as { chunks: unknown[] }).chunks).toEqual([]);
  });
});
