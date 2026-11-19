/**
 * B3 — surface helper: surface the tool-deny ruleId/code inside the chat bubble.
 *
 * Tool denials are produced by the platform action router (runtime-action-router)
 * with `{ status: 'denied', decision: { ruleId }, error: { code } }`, or by the
 * workspace file service as `{ ok: false, code, reason }`. Pi forwards the JSON
 * result into the session timeline as a `kind:'tool'` entry. The bid-writing
 * surface previously dropped those entries (no `text`/`content`), so the user
 * only ever saw a vague "无法读写" from the model with no way to locate the
 * cause. This helper extracts the machine code (e.g. TASK_REVOKED) so the
 * bubble can show it verbatim.
 *
 * Pure function — no platform/agent branching, unit-testable on its own.
 */
import type { SessionEntry } from '../../../src/surface/contract.js';

export interface DenyInfo {
  code: string;
  ruleId?: string;
}

function extractDeny(value: unknown, depth = 0): DenyInfo | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return extractDeny(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractDeny(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  // Canonical ActionExecutionResult deny shape.
  if (record.status === 'denied' && record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    const code = String(error.code ?? 'DENIED');
    const decision = record.decision as Record<string, unknown> | undefined;
    const ruleId = decision && typeof decision.ruleId === 'string' ? decision.ruleId : undefined;
    return { code, ...(ruleId ? { ruleId } : {}) };
  }
  // Workspace file service / connector deny shape: { ok:false, code, reason }.
  if (record.ok === false && typeof record.code === 'string') {
    return { code: record.code };
  }
  // Recurse into the usual envelopes without treating allow results as denies.
  // `text` is included because Pi wraps tool JSON in { type:'text', text:'…' }.
  for (const key of ['content', 'result', 'details', 'data', 'text']) {
    if (key in record) {
      const found = extractDeny(record[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Return a short bubble label when this timeline entry is a tool denial, else ''. */
export function toolDenyLabel(entry: SessionEntry): string {
  if (entry.kind !== 'tool') return '';
  // A pending/unresolved tool call has no result yet — never label it as denied.
  if (entry.awaitingApproval) return '';
  const info = extractDeny(entry.result) ?? extractDeny(entry.partialResult);
  if (!info) return '';
  return info.ruleId
    ? `⚠ 工具 ${entry.toolName} 被拒绝 · ${info.code}（规则 ${info.ruleId}）`
    : `⚠ 工具 ${entry.toolName} 被拒绝 · ${info.code}`;
}
