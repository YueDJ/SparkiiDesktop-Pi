import type { SessionEntry } from './contract.js';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function entryFor(raw: unknown): SessionEntry | null {
  const rec = asRecord(raw);
  const type = String(rec.type ?? '');
  const data = asRecord(rec.data);
  const ts = typeof data.startedAt === 'string' ? Date.parse(data.startedAt) : undefined;

  if (type === 'workflow_step_start') {
    return { kind: 'workflow_step', id: `ws-${data.stepId}-start`, stepId: String(data.stepId), state: 'start', timestamp: ts };
  }
  if (type === 'workflow_step_end') {
    return { kind: 'workflow_step', id: `ws-${data.stepId}-end`, stepId: String(data.stepId), state: 'end', status: String(data.status ?? ''), timestamp: ts };
  }
  if (type === 'workflow_state') {
    return {
      kind: 'workflow_state',
      id: `wst-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      stepId: String(data.stepId),
      action: String(data.action),
      payload: asRecord(data.payload),
    };
  }
  if (type === 'message') {
    const m = asRecord(rec.message);
    const role = String(m.role ?? '');
    const content = Array.isArray(m.content)
      ? m.content.map((b) => (asRecord(b).type === 'text' ? String(asRecord(b).text ?? '') : '')).join('')
      : '';
    const text = typeof m.text === 'string' ? m.text : content;
    if (role === 'user' || role === 'assistant') {
      return { kind: 'message', id: `m-${Date.now()}`, role, text, streaming: false };
    }
  }
  return null;
}

export function normalizeSessionEntries(entries: unknown[]): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const e of entries) {
    const mapped = entryFor(e);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function applySurfaceEvent(entries: SessionEntry[], ev: unknown): SessionEntry[] {
  const rec = asRecord(ev);
  const mapped = entryFor(ev);
  if (mapped) return [...entries, mapped];

  if (String(rec.type ?? '') === 'message' && String(rec.role ?? '') === 'assistant') {
    const last = entries[entries.length - 1];
    if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
      const collected = typeof rec.delta === 'string' ? rec.delta : '';
      return [...entries.slice(0, -1), { ...last, text: last.text + collected, streaming: true }];
    }
    const text = typeof rec.text === 'string' ? rec.text : typeof rec.delta === 'string' ? rec.delta : '';
    if (text) {
      return [...entries, { kind: 'message', id: `m-${Date.now()}`, role: 'assistant', text, streaming: typeof rec.delta === 'string' }];
    }
  }
  return entries;
}
