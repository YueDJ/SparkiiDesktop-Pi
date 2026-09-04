export type SessionMode = 'live' | 'history';

export type CurrentWork =
  | { type: 'page'; page: string }
  | { type: 'session'; agentId: string; sessionId: string | null; mode: SessionMode };

export function isSession(current: CurrentWork): current is Extract<CurrentWork, { type: 'session' }> {
  return current.type === 'session';
}

export function openPage(page: string): CurrentWork {
  return { type: 'page', page };
}

export function openHistory(agentId: string, sessionId: string, surfaceType?: string): CurrentWork {
  return {
    type: 'session',
    agentId,
    sessionId,
    mode: surfaceType === 'workflow' ? 'history' : 'live',
  };
}

export function openNew(agentId: string): CurrentWork {
  return { type: 'session', agentId, sessionId: null, mode: 'live' };
}

export function bindSession(current: CurrentWork, sessionId: string): CurrentWork {
  if (!isSession(current)) return current;
  return { type: 'session', agentId: current.agentId, sessionId, mode: 'live' };
}

export function clearCurrentSession(current: CurrentWork): CurrentWork {
  if (!isSession(current)) return current;
  return { type: 'session', agentId: current.agentId, sessionId: null, mode: 'live' };
}

export function highlightedSessionId(current: CurrentWork): string | null {
  if (!isSession(current) || !current.sessionId) return null;
  return current.sessionId;
}

export function shellActive(current: CurrentWork): string {
  return current.type === 'page' ? current.page : current.agentId;
}

export function rowIsActive(highlightedId: string | null, sessionId: string): boolean {
  return highlightedId != null && highlightedId === sessionId;
}

export function withDerivedActive<T extends { id: string }>(
  groups: Record<string, T[]>,
  highlightedId: string | null,
): Record<string, Array<T & { active: boolean }>> {
  const next: Record<string, Array<T & { active: boolean }>> = {};
  for (const [key, list] of Object.entries(groups)) {
    next[key] = list.map((row) => ({ ...row, active: rowIsActive(highlightedId, row.id) }));
  }
  return next;
}
