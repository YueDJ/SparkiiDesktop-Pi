import { describe, it, expect } from 'vitest';
import { resolveSessionModel, resolveThinkingLevel } from '../electron/main/workflow.js';

describe('resolveSessionModel', () => {
  it('prefers an explicit model and splits provider/modelId', () => {
    expect(resolveSessionModel({ activeProviderId: 'deepseek' }, { model: 'zai/glm-5' }))
      .toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
  it('uses the active provider for a bare model id', () => {
    expect(resolveSessionModel({ activeProviderId: 'zai' }, { model: 'glm-5' }))
      .toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
  it('falls back to chat route when no model is set', () => {
    expect(resolveSessionModel(
      { activeProviderId: 'zai', defaultModel: 'glm-5' },
      { model: null },
    )).toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
});

describe('resolveThinkingLevel', () => {
  const target = { provider: 'deepseek', modelId: 'deepseek-v4-pro' };
  it('prefers the session override', () => {
    expect(resolveThinkingLevel(
      { defaultThinkingLevel: 'low', modelThinkingLevels: { 'deepseek/deepseek-v4-pro': 'high' } },
      { thinkingLevel: 'max' },
      target,
    )).toBe('max');
  });
  it('falls back to per-model memory', () => {
    expect(resolveThinkingLevel(
      { defaultThinkingLevel: 'low', modelThinkingLevels: { 'deepseek/deepseek-v4-pro': 'high' } },
      { thinkingLevel: null },
      target,
    )).toBe('high');
  });
  it('falls back to global default then null', () => {
    expect(resolveThinkingLevel({ defaultThinkingLevel: 'low' }, { thinkingLevel: null }, target)).toBe('low');
    expect(resolveThinkingLevel({}, { thinkingLevel: null }, target)).toBeNull();
  });
});
