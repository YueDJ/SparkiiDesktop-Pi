import { describe, it, expect, vi } from 'vitest';
import { probeProviderModels } from '../electron/main/provider-probe.js';

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('probeProviderModels', () => {
  it('hits the OpenAI-compatible /models endpoint with a bearer token and parses ids', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
    const result = await probeProviderModels(
      { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x' },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-x' } }),
    );
  });

  it('uses the Anthropic /v1/models endpoint with x-api-key', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: [{ id: 'claude-sonnet-4-5', type: 'model' }] }));
    const result = await probeProviderModels(
      { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['claude-sonnet-4-5']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({ headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant' } }),
    );
  });

  it('reports unauthorized on 401', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: { message: 'bad key' } }));
    const result = await probeProviderModels(
      { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'bad' },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unauthorized');
    expect(result.httpStatus).toBe(401);
  });

  it('falls back from /models to /v1/models on 404', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'llama3.1' }] }));
    const result = await probeProviderModels(
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['llama3.1']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports unreachable on a network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await probeProviderModels(
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable');
  });
});

