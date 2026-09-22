import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  ONTO_VECTOR_SIMILARITY_WEIGHT,
  SparkiiOntoClient,
  normalizeOntoBaseUrl,
} from '../src/sparkiionto/client.js';
import { ConnectorError } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/sparkiionto/', import.meta.url));

function body(name: string): string {
  return readFileSync(`${fixturesDir}${name}.body`, 'utf8');
}

function headers(name: string): string {
  return readFileSync(`${fixturesDir}${name}.headers`, 'utf8');
}

function json(name: string, status = 200): Response {
  return new Response(body(name), { status, headers: { 'content-type': 'application/json' } });
}

function jsonValue(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function infoBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...JSON.parse(body('info')) as Record<string, unknown>, ...over };
}

/** 按路径（精确优先、其次最长前缀）分发响应的假 fetch。 */
function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const exact = routes[path];
    if (exact) return exact();
    const prefix = Object.keys(routes)
      .filter((key) => path.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) throw new Error(`unexpected request ${href}`);
    return routes[prefix]();
  });
  return { fetchImpl: mock as unknown as typeof fetch, mock };
}

function infoRoutes(extra: Record<string, () => Response | Promise<Response>> = {}) {
  return { '/api/v1/info': () => json('info'), ...extra };
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

const TOKEN = 'tok-fixture-please-hide';

describe('SparkiiOnto base url', () => {
  it('accepts intranet http with a port and strips trailing slashes', () => {
    expect(normalizeOntoBaseUrl(' http://127.0.0.1:9380/ ')).toEqual({ ok: true, baseUrl: 'http://127.0.0.1:9380' });
    expect(normalizeOntoBaseUrl('http://onto.internal:9380/base/')).toEqual({ ok: true, baseUrl: 'http://onto.internal:9380/base' });
    expect(normalizeOntoBaseUrl('https://onto.example')).toEqual({ ok: true, baseUrl: 'https://onto.example' });
  });

  it('rejects empty, non-http and decorated urls', () => {
    for (const raw of ['', '   ', 'onto.example:9380', 'ftp://onto.example', 'http://user:pw@onto.example', 'http://onto.example/?x=1', 'http://onto.example/#frag']) {
      expect(normalizeOntoBaseUrl(raw).ok, raw).toBe(false);
    }
  });

  it('throws CONNECTOR_UNSUPPORTED when the constructor gets an invalid base url', () => {
    expect(() => new SparkiiOntoClient({ baseUrl: 'http://user:pw@onto.example', apiKey: TOKEN }))
      .toThrowError(expect.objectContaining({ code: 'CONNECTOR_UNSUPPORTED' }));
  });
});

describe('SparkiiOntoClient /health', () => {
  function healthClient(res: () => Response | Promise<Response>) {
    const { fetchImpl, mock } = routedFetch({ '/api/v1/system/healthz': res });
    return {
      mock,
      client: new SparkiiOntoClient({ baseUrl: 'http://127.0.0.1:9380', apiKey: TOKEN, fetch: fetchImpl }),
    };
  }

  it('reports ok from the measured healthz payload', async () => {
    const { client, mock } = healthClient(() => json('healthz'));
    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(String(mock.mock.calls[0][0])).toBe('http://127.0.0.1:9380/api/v1/system/healthz');
  });

  it('throws CONNECTOR_DENIED (not "unhealthy") when healthz answers 401/403', async () => {
    const cases: Array<{ status: number; res: () => Response }> = [
      { status: 401, res: () => json('info-no-token', 401) },
      { status: 403, res: () => jsonValue({ detail: 'permission denied' }, 403) },
    ];
    for (const item of cases) {
      const { client } = healthClient(item.res);
      const error = await client.health().catch((e: unknown) => e as ConnectorError);
      expect(error, String(item.status)).toBeInstanceOf(ConnectorError);
      expect(error.code, String(item.status)).toBe('CONNECTOR_DENIED');
      expect(error.message, String(item.status)).toContain(String(item.status));
      expect(error.message, String(item.status)).not.toContain(TOKEN);
    }
  });

  it('keeps 503, 422 and non-JSON responses as a plain "not ok"', async () => {
    const cases: Array<{ label: string; res: () => Response }> = [
      { label: '503 status nok', res: () => jsonValue({ status: 'nok' }, 503) },
      { label: '422 product envelope', res: () => json('retrieval-422-missing-field', 422) },
      { label: '503 html', res: () => new Response('<html>nope</html>', { status: 503, headers: { 'content-type': 'text/html' } }) },
      { label: '503 empty body', res: () => new Response(null, { status: 503 }) },
    ];
    for (const item of cases) {
      const { client } = healthClient(item.res);
      await expect(client.health(), item.label).resolves.toEqual({ ok: false });
    }
  });
});

describe('SparkiiOntoClient /info negotiation', () => {
  it('negotiates once, caches, and sends the bearer token', async () => {
    const { fetchImpl, mock } = routedFetch(infoRoutes());
    const client = new SparkiiOntoClient({ baseUrl: 'http://127.0.0.1:9380/', apiKey: TOKEN, fetch: fetchImpl });

    const info = await client.info();
    expect(info.product).toBe('SparkiiOnto');
    expect(info.version).toBe('0.6.8');
    expect(info.api_version).toBe('v1');
    expect(info.deployment_profile).toBe('single-instance');
    expect(info.retrieval).toEqual({ backend: 'sql-lexical', semantic_embeddings: false });
    expect(info.capabilities.datasets).toBe(true);
    expect(info.capabilities.document_fetch).toBe(true);

    await client.info();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0][0])).toBe('http://127.0.0.1:9380/api/v1/info');
    expect(headerRecord(mock.mock.calls[0][1]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('rejects the four negotiation mismatches with distinct diagnostics', async () => {
    const caps = infoBody().capabilities as Record<string, unknown>;
    const cases: Array<{ label: string; payload: Record<string, unknown>; hint: RegExp }> = [
      { label: 'product', payload: infoBody({ product: 'SparkiiRAG' }), hint: /product/i },
      { label: 'api_version', payload: infoBody({ api_version: 'v2' }), hint: /api_version/i },
      { label: 'deployment_profile', payload: infoBody({ deployment_profile: 'multi-instance' }), hint: /deployment_profile/i },
      { label: 'capabilities.datasets', payload: infoBody({ capabilities: { ...caps, datasets: false } }), hint: /datasets/ },
    ];
    const messages: string[] = [];
    for (const item of cases) {
      const { fetchImpl } = routedFetch({ '/api/v1/info': () => jsonValue(item.payload) });
      const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
      const error = await client.info().catch((e: unknown) => e as ConnectorError);
      expect(error, item.label).toBeInstanceOf(ConnectorError);
      expect(error.code, item.label).toBe('CONNECTOR_UNSUPPORTED');
      expect(error.message, item.label).toMatch(item.hint);
      messages.push(error.message);
    }
    expect(new Set(messages).size).toBe(4);
  });

  it('does not cache a failed negotiation', async () => {
    let calls = 0;
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => {
        calls += 1;
        return calls === 1 ? json('info-bad-token', 401) : json('info');
      },
    });
    const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
    await expect(client.info()).rejects.toMatchObject({ code: 'CONNECTOR_DENIED' });
    await expect(client.info()).resolves.toMatchObject({ product: 'SparkiiOnto' });
    expect(calls).toBe(2);
  });
});

