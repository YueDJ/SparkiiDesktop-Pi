import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { SparkiiOntoGraph } from '../src/sparkiionto/graph.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/sparkiionto/', import.meta.url));

function body(name: string): string {
  return readFileSync(`${fixturesDir}${name}.body`, 'utf8');
}

function json(name: string, status = 200): Response {
  return new Response(body(name), { status, headers: { 'content-type': 'application/json' } });
}

function jsonValue(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function infoBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(JSON.parse(body('info')) as Record<string, unknown>), ...over };
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

/** 用单一 fixture 路由构造图客户端（`/api/v1/info` 自动服务 info fixture 以通过能力协商）。 */
function graphFor(path: string, fixture: string, status = 200) {
  const { fetchImpl, mock } = routedFetch({
    '/api/v1/info': () => json('info'),
    [path]: () => json(fixture, status),
  });
  return { graph: new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fetchImpl }), mock };
}

/** 用自定义路由构造图客户端。 */
function graphWith(routes: Record<string, () => Response | Promise<Response>>) {
  const { fetchImpl, mock } = routedFetch({ '/api/v1/info': () => json('info'), ...routes });
  return { graph: new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fetchImpl }), mock };
}

describe('SparkiiOntoGraph searchNodes', () => {
  it('searchNodes 命中产品面图搜索', async () => {
    const { graph } = graphFor('/api/v1/onto/graph/search', 'graph-search');
    const nodes = await graph.searchNodes({ query: '窑尾温度' });
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]).toMatchObject({ id: expect.any(String), type: expect.any(String) });
    expect(nodes[0]).not.toHaveProperty('valid_from');
    expect(nodes[0]).not.toHaveProperty('score');
  });

  it('getNode 返回裁剪后的节点', async () => {
    const { graph } = graphFor('/api/v1/onto/graph/nodes/b1929b56-577d-5a21-8ae3-0410c925e1d0', 'graph-nodes');
    const node = await graph.getNode('b1929b56-577d-5a21-8ae3-0410c925e1d0');
    expect(node).toMatchObject({ id: 'b1929b56-577d-5a21-8ae3-0410c925e1d0', type: 'document_chunk' });
    expect(node).not.toHaveProperty('valid_from');
    expect(node).not.toHaveProperty('valid_until');
  });

  it('neighbors 返回 relationship/weight/hop', async () => {
    const { graph } = graphFor('/api/graph/node/071c7edd-f080-4cee-8dd5-14a88c674da1/neighbors', 'graph-neighbors');
    const out = await graph.neighbors('071c7edd-f080-4cee-8dd5-14a88c674da1');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ id: expect.any(String), type: 'document_chunk', relationship: 'contains', weight: 1.0, hop: 1 });
  });

  it('info 未声明 graph 能力时抛 CONNECTOR_UNSUPPORTED', async () => {
    const caps = infoBody().capabilities as Record<string, unknown>;
    const { fetchImpl } = routedFetch({ '/api/v1/info': () => jsonValue(infoBody({ capabilities: { ...caps, graph: false } })) });
    const graph = new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fetchImpl });
    await expect(graph.searchNodes({ query: 'x' })).rejects.toMatchObject({ code: 'CONNECTOR_UNSUPPORTED' });
  });
});

describe('SparkiiOntoGraph path / empty normalization', () => {
  it('path 返回 null 而不是抛错（404 无路径）', async () => {
    const { graph } = graphFor('/api/graph/path', 'graph-path-notfound', 404);
    await expect(graph.path({ source: 'a', target: 'b' })).resolves.toBeNull();
  });

  it('path 成功时映射 nodes/hopCount/weight', async () => {
    const { graph } = graphWith({
      '/api/graph/path': () => jsonValue({ source: 'a', target: 'b', algorithm: 'bfs', path: ['a', 'x', 'b'], edge_ids: [], total_weight: 2.0, directed: true, hop_count: 2, distance_band: 'near' }),
    });
    await expect(graph.path({ source: 'a', target: 'b' })).resolves.toEqual({ nodes: ['a', 'x', 'b'], hopCount: 2, weight: 2.0 });
  });

  it('空结果归一化：[] 保持 []，404 在 neighbors 上归一化为 []', async () => {
    const empty = graphFor('/api/decisions', 'decisions-empty');
    await expect(empty.graph.listDecisions({})).resolves.toEqual([]);
    const { graph } = graphFor('/api/graph/node/does-not-exist/neighbors', 'graph-path-notfound', 404);
    await expect(graph.neighbors('does-not-exist')).resolves.toEqual([]);
  });

  it('decisionChain 对不存在的决策抛出 404 分类错误（不归一化）', async () => {
    const { graph } = graphFor('/api/decisions/does-not-exist/chain', 'decisions-chain-notfound', 404);
    await expect(graph.decisionChain('does-not-exist')).rejects.toMatchObject({ code: 'CONNECTOR_UNSUPPORTED', status: 404 });
  });
});

describe('SparkiiOntoGraph decisions / provenance', () => {
  it('provenance 返回血缘记录', async () => {
    const { graph } = graphFor('/api/v1/onto/provenance', 'provenance');
    const out = await graph.provenance({});
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ action: 'document.ingested' });
  });

  it('decisionChain 组装 chain/precedents/compliance', async () => {
    const { graph } = graphWith({
      '/api/decisions/d1/chain': () => jsonValue({ decision_id: 'd1', chain: [{ id: 'n1', type: 'factor', relationship: 'supports', hop: 1, content: 'x' }] }),
      '/api/decisions/d1/precedents': () => jsonValue([{ decision_id: 'p1', category: 'c', scenario: 's', timestamp: '2026-09-22T00:00:00' }]),
      '/api/decisions/d1/compliance': () => jsonValue({ decision_id: 'd1', compliant: true, violations: [] }),
    });
    const out = await graph.decisionChain('d1');
    expect(out.chain).toEqual([{ id: 'n1', type: 'factor', relationship: 'supports', hop: 1, content: 'x' }]);
    expect(out.precedents).toEqual([expect.objectContaining({ id: 'p1', createdAt: '2026-09-22T00:00:00' })]);
    expect(out.compliance).toEqual({ compliant: true, violations: [] });
  });
});

