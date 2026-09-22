import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeKnowledgeBackend } from '../electron/main/knowledge-probe.js';

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'packages', 'connectors', 'test', 'fixtures', 'sparkiionto',
);

function body(name: string): string {
  return readFileSync(join(fixturesDir, `${name}.body`), 'utf8');
}

function json(name: string, status = 200): Response {
  return new Response(body(name), { status, headers: { 'content-type': 'application/json' } });
}

function jsonValue(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function routedFetch(routes: Record<string, () => Response>) {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const href = String(url);
    const path = href.startsWith('http') ? new URL(href).pathname : href;
    const exact = routes[path];
    if (exact) return exact();
    const prefix = Object.keys(routes).filter((key) => path.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    if (!prefix) throw new Error(`unexpected request ${href}`);
    return routes[prefix]();
  });
  return mock as unknown as typeof fetch & { mock: { calls: Array<[unknown, RequestInit | undefined]> } };
}

function healthz(): Response {
  return json('healthz');
}

const INFO = () => json('info');
const DATASETS = () => json('datasets');
const OK_BASE = 'http://127.0.0.1:9380';
const TOKEN = 'tok-fixture-please-hide';

describe('probeKnowledgeBackend (sparkiionto)', () => {
  it('probes healthz then info then datasets and reports capabilities', async () => {
    const fetchImpl = routedFetch({
      '/api/v1/system/healthz': healthz,
      '/api/v1/info': INFO,
      '/api/v1/datasets': DATASETS,
    });
    const result = await probeKnowledgeBackend('sparkiionto', {
      baseUrl: `${OK_BASE}/`,
      credential: TOKEN,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.backend).toBe('sparkiionto');
    expect(result.baseUrl).toBe(OK_BASE);
    expect(result.datasets).toEqual([{ id: 'd264d494-01c7-4bf9-8c03-cd68219716ab', name: '水泥工艺知识域' }]);
    expect(result.info).toMatchObject({
      product: 'SparkiiOnto',
      api_version: 'v1',
      deployment_profile: 'single-instance',
      retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
      capabilities: { datasets: true, document_fetch: true },
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/system/healthz',
      '/api/v1/info',
      '/api/v1/datasets',
    ]);
  });

  it('reports an unhealthy service without asking for capabilities', async () => {
    const fetchImpl = routedFetch({
      '/api/v1/system/healthz': () => jsonValue({ status: 'nok' }, 503),
      '/api/v1/info': INFO,
    });
    const result = await probeKnowledgeBackend('sparkiionto', { baseUrl: OK_BASE, credential: TOKEN, fetch: fetchImpl });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTOR_IO', reason: 'unhealthy' } });
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it('separates 401 (credential) from 403 (permission) by wording', async () => {
    const denied = await probeKnowledgeBackend('sparkiionto', {
      baseUrl: OK_BASE,
      credential: TOKEN,
      fetch: routedFetch({ '/api/v1/system/healthz': healthz, '/api/v1/info': () => json('info-bad-token', 401) }),
    });
    const forbidden = await probeKnowledgeBackend('sparkiionto', {
      baseUrl: OK_BASE,
      credential: TOKEN,
      fetch: routedFetch({ '/api/v1/system/healthz': healthz, '/api/v1/info': INFO, '/api/v1/datasets': () => json('datasets-narrow-scope', 403) }),
    });

    expect(denied).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'unauthorized' } });
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'forbidden' } });
    expect(denied.error?.message).toMatch(/凭据/);
    expect(forbidden.error?.message).toMatch(/权限/);
    expect(denied.error?.message).not.toBe(forbidden.error?.message);
    expect(denied.error?.message).not.toContain(TOKEN);
  });

  it('reports an /info that does not belong to this product as unsupported', async () => {
    for (const payload of [
      { product: 'SparkiiRAG', version: '1', api_version: 'v1', deployment_profile: 'single-instance', capabilities: { datasets: true } },
      { product: 'SparkiiOnto', version: '1', api_version: 'v2', deployment_profile: 'single-instance', capabilities: { datasets: true } },
      { product: 'SparkiiOnto', version: '1', api_version: 'v1', deployment_profile: 'multi-instance', capabilities: { datasets: true } },
      { product: 'SparkiiOnto', version: '1', api_version: 'v1', deployment_profile: 'single-instance', capabilities: { datasets: false } },
    ]) {
      const result = await probeKnowledgeBackend('sparkiionto', {
        baseUrl: OK_BASE,
        credential: TOKEN,
        fetch: routedFetch({ '/api/v1/system/healthz': healthz, '/api/v1/info': () => jsonValue(payload) }),
      });
      expect(result, JSON.stringify(payload)).toMatchObject({ ok: false, error: { code: 'CONNECTOR_UNSUPPORTED', reason: 'unsupported' } });
    }
  });

  it('classifies a bad base url and a missing token as invalid_config', async () => {
    const badUrl = await probeKnowledgeBackend('sparkiionto', { baseUrl: 'not-a-url', credential: TOKEN });
    expect(badUrl).toMatchObject({ ok: false, error: { reason: 'invalid_config' } });
    expect(badUrl.error?.message).toMatch(/地址无效/);

    const noToken = await probeKnowledgeBackend('sparkiionto', { baseUrl: OK_BASE, credential: null });
    expect(noToken).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'invalid_config' } });
    expect(noToken.error?.message).toBe('未配置 API Token');
  });

  it('classifies a network failure as unreachable', async () => {
    const result = await probeKnowledgeBackend('sparkiionto', {
      baseUrl: OK_BASE,
      credential: TOKEN,
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTOR_IO', reason: 'unreachable' } });
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('lets an override carry unsaved url and token', async () => {
    const seen: string[] = [];
    const fetchImpl = routedFetch({
      '/api/v1/system/healthz': healthz,
      '/api/v1/info': () => { seen.push('info'); return INFO(); },
      '/api/v1/datasets': DATASETS,
    });
    const result = await probeKnowledgeBackend('sparkiionto', {
      baseUrl: 'http://stale.example',
      credential: 'stale-token',
      override: { baseUrl: 'http://onto.internal:9380', apiKey: 'fresh-token' },
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe('http://onto.internal:9380');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://onto.internal:9380/api/v1/system/healthz');
    const auth = (fetchImpl.mock.calls[1][1]?.headers ?? {}) as Record<string, string>;
    expect(JSON.stringify(auth)).toContain('fresh-token');
    expect(JSON.stringify(auth)).not.toContain('stale-token');
    expect(seen).toEqual(['info']);
  });
});

describe('probeKnowledgeBackend (sparkiirag)', () => {
  it('keeps the legacy probe shape and wording', async () => {
    const fetchImpl = routedFetch({
      '/api/v1/system/healthz': healthz,
      '/api/v1/datasets': DATASETS,
    });
    const result = await probeKnowledgeBackend('sparkiirag', { baseUrl: OK_BASE, credential: TOKEN, fetch: fetchImpl });
    expect(result).toMatchObject({ ok: true, backend: 'sparkiirag' });
    expect(result.datasets).toEqual([{ id: 'd264d494-01c7-4bf9-8c03-cd68219716ab', name: '水泥工艺知识域' }]);
    expect(result.info).toBeUndefined();
  });

  it('keeps the legacy "no key" wording', async () => {
    const result = await probeKnowledgeBackend('sparkiirag', { baseUrl: OK_BASE, credential: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'invalid_config' } });
    expect(result.error?.message).toBe('未配置 API Key');
  });

  it('keeps the legacy "unreachable" wording for a failing healthz', async () => {
    const result = await probeKnowledgeBackend('sparkiirag', {
      baseUrl: OK_BASE,
      credential: TOKEN,
      fetch: routedFetch({ '/api/v1/system/healthz': () => jsonValue({ status: 'nok' }, 500) }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTOR_IO', reason: 'unreachable' } });
    expect(result.error?.message).toBe('SparkiiRAG 不可达');
  });
});