describe('SparkiiOntoClient /datasets', () => {
  it('maps the envelope and negotiates before listing', async () => {
    const { fetchImpl, mock } = routedFetch(infoRoutes({ '/api/v1/datasets': () => json('datasets') }));
    const client = new SparkiiOntoClient({ baseUrl: 'http://127.0.0.1:9380', apiKey: TOKEN, fetch: fetchImpl });

    await expect(client.listDatasets()).resolves.toEqual([
      { id: 'd264d494-01c7-4bf9-8c03-cd68219716ab', name: '水泥工艺知识域' },
    ]);
    expect(String(mock.mock.calls[0][0])).toContain('/api/v1/info');
    const listCall = mock.mock.calls.find(([url]) => String(url).includes('/api/v1/datasets'));
    expect(String(listCall?.[0])).toBe('http://127.0.0.1:9380/api/v1/datasets?page=1&page_size=100');
    expect(headerRecord(listCall?.[1]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('returns an empty list for a malformed envelope instead of throwing', async () => {
    const payloads = [{ code: 0, data: 'nope' }, { code: 0 }, { code: 0, data: {} }];
    for (const payload of payloads) {
      const { fetchImpl } = routedFetch(infoRoutes({ '/api/v1/datasets': () => jsonValue(payload) }));
      const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
      await expect(client.listDatasets()).resolves.toEqual([]);
    }
  });
});

describe('SparkiiOntoClient /retrieval', () => {
  it('maps a substring hit and always sends all five request fields', async () => {
    const { fetchImpl, mock } = routedFetch(infoRoutes({ '/api/v1/retrieval': () => json('retrieval-substring') }));
    const client = new SparkiiOntoClient({ baseUrl: 'http://127.0.0.1:9380', apiKey: TOKEN, fetch: fetchImpl });

    const out = await client.retrieve({
      question: '高温津贴按日计发',
      datasetIds: ['d264d494-01c7-4bf9-8c03-cd68219716ab'],
    });

    const call = mock.mock.calls.find(([url]) => String(url).includes('/api/v1/retrieval'));
    expect(String(call?.[0])).toBe('http://127.0.0.1:9380/api/v1/retrieval');
    expect(headerRecord(call?.[1])['Content-Type']).toBe('application/json');
    expect(headerRecord(call?.[1]).Authorization).toBe(`Bearer ${TOKEN}`);
    const requestBody = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      question: '高温津贴按日计发',
      dataset_ids: ['d264d494-01c7-4bf9-8c03-cd68219716ab'],
      similarity_threshold: 0.2,
      vector_similarity_weight: ONTO_VECTOR_SIMILARITY_WEIGHT,
      page_size: 6,
    });
    // 防漏传回归：`vector_similarity_weight` 是"必填但被忽略"的字段，省略即 422。
    expect(Object.keys(requestBody)).toContain('vector_similarity_weight');
    expect(requestBody.vector_similarity_weight).toBe(0.3);

    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toMatchObject({
      id: '9ba3ee7b-2dc1-522c-91a0-d1b631808a4c',
      documentId: '071c7edd-f080-4cee-8dd5-14a88c674da1',
      documentName: '水泥窑协同处置工艺说明.md',
      datasetId: 'd264d494-01c7-4bf9-8c03-cd68219716ab',
      similarity: 1,
      termSimilarity: 1,
      vectorSimilarity: 0,
    });
    expect(out.documents).toEqual([{
      documentId: '071c7edd-f080-4cee-8dd5-14a88c674da1',
      documentName: '水泥窑协同处置工艺说明.md',
      chunkCount: 1,
    }]);
  });

  it('returns nothing for a natural-language miss and for an unknown domain', async () => {
    for (const fixture of ['retrieval-natural', 'retrieval-unknown-domain']) {
      const { fetchImpl } = routedFetch(infoRoutes({ '/api/v1/retrieval': () => json(fixture) }));
      const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
      const out = await client.retrieve({ question: '窑尾温度偏低该如何处理', datasetIds: ['d264d494-01c7-4bf9-8c03-cd68219716ab'], topK: 6 });
      expect(out.chunks, fixture).toEqual([]);
      expect(out.documents, fixture).toEqual([]);
    }
  });

  it('keeps every chunk at similarity 0 when the threshold is 0', async () => {
    const { fetchImpl, mock } = routedFetch(infoRoutes({ '/api/v1/retrieval': () => json('retrieval-natural-t0') }));
    const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
    const out = await client.retrieve({ question: '窑尾', datasetIds: ['d264d494-01c7-4bf9-8c03-cd68219716ab'], similarityThreshold: 0 });
    expect(out.chunks).toHaveLength(5);
    expect(out.chunks.every((c) => c.similarity === 0)).toBe(true);
    expect(out.documents).toEqual([{
      documentId: '071c7edd-f080-4cee-8dd5-14a88c674da1',
      documentName: '水泥窑协同处置工艺说明.md',
      chunkCount: 5,
    }]);
    const call = mock.mock.calls.find(([url]) => String(url).includes('/api/v1/retrieval'));
    expect(JSON.parse(String(call?.[1]?.body)).similarity_threshold).toBe(0);
  });

  it('clamps page_size between 1 and 20', async () => {
    const pages: number[] = [];
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => json('info'),
      '/api/v1/retrieval': () => json('retrieval-natural'),
    });
    const client = new SparkiiOntoClient({
      baseUrl: 'http://onto.example',
      apiKey: TOKEN,
      fetch: ((url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/api/v1/retrieval')) pages.push(JSON.parse(String(init?.body)).page_size);
        return fetchImpl(url, init);
      }) as typeof fetch,
    });
    await client.retrieve({ question: 'q', datasetIds: ['d'], topK: 0 });
    await client.retrieve({ question: 'q', datasetIds: ['d'], topK: 100 });
    expect(pages).toEqual([1, 20]);
  });
});

