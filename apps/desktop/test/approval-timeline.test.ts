import { describe, it, expect } from 'vitest';
import { applyApprovalStatus } from '../agents/general/surface/approval-timeline.js';
import { normalizeSessionEntries } from '../src/surface/normalize.js';
import type { SessionEntry } from '../src/surface/contract.js';

function tool(over: Partial<Extract<SessionEntry, { kind: 'tool' }>> & { id: string; toolName: string }): Extract<SessionEntry, { kind: 'tool' }> {
  return { kind: 'tool', input: {}, ...over };
}

function required(requestId: string, toolName: string, toolCallId?: string): SessionEntry {
  return {
    kind: 'custom',
    id: `req-${requestId}`,
    customType: 'approval_required',
    data: { requestId, toolName, status: 'pending', ...(toolCallId ? { toolCallId } : {}) },
  };
}

function resolved(requestId: string, toolName: string, status: 'approved' | 'denied', toolCallId?: string): SessionEntry {
  return {
    kind: 'custom',
    id: `res-${requestId}`,
    customType: 'approval_resolved',
    data: { requestId, toolName, status, ...(toolCallId ? { toolCallId } : {}) },
  };
}

describe('applyApprovalStatus', () => {
  it('returns the same reference when there are no approval rows', () => {
    const entries: SessionEntry[] = [tool({ id: 't1', toolName: 'write' })];
    expect(applyApprovalStatus(entries)).toBe(entries);
  });

  it('marks a pending tool awaiting approval', () => {
    const entries: SessionEntry[] = [
      tool({ id: 't1', toolName: 'write', toolCallId: 'c1' }),
      required('r1', 'write', 'c1'),
    ];
    const out = applyApprovalStatus(entries);
    expect(out[0]).toMatchObject({ kind: 'tool', awaitingApproval: true });
    expect(entries[0]).not.toHaveProperty('awaitingApproval', true);
  });

  it('pairs two write cards by FIFO when both are already in the list', () => {
    const entries: SessionEntry[] = [
      tool({ id: 't1', toolName: 'write', toolCallId: 'c1' }),
      tool({ id: 't2', toolName: 'write', toolCallId: 'c2' }),
      required('r1', 'write'),
      resolved('r1', 'write', 'approved'),
      required('r2', 'write'),
    ];
    const out = applyApprovalStatus(entries);
    expect(out[0]).toMatchObject({ id: 't1', awaitingApproval: false });
    expect(out[1]).toMatchObject({ id: 't2', awaitingApproval: true });
  });

  it('binds by toolCallId even when that card is not first in the same-name FIFO', () => {
    const entries: SessionEntry[] = [
      tool({ id: 't1', toolName: 'write', toolCallId: 'c1' }),
      tool({ id: 't2', toolName: 'write', toolCallId: 'c2' }),
      required('r2', 'write', 'c2'),
    ];
    const out = applyApprovalStatus(entries);
    expect(out[0]).toMatchObject({ id: 't1' });
    expect((out[0] as { awaitingApproval?: boolean }).awaitingApproval).not.toBe(true);
    expect(out[1]).toMatchObject({ id: 't2', awaitingApproval: true });
  });

  it('ignores a resolved row with no matching required', () => {
    const entries: SessionEntry[] = [
      tool({ id: 't1', toolName: 'write' }),
      resolved('orphan', 'write', 'denied'),
    ];
    const out = applyApprovalStatus(entries);
    expect((out[0] as { awaitingApproval?: boolean }).awaitingApproval).not.toBe(false);
    expect((out[0] as { isError?: boolean }).isError).not.toBe(true);
  });

  it('clears waiting and sets isError when denied without a result', () => {
    const entries: SessionEntry[] = [
      tool({ id: 't1', toolName: 'write', toolCallId: 'c1' }),
      required('r1', 'write', 'c1'),
      resolved('r1', 'write', 'denied', 'c1'),
    ];
    expect(applyApprovalStatus(entries)[0]).toMatchObject({ awaitingApproval: false, isError: true });
  });
});

describe('applyApprovalStatus from JSONL history', () => {
  it('keeps two writes from one assistant message on their own cards', () => {
    const raw = [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'c2', name: 'write', arguments: { path: 'b.ts' } },
          ],
        },
      },
      {
        type: 'custom',
        id: 'e1',
        customType: 'approval_required',
        data: { requestId: 'r1', toolName: 'write', status: 'pending', toolCallId: 'c1' },
      },
      {
        type: 'custom',
        id: 'e2',
        customType: 'approval_resolved',
        data: { requestId: 'r1', toolName: 'write', status: 'approved', toolCallId: 'c1' },
      },
      {
        type: 'custom',
        id: 'e3',
        customType: 'approval_required',
        data: { requestId: 'r2', toolName: 'write', status: 'pending', toolCallId: 'c2' },
      },
    ];
    const out = applyApprovalStatus(normalizeSessionEntries(raw));
    const tools = out.filter((e) => e.kind === 'tool');
    expect(tools[0]).toMatchObject({ toolCallId: 'c1', awaitingApproval: false });
    expect(tools[1]).toMatchObject({ toolCallId: 'c2', awaitingApproval: true });
  });
});
