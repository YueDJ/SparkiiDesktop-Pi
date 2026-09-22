import { describe, it, expect, vi } from 'vitest';
import {
  executeOntologyTool,
  ontologyAuditSummary,
  resolveOntologyDefaultDomain,
  QUERY_MAX_BYTES,
  TOOL_BUDGET_MS,
} from '../electron/main/ontology-tools.js';
import type { AppSettings } from '../electron/main/settings.js';

const settings: AppSettings = {
  sparkiionto: {
    baseUrl: 'http://127.0.0.1:9380',
    similarityThreshold: 0.2,
    bindings: [{ agentId: 'qa', defaultDatasetId: 'kiln' }],
  },
};

const INFO = {
  product: 'SparkiiOnto',
  version: '0.6.8',
  api_version: 'v1',
  deployment_profile: 'single-instance',
  retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
  capabilities: { datasets: true, graph: true },
};

function jsonValue(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function routedFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
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
  return { fetchImpl: mock as unknown as typeof fetch, calls, mock };
}

describe('executeOntologyTool', () => {
  it('缺凭据时返回未配置错误，不发请求', async () => {
    let called = false;
    const out = await executeOntologyTool({
      toolName: 'ontology.graph_summary',
      args: {},
      profileId: 'p1',
      settings,
      credential: null,
      fetch: (async () => {
        called = true;
        throw new Error('nope');
      }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain('设置');
    expect(called).toBe(false);
  });

  it('把 domainId 缺省为该智能体的默认域', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/api/v1/info': () => jsonValue(INFO),
      '/api/v1/retrieval': () => jsonValue({ code: 0, data: { chunks: [], doc_aggs: [] } }),
    });
    await executeOntologyTool({
      toolName: 'ontology.search_documents',
      args: { query: '窑尾' },
      profileId: 'qa',
      settings,
      credential: 't',
      fetch: fetchImpl,
    });
    const retrieval = calls.find((c) => c.url.includes('/api/v1/retrieval'));
    expect(retrieval).toBeDefined();
    expect(JSON.parse(String(retrieval?.init?.body))).toMatchObject({ dataset_ids: ['kiln'] });
  });

  it('resolveOntologyDefaultDomain 读绑定', () => {
    expect(resolveOntologyDefaultDomain(settings, 'qa')).toBe('kiln');
    expect(resolveOntologyDefaultDomain(settings, 'nobody')).toBeUndefined();
    expect(resolveOntologyDefaultDomain({} as AppSettings, 'qa')).toBeUndefined();
  });

  it('path 的空结果返回 empty 而不是 error', async () => {
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => jsonValue(INFO),
      '/api/graph/path': () => jsonValue({ detail: 'not found' }, 404),
    });
    const out = await executeOntologyTool({
      toolName: 'ontology.path',
      args: { source: 'a', target: 'b' },
      profileId: 'p1',
      settings,
      credential: 't',
      fetch: fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(out.empty).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it('预算：query 10s，其余 30s', () => {
    expect(TOOL_BUDGET_MS['ontology.query']).toBe(10_000);
    expect(TOOL_BUDGET_MS.default).toBe(30_000);
  });

  it('多端点工具在总预算耗尽时失败且不返回部分结果', async () => {
    let t = 0;
    const now = () => {
      t += 1;
      return t >= 4 ? 40_000 : 0;
    };
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => jsonValue(INFO),
      '/api/v1/onto/graph/nodes/n1': () => jsonValue({ id: 'n1', type: 'document' }),
      '/api/graph/node/n1/neighbors': () => jsonValue([]),
    });
    const out = await executeOntologyTool({
      toolName: 'ontology.node',
      args: { nodeId: 'n1' },
      profileId: 'p1',
      settings,
      credential: 't',
      fetch: fetchImpl,
      now,
    });
    expect(out.ok).toBe(false);
    expect(out.data).toBeUndefined();
    expect(out.error?.code).toBe('CONNECTOR_IO');
  });

  it('query 超长响应被截断并置 truncated', async () => {
    const big = 'x'.repeat(QUERY_MAX_BYTES + 100);
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => jsonValue(INFO),
      '/api/sparql': () => jsonValue({ columns: ['s'], rows: [{ s: big }], total: 1, truncated: false }),
    });
    const out = await executeOntologyTool({
      toolName: 'ontology.query',
      args: { query: 'SELECT ?s WHERE { ?s ?p ?o }' },
      profileId: 'p1',
      settings,
      credential: 't',
      fetch: fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it('query 的审计摘要包含查询全文', async () => {
    const { fetchImpl } = routedFetch({
      '/api/v1/info': () => jsonValue(INFO),
      '/api/sparql': () => jsonValue({ rows: [] }),
    });
    const out = await executeOntologyTool({
      toolName: 'ontology.query',
      args: { query: 'SELECT ?s WHERE { ?s ?p ?o }' },
      profileId: 'p1',
      settings,
      credential: 't',
      fetch: fetchImpl,
    });
    expect(ontologyAuditSummary('ontology.query', { query: 'SELECT ?s WHERE { ?s ?p ?o }' }, out)).toContain(
      'SELECT ?s WHERE { ?s ?p ?o }',
    );
  });

  it('未知工具名被拒绝', async () => {
    const out = await executeOntologyTool({
      toolName: 'ontology.nope',
      args: {},
      profileId: 'p1',
      settings,
      credential: 't',
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('CONNECTOR_UNSUPPORTED');
  });
});
