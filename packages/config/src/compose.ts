import type { ResolvedProfile } from './types.js';

function merge<T>(a: T, b?: Partial<T>): T {
  return { ...a, ...b };
}

export function applyDelta(base: ResolvedProfile, delta: Partial<ResolvedProfile>): ResolvedProfile {
  return {
    manifest: merge(base.manifest, delta.manifest),
    agent: merge(base.agent, delta.agent),
    ui: {
      pages: merge(base.ui.pages, delta.ui?.pages),
      theme: merge(base.ui.theme, delta.ui?.theme),
    },
    security: {
      roles: delta.security?.roles ?? base.security.roles,
      approval: merge(base.security.approval, delta.security?.approval),
    },
  };
}

export function resolveInheritance(base: ResolvedProfile, child: ResolvedProfile): ResolvedProfile {
  return applyDelta(base, child);
}
