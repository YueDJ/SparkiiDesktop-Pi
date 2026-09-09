import { describe, it, expect, vi } from 'vitest';
import { SparkiiRagClient } from '../src/sparkiirag/client.js';
import { ConnectorError } from '../src/types.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

describe('SparkiiRagClient', () => {
  it('maps retrieval hits and omits unknown fields from the request body', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:9380/api/v1/retrieval');
      expect(headerRecord(init).Authorization).toBe('Bearer sk-x');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        question: '高温津贴',
        dataset_ids: ['ds-1'],
        similarity_threshold: 0.2,
        vector_similarity_weight: 0.3,
        page_size: 6,
      });
      return json({
        code: 0,
        data: {
          chunks: [{
            id: 'c1', content: '津贴按日计', document_id: 'd1', document_keyword: '制度.pdf',
            dataset_id: 'ds-1', similarity: 0.9, term_similarity: 0.8, vector_similarity: 0.7,
          }],
          doc_aggs: [{ doc_id: 'd1', doc_name: '制度.pdf', count: 1 }],
        },
      });
    });
    const client = new SparkiiRagClient({ baseUrl: 'http://127.0.0.1:9380/', apiKey: 'sk-x', fetch: fetchImpl as typeof fetch });
    const out = await client.retrieve({ question: '高温津贴', datasetIds: ['ds-1'], datasetId: 'hack' } as never);
    expect(out.chunks[0]).toMatchObject({ id: 'c1', documentName: '制度.pdf', datasetId: 'ds-1' });
    expect(out.documents[0]).toEqual({ documentId: 'd1', documentName: '制度.pdf', chunkCount: 1 });
  });

  it('clamps retrieve page_size between 1 and 20', async () => {
    const bodies: number[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)).page_size);
      return json({ code: 0, data: { chunks: [] } });
    });
    const client = new SparkiiRagClient({ baseUrl: 'http://x', apiKey: 'sk', fetch: fetchImpl as typeof fetch });
    await client.retrieve({ question: 'q', datasetIds: ['a'], topK: 0 });
    await client.retrieve({ question: 'q', datasetIds: ['a'], topK: 100 });
    expect(bodies).toEqual([1, 20]);
  });

  it('coerces dataset_id arrays and drops chunks below the similarity threshold', async () => {
    const fetchImpl = vi.fn(async () => json({
      code: 0,
      data: {
        chunks: [
          { id: 'keep', content: 'ok', document_id: 'd1', document_keyword: 'a.pdf', dataset_id: ['ds-a', 'ds-b'], similarity: 0.5 },
          { id: 'drop', content: 'weak', document_id: 'd2', document_keyword: 'b.pdf', dataset_id: 'ds-a', similarity: 0.19 },
        ],
      },
    }));
    const client = new SparkiiRagClient({ baseUrl: 'http://x', apiKey: 'sk', fetch: fetchImpl as typeof fetch });
    const out = await client.retrieve({ question: 'q', datasetIds: ['ds-a'], similarityThreshold: 0.2 });
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toMatchObject({ id: 'keep', datasetId: 'ds-a' });
    expect(out.documents).toEqual([]);
  });

  it('drops chunks whose similarity is not a finite number', async () => {
    const client = new SparkiiRagClient({
      baseUrl: 'http://x',
      apiKey: 'sk',
      fetch: async () => json({
        code: 0,
        data: { chunks: [{ id: 'bad', content: 'x', document_id: 'd', document_keyword: 'a', dataset_id: 'ds', similarity: 'nope' }] },
      }),
    });
    const out = await client.retrieve({ question: 'q', datasetIds: ['ds'] });
    expect(out.chunks).toEqual([]);
  });

  it('throws CONNECTOR_DENIED when code !== 0', async () => {
    const client = new SparkiiRagClient({
      baseUrl: 'http://x', apiKey: 'sk',
      fetch: async () => json({ code: 401, message: 'Unauthorized' }),
    });
    await expect(client.retrieve({ question: 'q', datasetIds: ['a'] })).rejects.toMatchObject({
      code: 'CONNECTOR_DENIED',
      message: 'Unauthorized',
    });
  });

  it('throws CONNECTOR_IO when retrieve times out', async () => {
    const client = new SparkiiRagClient({
      baseUrl: 'http://x',
      apiKey: 'sk',
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (!signal) return;
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      }),
    });
    await expect(client.retrieve({ question: 'q', datasetIds: ['a'] })).rejects.toMatchObject({ code: 'CONNECTOR_IO' });
  });

  it('health treats engine healthz status without a code field', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://x/api/v1/system/healthz');
      return json({ status: 'ok', db: 'ok' });
    });
    const client = new SparkiiRagClient({ baseUrl: 'http://x', apiKey: 'secret', fetch: fetchImpl as typeof fetch });
    await expect(client.health()).resolves.toEqual({ ok: true });
    const headers = headerRecord(fetchImpl.mock.calls[0][1]);
    expect(JSON.stringify(headers)).not.toMatch(/secret/);
    expect(JSON.stringify(headers)).not.toMatch(/Bearer/i);
  });

  it('health returns ok false when healthz is HTTP 500 with status nok', async () => {
    const client = new SparkiiRagClient({
      baseUrl: 'http://x',
      apiKey: 'secret',
      fetch: async () => json({ status: 'nok', db: 'fail' }, 500),
    });
    await expect(client.health()).resolves.toEqual({ ok: false });
  });

  it('throws CONNECTOR_IO when retrieve gets HTTP 502 without a RAG code', async () => {
    const client = new SparkiiRagClient({
      baseUrl: 'http://x',
      apiKey: 'sk',
      fetch: async () => json({ error: 'bad gateway' }, 502),
    });
    await expect(client.retrieve({ question: 'q', datasetIds: ['a'] })).rejects.toMatchObject({ code: 'CONNECTOR_IO' });
  });

  it('pages listDatasets until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, name: `n${i}` }));
    const page2 = [{ id: 'p2-0', name: 'last' }];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(headerRecord(init).Authorization).toBe('Bearer sk');
      const href = String(url);
      if (href.includes('page=1')) return json({ code: 0, data: page1 });
      if (href.includes('page=2')) return json({ code: 0, data: page2 });
      throw new Error(`unexpected ${href}`);
    });
    const client = new SparkiiRagClient({ baseUrl: 'http://x', apiKey: 'sk', fetch: fetchImpl as typeof fetch });
    const datasets = await client.listDatasets();
    expect(datasets).toHaveLength(101);
    expect(datasets[100]).toEqual({ id: 'p2-0', name: 'last' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('page_size=100');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fetchDocument returns bytes with Authorization', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://x/api/v1/datasets/ds/documents/doc');
      expect(headerRecord(init).Authorization).toBe('Bearer sk');
      return new Response(bytes, { status: 200 });
    });
    const client = new SparkiiRagClient({ baseUrl: 'http://x', apiKey: 'sk', fetch: fetchImpl as typeof fetch });
    await expect(client.fetchDocument('ds', 'doc')).resolves.toEqual(bytes);
  });
});
