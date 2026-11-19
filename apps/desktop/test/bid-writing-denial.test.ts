import { describe, it, expect } from 'vitest';
import { toolDenyLabel } from '../agents/bid-writing/surface/denial-label.js';
import type { SessionEntry } from '../src/surface/contract.js';

function toolEntry(result: unknown, over: Record<string, unknown> = {}): SessionEntry {
  return {
    kind: 'tool',
    id: 't1',
    toolName: 'workspace.write',
    input: {},
    result,
    ...over,
  } as SessionEntry;
}

describe('B3 — tool deny ruleId surfaced in chat bubble', () => {
  it('shows error.code (TASK_REVOKED) and decision.ruleId', () => {
    const label = toolDenyLabel(toolEntry({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'task-grant.revoked' },
      error: { code: 'TASK_REVOKED', message: 'Task grant is no longer active' },
    }));
    expect(label).toContain('TASK_REVOKED');
    expect(label).toContain('task-grant.revoked');
    expect(label).toContain('workspace.write');
  });

  it('handles the JSON-string-in-content envelope Pi emits for tool results', () => {
    const payload = JSON.stringify({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'reviewer.deny' },
      error: { code: 'REVIEWER_DENIED', message: 'nope' },
    });
    const label = toolDenyLabel(toolEntry({ content: [{ type: 'text', text: payload }] }));
    expect(label).toContain('REVIEWER_DENIED');
    expect(label).toContain('reviewer.deny');
  });

  it('handles workspace file service { ok:false, code } shape', () => {
    const label = toolDenyLabel(toolEntry({ ok: false, code: 'DENIED', reason: 'target escaped' }));
    expect(label).toContain('DENIED');
  });

  it('stays silent for allow results, pending approvals and non-tool entries', () => {
    expect(toolDenyLabel(toolEntry({ status: 'executed', result: { ok: true } }))).toBe('');
    expect(toolDenyLabel(toolEntry({ status: 'denied', error: { code: 'X' } }, { awaitingApproval: true }))).toBe('');
    expect(toolDenyLabel({ kind: 'message', id: 'm', role: 'assistant', text: '无法读写', streaming: false })).toBe('');
  });
});
