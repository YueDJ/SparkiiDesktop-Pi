import type { AgentSurfaceDescriptor } from '@sparkii/config';

export function resolveSurface(surface: AgentSurfaceDescriptor): string {
  if (surface.entry) return `custom-${surface.type}`;
  return `standard-${surface.type}`;
}
