import { describe, expect, it } from 'vitest';
import { resolveSurface } from '../src/platform/surface-registry.js';

describe('resolveSurface', () => {
  it('resolves standard chat surface', () => {
    expect(resolveSurface({ type: 'chat' })).toBe('standard-chat');
  });

  it('resolves custom workflow surface', () => {
    expect(resolveSurface({ type: 'workflow', entry: 'surface.tsx' })).toBe('custom-workflow');
  });
});
