export type SessionIdChange = 'assign' | 'leave' | 'switch' | 'stay';

export function sessionIdChange(prev: string | null, next: string | null): SessionIdChange {
  if (prev === next) return 'stay';
  if (prev != null && next == null) return 'leave';
  if (prev != null && next != null) return 'switch';
  return 'assign';
}

export function isWorkflowDraftBind(change: SessionIdChange, mode: 'live' | 'history'): boolean {
  return change === 'assign' && mode === 'live';
}

export function isWorkflowOpenFromDraft(change: SessionIdChange, mode: 'live' | 'history'): boolean {
  return change === 'assign' && mode === 'history';
}
