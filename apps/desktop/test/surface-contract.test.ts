import { describe, it, expect } from 'vitest';
import type { AgentSurfaceComponent, AgentSurfaceProps } from '../src/surface/contract.js';

describe('AgentSurface contract', () => {
  it('types a component that accepts AgentSurfaceProps', () => {
    const Comp: AgentSurfaceComponent = (props: AgentSurfaceProps) => null;
    expect(typeof Comp).toBe('function');
  });
});