describe('SparkiiOntoGraph error mapping', () => {
  it('query 在只读凭据下透出可诊断的 403', async () => {
    const { graph } = graphFor('/api/sparql', 'sparql-denied', 403);
    await expect(graph.query({ query: 'SELECT * WHERE { ?s ?p ?o }' })).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
  });

  it('reason 在只读凭据下透出可诊断的 403', async () => {
    const { graph } = graphFor('/api/reason', 'reason-denied', 403);
    await expect(graph.reason({ facts: ['f'], rules: ['r'] })).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
  });

  it('distanceMatrix 在只读凭据下透出可诊断的 403', async () => {
    const { graph } = graphFor('/api/graph/distance-matrix', 'distance-matrix-denied', 403);
    await expect(graph.distanceMatrix({ nodeIds: ['a', 'b'] })).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
  });

  it('产品面 {code,message} 非零码映射为对应错误', async () => {
    const { graph } = graphWith({ '/api/sparql': () => jsonValue({ code: 403, message: 'action denied' }, 200) });
    await expect(graph.query({ query: 'SELECT * WHERE { ?s ?p ?o }' })).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
  });

  it('requestJson 对「200 + 无 code」与「200 + code 为字符串」都视为成功', async () => {
    const noCode = graphWith({ '/api/decisions': () => json('decisions-empty') });
    await expect(noCode.graph.listDecisions({})).resolves.toEqual([]);
    const strCode = graphWith({ '/api/decisions': () => jsonValue({ code: 'ok', data: [] }, 200) });
    await expect(strCode.graph.listDecisions({})).resolves.toEqual([]);
  });
});

describe('SparkiiOntoGraph request shape', () => {
  it('reason 不发送 apply_to_graph（写开关不进模型可见面）', async () => {
    const { graph, mock } = graphWith({
      '/api/reason': () => jsonValue({ inferred_facts: [], rules_fired: 0, added_edges: 0, mutated: false }),
    });
    await graph.reason({ facts: ['f'], rules: ['r'], mode: 'forward' });
    const call = mock.mock.calls.find(([url]) => String(url).includes('/api/reason'));
    const requestBody = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toEqual({ facts: ['f'], rules: ['r'], mode: 'forward' });
    expect(Object.keys(requestBody)).not.toContain('apply_to_graph');
  });

  it('distanceMatrix 映射 nodes 与 matrix（不可达对为 null）', async () => {
    const { graph } = graphWith({
      '/api/graph/distance-matrix': () => jsonValue({ nodes: ['a', 'b'], metric: 'hops', matrix: [[0, null], [null, 0]], unreachable_pairs: [['a', 'b']], computation_time_ms: 1.2 }),
    });
    await expect(graph.distanceMatrix({ nodeIds: ['a', 'b'] })).resolves.toEqual({ nodes: ['a', 'b'], matrix: [[0, null], [null, 0]] });
  });

  it('query 返回结果行', async () => {
    const { graph } = graphWith({
      '/api/sparql': () => jsonValue({ columns: ['s'], rows: [{ s: 'a' }], total: 1, truncated: false }),
    });
    await expect(graph.query({ query: 'SELECT ?s WHERE { ?s ?p ?o }' })).resolves.toEqual([{ s: 'a' }]);
  });
});

describe('SparkiiOntoGraph graphSummary', () => {
  it('graphSummary 合并产品面 summary 与 Explorer stats（fixture）', async () => {
    const { graph } = graphWith({
      '/api/v1/onto/graph/summary': () => json('graph-summary'),
      '/api/graph/stats': () => json('graph-stats'),
    });
    await expect(graph.graphSummary()).resolves.toEqual({
      nodeCount: 6,
      edgeCount: 5,
      nodeTypes: { document: 1, document_chunk: 5 },
      edgeTypes: { contains: 5 },
    });
  });

  it('graphSummary 在两端点不一致时以产品面 summary 为权威', async () => {
    const { graph } = graphWith({
      '/api/v1/onto/graph/summary': () => jsonValue({ node_count: 6, edge_count: 5, node_types: { document: 1, document_chunk: 5 }, edge_types: { contains: 5 } }),
      '/api/graph/stats': () => jsonValue({ node_count: 99, edge_count: 99, node_types: { document: 9 }, edge_types: { other: 9 } }),
    });
    await expect(graph.graphSummary()).resolves.toEqual({
      nodeCount: 6,
      edgeCount: 5,
      nodeTypes: { document: 1, document_chunk: 5 },
      edgeTypes: { contains: 5 },
    });
  });

  it('graphSummary 在 summary 缺失字段时用 stats 补齐', async () => {
    const { graph } = graphWith({
      '/api/v1/onto/graph/summary': () => jsonValue({ node_count: 6 }),
      '/api/graph/stats': () => jsonValue({ edge_count: 5, node_types: { document: 1 }, edge_types: { contains: 5 } }),
    });
    await expect(graph.graphSummary()).resolves.toEqual({
      nodeCount: 6,
      edgeCount: 5,
      nodeTypes: { document: 1 },
      edgeTypes: { contains: 5 },
    });
  });
});
