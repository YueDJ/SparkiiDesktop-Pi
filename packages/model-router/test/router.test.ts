import { describe, it, expect } from 'vitest';
import { ModelRouter, normalizeRouting } from '../src/router.js';

describe('ModelRouter', () => {
  const routing = normalizeRouting({
    default: [{ provider: 'local', modelId: 'qwen2.5:7b' }],
    report: [
      { provider: 'cloud', modelId: 'gpt-5-mini' },
      { provider: 'local', modelId: 'qwen2.5:14b' },
    ],
  });

  it('falls back to default when task has no entry', () => {
    expect(new ModelRouter(routing).resolve('extract')).toEqual({ provider: 'local', modelId: 'qwen2.5:7b' });
  });

  it('degrades to the next target when the first is unavailable', () => {
    const router = new ModelRouter(routing);
    expect(router.resolve('report', (t) => t.provider !== 'cloud')).toEqual({ provider: 'local', modelId: 'qwen2.5:14b' });
  });

  it('returns null when all targets unavailable', () => {
    expect(new ModelRouter(routing).resolve('report', () => false)).toBeNull();
  });

  it('resolves coding task, falling back to default when absent', () => {
    const router = new ModelRouter(normalizeRouting({ default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] }));
    expect(router.resolve('coding')).toEqual({ provider: 'local', modelId: 'qwen2.5:7b' });
    const withCoding = new ModelRouter(normalizeRouting({
      default: [{ provider: 'local', modelId: 'qwen2.5:7b' }],
      coding: [{ provider: 'cloud', modelId: 'deepseek-v4-pro' }],
    }));
    expect(withCoding.resolve('coding')).toEqual({ provider: 'cloud', modelId: 'deepseek-v4-pro' });
  });

  it('resolves title task and falls back to default', () => {
    const normalized = normalizeRouting({ default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] });
    expect(normalized.title).toEqual([{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }]);
    expect(new ModelRouter(normalized).resolve('title')).toEqual({ provider: 'deepseek', modelId: 'deepseek-v4-flash' });
  });
});