describe('SparkiiOntoClient error mapping', () => {
  function clientFor(retrieval: () => Response, extra: Record<string, () => Response | Promise<Response>> = {}) {
    const { fetchImpl } = routedFetch(infoRoutes({ '/api/v1/retrieval': retrieval, ...extra }));
    return new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
  }

  it('maps 401 and 403 to CONNECTOR_DENIED with different messages', async () => {
    const denied = await clientFor(() => json('info-no-token', 401))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);
    const forbidden = await clientFor(() => json('retrieval-narrow-scope', 403))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);
    expect(denied.code).toBe('CONNECTOR_DENIED');
    expect(forbidden.code).toBe('CONNECTOR_DENIED');
    expect(denied.message).toContain('401');
    expect(forbidden.message).toContain('403');
    expect(denied.message).not.toBe(forbidden.message);
  });

  it('maps 404/405 to CONNECTOR_UNSUPPORTED and 422 to a distinct unsupported message', async () => {
    const notFound = await clientFor(() => jsonValue({ code: 404, message: 'not found' }, 404))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);
    const notAllowed = await clientFor(() => new Response(JSON.stringify({ detail: 'Method Not Allowed' }), { status: 405, headers: { 'content-type': 'application/json' } }))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);
    const invalid = await clientFor(() => json('retrieval-422-missing-field', 422))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);

    expect(notFound.code).toBe('CONNECTOR_UNSUPPORTED');
    expect(notAllowed.code).toBe('CONNECTOR_UNSUPPORTED');
    expect(invalid.code).toBe('CONNECTOR_UNSUPPORTED');
    expect(notFound.message).toContain('404');
    expect(notAllowed.message).toContain('405');
    expect(invalid.message).toContain('422');
    expect(invalid.message).not.toBe(notFound.message);
    expect(invalid.message).not.toBe(notAllowed.message);
  });

  it('accepts every generated 422 fixture as a parameter-shape signal', async () => {
    for (const fixture of ['retrieval-422-missing-field', 'retrieval-422-extra-field', 'retrieval-422-page-size']) {
      const error = await clientFor(() => json(fixture, 422))
        .retrieve({ question: 'q', datasetIds: ['d'] })
        .catch((e: unknown) => e as ConnectorError);
      expect(error.code, fixture).toBe('CONNECTOR_UNSUPPORTED');
      expect(error.message, fixture).toContain('422');
    }
  });

  it('maps 429 and 5xx to CONNECTOR_IO', async () => {
    for (const status of [429, 500, 502, 503]) {
      const error = await clientFor(() => jsonValue({ code: status, message: 'busy' }, status))
        .retrieve({ question: 'q', datasetIds: ['d'] })
        .catch((e: unknown) => e as ConnectorError);
      expect(error.code, String(status)).toBe('CONNECTOR_IO');
    }
  });

  it('maps a timeout to CONNECTOR_IO', async () => {
    const client = new SparkiiOntoClient({
      baseUrl: 'http://onto.example',
      apiKey: TOKEN,
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
    await expect(client.retrieve({ question: 'q', datasetIds: ['d'] })).rejects.toMatchObject({ code: 'CONNECTOR_IO' });
  });

  it('maps a non-JSON body to CONNECTOR_IO', async () => {
    const error = await clientFor(() => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .retrieve({ question: 'q', datasetIds: ['d'] })
      .catch((e: unknown) => e as ConnectorError);
    expect(error.code).toBe('CONNECTOR_IO');
  });

  it('never leaks the token into error messages', async () => {
    const failures = [
      () => json('info-no-token', 401),
      () => json('retrieval-narrow-scope', 403),
      () => jsonValue({ code: 404, message: 'not found' }, 404),
      () => json('retrieval-422-missing-field', 422),
      () => jsonValue({ code: 500, message: 'boom' }, 500),
    ];
    for (const [index, fail] of failures.entries()) {
      const error = await clientFor(fail)
        .retrieve({ question: 'q', datasetIds: ['d'] })
        .catch((e: unknown) => e as ConnectorError);
      expect(error.message, `case ${index}`).not.toContain(TOKEN);
      expect(error.message, `case ${index}`).not.toMatch(/Bearer/i);
    }
  });
});

describe('SparkiiOntoClient /documents', () => {
  it('returns the raw document bytes and sends the bearer token', async () => {
    const bytes = Buffer.from(body('document-fetch'), 'utf8');
    const { fetchImpl, mock } = routedFetch(infoRoutes({
      '/api/v1/datasets': () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }),
    }));
    const client = new SparkiiOntoClient({ baseUrl: 'http://127.0.0.1:9380', apiKey: TOKEN, fetch: fetchImpl });

    const out = await client.fetchDocument('d264d494-01c7-4bf9-8c03-cd68219716ab', '071c7edd-f080-4cee-8dd5-14a88c674da1');
    expect(Buffer.from(out).toString('utf8')).toBe(body('document-fetch'));
    expect(out.length).toBe(bytes.length);

    const call = mock.mock.calls.find(([url]) => String(url).includes('/documents/'));
    expect(String(call?.[0])).toBe('http://127.0.0.1:9380/api/v1/datasets/d264d494-01c7-4bf9-8c03-cd68219716ab/documents/071c7edd-f080-4cee-8dd5-14a88c674da1');
    expect(headerRecord(call?.[1]).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps the measured content-type and disposition contract', () => {
    const raw = headers('document-fetch');
    expect(raw).toMatch(/content-type:\s*text\/markdown/i);
    expect(raw).toMatch(/content-disposition:\s*attachment;\s*filename\*=utf-8''/i);
  });

  it('maps the 403 fixture on fetchDocument to CONNECTOR_DENIED', async () => {
    const { fetchImpl } = routedFetch(infoRoutes({
      '/api/v1/datasets': () => json('retrieval-narrow-scope', 403),
    }));
    const client = new SparkiiOntoClient({ baseUrl: 'http://onto.example', apiKey: TOKEN, fetch: fetchImpl });
    await expect(client.fetchDocument('d', 'doc')).rejects.toMatchObject({ code: 'CONNECTOR_DENIED' });
  });
});
