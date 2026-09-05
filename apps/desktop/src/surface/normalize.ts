import type { ChatEntry } from '@sparkii/ui';
import {
  applyChatEvent as uiApplyChatEvent,
  normalizeSessionEntries as uiNormalizeSessionEntries,
} from '@sparkii/ui';
import type { CustomSessionEntry, SessionEntry } from './contract.js';

export type { CustomSessionEntry } from './contract.js';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function customFrom(raw: unknown): CustomSessionEntry | null {
  const rec = asRecord(raw);
  const entry = rec.type === 'entry_appended' ? asRecord(rec.entry) : rec;
  if (String(entry.type) !== 'custom') return null;
  return {
    kind: 'custom',
    id: String(entry.id ?? ''),
    customType: String(entry.customType ?? ''),
    data: asRecord(entry.data),
    timestamp: parseTimestamp(entry.timestamp),
  };
}

function stepIdOf(e: CustomSessionEntry): string {
  return String(e.data.stepId ?? '');
}

/** Normalize a session history into the unified timeline (chat + custom JSONL rows, original order). */
export function normalizeSessionEntries(entries: unknown[]): SessionEntry[] {
  const out: SessionEntry[] = [];
  const chatBuf: unknown[] = [];
  const flushChat = () => {
    if (!chatBuf.length) return;
    out.push(...uiNormalizeSessionEntries(chatBuf));
    chatBuf.length = 0;
  };
  for (const e of entries) {
    const c = customFrom(e);
    if (c) {
      flushChat();
      out.push(c);
    } else {
      chatBuf.push(e);
    }
  }
  flushChat();
  return out;
}

/** Apply a single live event onto the current timeline (chat + custom JSONL rows). */
export function applySurfaceEvent(entries: SessionEntry[], ev: unknown): SessionEntry[] {
  const c = customFrom(ev);
  if (c) {
    if (c.id && entries.some((e) => e.id === c.id)) return entries;
    return [...entries, c];
  }
  // Everything else (messages, tool executions, lifecycle) shares the chat projection, so a live
  // session and a history replay produce the same normalized entry shape.
  return uiApplyChatEvent(entries as ChatEntry[], ev);
}

export interface WorkflowTimeline {
  status: 'idle' | 'running' | 'done' | 'failed';
  step?: string;
}

export function deriveWorkflowTimeline(entries: SessionEntry[]): WorkflowTimeline {
  const steps = entries.filter((e): e is CustomSessionEntry =>
    e.kind === 'custom' && (e.customType === 'workflow_step_start' || e.customType === 'workflow_step_end'),
  );
  if (steps.length === 0) return { status: 'idle' };

  const failed = steps.find((s) => s.customType === 'workflow_step_end' && String(s.data.status ?? '') === 'failed');
  if (failed) return { status: 'failed', step: stepIdOf(failed) };

  const starts = steps.filter((s) => s.customType === 'workflow_step_start');
  const ends = steps.filter((s) => s.customType === 'workflow_step_end');
  const lastStart = starts[starts.length - 1];
  const lastEnd = ends[ends.length - 1];
  if (ends.length >= starts.length && lastStart && lastEnd && stepIdOf(lastEnd) === stepIdOf(lastStart)) {
    return { status: 'done', step: stepIdOf(lastEnd) };
  }
  return { status: 'running', step: lastStart ? stepIdOf(lastStart) : undefined };
}

export function extractWorkflowResult(entries: SessionEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.kind !== 'custom' || e.customType !== 'workflow_step_end') continue;
    const stepId = stepIdOf(e);
    if (stepId && 'output' in e.data) result[stepId] = e.data.output;
  }
  return result;
}
