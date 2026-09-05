import { describe, it, expect } from 'vitest';
import { applySnapshotThenBuffer, shouldRebuildOnCompaction } from '../src/surface/open-session.js';
import { applySurfaceEvent, extractWorkflowResult } from '../src/surface/normalize.js';

const userRow = {
  type: 'message',
  id: 'm1',
  message: { role: 'user', content: [{ type: 'text', text: '请审核合同' }] },
};
const stepStart = { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } };

describe('applySnapshotThenBuffer', () => {
  it('lays the snapshot down first, then replays the buffer in order', () => {
    const entries = applySnapshotThenBuffer(
      { entries: [userRow, stepStart], streamingMessage: null, streaming: false },
      [
        {
          type: 'entry_appended',
          entry: { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', output: { riskFindings: [] } } },
        },
      ],
      applySurfaceEvent,
    );
    expect(entries.map((e) => e.kind)).toEqual(['message', 'custom', 'custom']);
    expect(extractWorkflowResult(entries)).toEqual({ review: { riskFindings: [] } });
  });

  it('drops a buffered custom row the snapshot already carries', () => {
    const entries = applySnapshotThenBuffer(
      { entries: [stepStart] },
      [{ type: 'entry_appended', entry: stepStart }],
      applySurfaceEvent,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'custom', id: 'c1' });
  });

  it('folds streamingMessage into the same slot the buffered message_update replaces', () => {
    const entries = applySnapshotThenBuffer(
      {
        entries: [userRow],
        streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] },
        streaming: true,
      },
      [{ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] } }],
      applySurfaceEvent,
    );
    expect(entries.filter((e) => e.kind === 'message' && e.role === 'assistant')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ kind: 'message', role: 'assistant', text: '第3条存在期限不对齐', streaming: true });
  });

  it('keeps a step row that landed between the snapshot and the next message tick', () => {
    const entries = applySnapshotThenBuffer(
      {
        entries: [userRow],
        streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] },
        streaming: true,
      },
      [
        { type: 'entry_appended', entry: { type: 'custom', id: 'c9', customType: 'workflow_step_end', data: { stepId: 'review', output: { ok: true } } } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] } },
      ],
      applySurfaceEvent,
    );
    expect(entries.map((e) => e.kind)).toEqual(['message', 'message', 'custom']);
    expect(entries[1]).toMatchObject({ kind: 'message', text: '第3条存在期限不对齐', streaming: false });
  });

  it('finalizes the folded slot when the snapshot is not streaming', () => {
    const entries = applySnapshotThenBuffer(
      { entries: [], streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '已完成' }] }, streaming: false },
      [],
      applySurfaceEvent,
    );
    expect(entries.at(-1)).toMatchObject({ kind: 'message', text: '已完成', streaming: false });
  });

  it('tolerates a snapshot with no entries at all', () => {
    expect(applySnapshotThenBuffer({}, [], applySurfaceEvent)).toEqual([]);
  });
});

describe('shouldRebuildOnCompaction', () => {
  it('rebuilds after a successful compaction_end', () => {
    expect(shouldRebuildOnCompaction({ type: 'compaction_end', aborted: false, willRetry: false, result: { tokensBefore: 1 } })).toBe(true);
    expect(shouldRebuildOnCompaction({ type: 'compaction_end' })).toBe(true);
  });

  it('does not rebuild on an aborted, retrying, or failed compaction', () => {
    expect(shouldRebuildOnCompaction({ type: 'compaction_end', aborted: true })).toBe(false);
    expect(shouldRebuildOnCompaction({ type: 'compaction_end', willRetry: true })).toBe(false);
    expect(shouldRebuildOnCompaction({ type: 'compaction_end', errorMessage: 'context too large' })).toBe(false);
  });

  it('ignores other events', () => {
    expect(shouldRebuildOnCompaction({ type: 'compaction_start' })).toBe(false);
    expect(shouldRebuildOnCompaction({ type: 'agent_end' })).toBe(false);
    expect(shouldRebuildOnCompaction(null)).toBe(false);
  });
});
