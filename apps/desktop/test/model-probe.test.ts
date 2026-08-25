import { describe, it, expect, vi, afterEach } from 'vitest';
import { listModels, testModel } from '../electron/main/model-probe.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl as any));
}

describe('listModels', () => {
  it('parses OpenAI-compatible model lists', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) }));
    const r = await listModels('https://api.example.com/v1');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('parses Ollama /api/tags lists', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen2.5' }, { name: 'llama3.1' }] }) }));
    const r = await listModels('http://127.0.0.1:11434');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['qwen2.5', 'llama3.1']);
  });

  it('reports HTTP failures', async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const r = await listModels('https://api.example.com/v1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
  });
});

describe('testModel', () => {
  it('returns latency when the endpoint responds', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    const r = await testModel('https://api.example.com/v1');
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
  });
});
