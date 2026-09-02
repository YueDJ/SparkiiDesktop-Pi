import { surfaceByAgent } from './agent-surface-bindings.js';
import type { ComponentType } from 'react';
import type { AgentSurfaceDescriptor } from '@sparkii/config';

export function useAgentSurface(agentId: string): { Surface: ComponentType<any> } {
  return { Surface: surfaceByAgent[agentId] };
}

export function resolveSurface(surface: AgentSurfaceDescriptor): string {
  if (surface.entry) return `custom-${surface.type}`;
  return `standard-${surface.type}`;
}
