import type { ChatEntry } from '@sparkii/ui';
import {
  applyChatEvent as uiApplyChatEvent,
  normalizeSessionEntries as uiNormalizeSessionEntries,
} from '@sparkii/ui';
import type { SessionEntry, WorkflowStepEntry, WorkflowStateEntry } from './contract.js';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function timestamp(data: Record<string, unknown>): number | undefined {
  const s = typeof data.startedAt === 'string'
    ? data.startedAt
    : typeof data.finishedAt === 'string'
      ? data.finishedAt
      : undefined;
  return s ? Date.parse(s) : undefined;
}

function workflowEntryFor(raw: unknown): WorkflowStepEntry | WorkflowStateEntry | null {
  const rec = asRecord(raw);
  const type = String(rec.type ?? '');
  const data = asRecord(rec.data);
  if (type === 'workflow_step_start') {
    return { kind: 'workflow_step', id: `ws-${data.stepId}-start`, stepId: String(data.stepId), state: 'start', timestamp: timestamp(data) };
  }
  if (type === 'workflow_step_end') {
    return {
      kind: 'workflow_step',
      id: `ws-${data.stepId}-end`,
      stepId: String(data.stepId),
      state: 'end',
      status: String(data.status ?? ''),
      timestamp: timestamp(data),
    };
  }
  if (type === 'workflow_state') {
    return {
      kind: 'workflow_state',
      id: `wst-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      stepId: String(data.stepId),
      action: String(data.action),
      payload: asRecord(data.payload),
      timestamp: typeof data.at === 'string' ? Date.parse(data.at) : undefined,
    };
  }
  return null;
}

/** Normalize a session history into the unified timeline (chat + workflow lifecycle). */
export function normalizeSessionEntries(entries: unknown[]): SessionEntry[] {
  const workflow: SessionEntry[] = [];
  const chat: unknown[] = [];
  for (const e of entries) {
    const w = workflowEntryFor(e);
    if (w) workflow.push(w);
    else chat.push(e);
  }
  return [...workflow, ...uiNormalizeSessionEntries(chat)];
}

/** Apply a single live event onto the current timeline (chat + workflow lifecycle). */
export function applySurfaceEvent(entries: SessionEntry[], ev: unknown): SessionEntry[] {
  const w = workflowEntryFor(ev);
  if (w) return [...entries, w];
  return uiApplyChatEvent(entries as ChatEntry[], ev);
}

export interface WorkflowTimeline {
  status: 'idle' | 'running' | 'done' | 'failed';
  step?: string;
}

export function deriveWorkflowTimeline(entries: SessionEntry[]): WorkflowTimeline {
  const steps = entries.filter((e): e is WorkflowStepEntry => e.kind === 'workflow_step');
  if (steps.length === 0) return { status: 'idle' };

  const failed = steps.find((s) => s.state === 'end' && s.status === 'failed');
  if (failed) return { status: 'failed', step: failed.stepId };

  const starts = steps.filter((s) => s.state === 'start');
  const ends = steps.filter((s) => s.state === 'end');
  const lastStart = starts[starts.length - 1];
  const lastEnd = ends[ends.length - 1];
  if (ends.length >= starts.length && lastStart && lastEnd && lastEnd.stepId === lastStart.stepId) {
    return { status: 'done', step: lastEnd.stepId };
  }
  return { status: 'running', step: lastStart?.stepId };
}

export function extractWorkflowResult(entries: SessionEntry[]): Record<string, unknown> {
  const states = entries.filter((e): e is WorkflowStateEntry => e.kind === 'workflow_state' && e.action === 'result');
  const last = states[states.length - 1];
  return (last?.payload ?? {}) as Record<string, unknown>;
}
