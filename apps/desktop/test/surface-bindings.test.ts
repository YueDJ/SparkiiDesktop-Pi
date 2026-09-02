import { describe, it, expect } from 'vitest';
import { surfaceByAgent } from '../src/platform/agent-surface-bindings.js';

describe('agent surface bindings', () => {
  it('binds general and contract-review to a component', () => {
    expect(typeof surfaceByAgent['general']).toBe('function');
    expect(typeof surfaceByAgent['contract-review']).toBe('function');
  });
});
