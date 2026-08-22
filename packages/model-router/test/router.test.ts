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
});
