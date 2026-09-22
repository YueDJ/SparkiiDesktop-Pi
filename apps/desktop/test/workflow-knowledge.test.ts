import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../electron/main/workflow.js';

let dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe('workflow knowledge.search routing', () => {
  it('runs an Onto workflow search and writes the domain into sparkiionto bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'wf-onto-'));
    dirs.push(dataDir);
    await mkdir(join(dataDir, 'pi-agent'), { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      sparkiionto: { baseUrl: 'http://onto.example:9380' },
    }), 'utf8');
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/api/v1/info') {
        return new Response(JSON.stringify({
          product: 'SparkiiOnto', version: '0.6.8', api_version: 'v1', deployment_profile: 'single-instance',
          retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
          capabilities: { datasets: true, document_fetch: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/datasets') {
        return new Response('{"code":0,"data":[{"id":"d264d494","name":"水泥工艺知识域"}]}', {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/v1/retrieval') {
        return new Response('{"code":0,"data":{"chunks":[],"doc_aggs":[]}}', {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const rt = {
      dataDir,
      subject: { userId: 'tester' },
      profileOf: () => ({
        dir: join(dataDir, 'profiles', 'onto-agent'),
        profile: {
          manifest: { name: 'onto-agent', knowledge: { enabled: true, picker: 'hidden', backend: 'sparkiionto' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
      }),
      knowledgeToken: async (backend: string) => (backend === 'sparkiionto' ? 'tok-onto' : null),
    };
    const out = await runTool(
      rt as never,
      {} as never,
      'knowledge.search',
      { query: '高温津贴怎么发' },
      's1',
      'onto-agent',
    );
    expect(out.ok).toBe(true);
    expect(paths).toContain('/api/v1/retrieval');
    const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as {
      rag?: { bindings?: unknown };
      sparkiionto: { bindings?: unknown };
    };
    expect(settings.sparkiionto.bindings).toEqual([{ agentId: 'onto-agent', defaultDatasetId: 'd264d494' }]);
    expect(settings.rag).toBeUndefined();
  });
});
