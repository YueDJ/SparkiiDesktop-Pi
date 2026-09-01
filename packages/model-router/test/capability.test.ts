import { describe, expect, it } from 'vitest';
import { findCompatibleModels, recommendModel } from '../src/router.js';
import type { ModelDescriptor } from '../src/types.js';

const models: ModelDescriptor[] = [
  { provider: 'deepseek', modelId: 'pro', capabilities: ['chat', 'reasoning'] },
  { provider: 'deepseek', modelId: 'flash', capabilities: ['chat', 'fast'] },
];

describe('capability model selection', () => {
  it('filters models by required capabilities', () => {
    const result = findCompatibleModels(models, { requires: ['reasoning'] });
    expect(result.map((model) => model.modelId)).toEqual(['pro']);
  });

  it('recommends default when compatible', () => {
    const result = recommendModel(models, { requires: ['chat'] }, 'deepseek/flash');
    expect(result?.modelId).toBe('flash');
  });

  it('falls back to first compatible model when preferred is incompatible', () => {
    const result = recommendModel(models, { requires: ['reasoning'] }, 'deepseek/flash');
    expect(result?.modelId).toBe('pro');
  });
});
