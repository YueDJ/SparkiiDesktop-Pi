import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSurface } from '../src/platform/surface-registry.js';

describe('agent surface binding', () => {
  it('returns a surface component for a known agent', () => {
    const { result } = renderHook(() => useAgentSurface('contract-review'));
    expect(typeof result.current.Surface).toBe('function');
  });
});
