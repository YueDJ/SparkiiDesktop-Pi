import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { SparkiiOntoReadFamilies } from '../src/sparkiionto/read-families.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/sparkiionto/', import.meta.url));

function body(name: string): string {
  return readFileSync(`${fixturesDir}${name}.body`, 'utf8');
}

function json(name: string, status = 200): Response {
  return new Response(body(name), { status, headers: { 'content-type': 'application/json' } });
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

/** 用自定义路由构造只读能力族客户端（`/api/v1/info` 自动服务 info fixture 以通过协商）。 */
function families(routes: Record<string, () => Response | Promise<Response>>) {
  const { fetchImpl, mock } = routedFetch({ '/api/v1/info': () => json('info'), ...routes });
  return {
    client: new SparkiiOntoReadFamilies({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fetchImpl }),
    mock,
  };
}

describe('SparkiiOntoReadFamilies analytics / temporal', () => {
  it('analytics 返回 centraliy/community/connectivity 三块', async () => {
    const { client } = families({ '/api/analytics': () => json('analytics') });
    const out = await client.analytics();
    expect(out).toBeTypeOf('object');
    expect(out).toHaveProperty('centrality');
    expect(out).toHaveProperty('community');
    expect(out).toHaveProperty('connectivity');
  });

  it('temporalBounds 把缺失字段归一化为 null', async () => {
    const { client } = families({ '/api/temporal/bounds': () => json('temporal-bounds') });
    await expect(client.temporalBounds()).resolves.toEqual({ min: null, max: null });
  });

  it('temporalSnapshot 透传活跃节点快照', async () => {
    const { client } = families({ '/api/temporal/snapshot': () => json('temporal-snapshot') });
    const out = await client.temporalSnapshot('2026');
    expect(out).toMatchObject({ timestamp: '2026-01-01T00:00:00', active_node_count: 6 });
  });
});

describe('SparkiiOntoReadFamilies vocabulary / audit / annotations', () => {
  it('vocabularySchemes 返回数组（空图谱为空数组）', async () => {
    const { client } = families({ '/api/vocabulary/schemes': () => json('vocabulary-schemes') });
    await expect(client.vocabularySchemes()).resolves.toEqual([]);
  });

  it('vocabularyConcepts 返回数组（空图谱为空数组）', async () => {
    const { client } = families({ '/api/vocabulary/concepts': () => json('vocabulary-concepts') });
    await expect(client.vocabularyConcepts('urn:example:scheme')).resolves.toEqual([]);
  });

  it('vocabularyHierarchy 返回层级', async () => {
    const { client } = families({ '/api/vocabulary/hierarchy': () => json('vocabulary-hierarchy') });
    await expect(client.vocabularyHierarchy('urn:example:scheme')).resolves.toEqual([]);
  });

  it('auditEntries 在缺 audit:read 的凭据下透出可诊断的 403', async () => {
    const { client } = families({ '/api/v1/onto/audit': () => json('audit-denied', 403) });
    const promise = client.auditEntries();
    await expect(promise).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('权限') });
  });

  it('annotations 返回数组（空图谱为空数组）', async () => {
    const { client } = families({ '/api/annotations': () => json('annotations') });
    await expect(client.annotations()).resolves.toEqual([]);
  });
});

describe('SparkiiOntoReadFamilies memories / markdown', () => {
  it('memories 在未配置 AgentMemory 时透出 503 分类错误', async () => {
    const { client } = families({ '/api/memories': () => json('memories', 503) });
    await expect(client.memories()).rejects.toMatchObject({ code: 'CONNECTOR_IO', status: 503 });
  });

  it('markdown 读取 context-node 资源', async () => {
    const { client } = families({
      '/api/markdown/context-node/b1929b56-577d-5a21-8ae3-0410c925e1d0': () => json('markdown-read'),
    });
    const out = await client.markdown('context-node', 'b1929b56-577d-5a21-8ae3-0410c925e1d0');
    expect(out).toMatchObject({ resource: { kind: 'context-node' }, body: expect.any(String) });
  });
});
