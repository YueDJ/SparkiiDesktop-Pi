import { describe, it, expect } from 'vitest';
import { normalizeSessionEntries, applySurfaceEvent, deriveWorkflowTimeline, extractWorkflowResult } from '../src/surface/normalize.js';

describe('surface normalize', () => {
  it('maps workflow_step_start/end to typed entries', () => {
    const out = normalizeSessionEntries([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上传合同' }] } },
      { type: 'custom', customType: 'workflow_step_start', data: { stepId: 'compare', startedAt: '2026-09-02T00:00:00Z' } },
      { type: 'custom', customType: 'workflow_step_end', data: { stepId: 'compare', status: 'completed' } },
      { type: 'custom', customType: 'workflow_state', data: { stepId: 'compare', action: 'risk_confirmed', payload: { riskId: 'f0' } } },
    ]);
    expect(out.map((e) => e.kind)).toContain('custom');
    const step = out.find((e) => e.kind === 'custom' && e.customType === 'workflow_step_start') as any;
    expect(step).toMatchObject({ kind: 'custom', customType: 'workflow_step_start', data: { stepId: 'compare' } });
  });

  it('applies a live message event onto entries', () => {
    const base = normalizeSessionEntries([]);
    const next = applySurfaceEvent(base, { type: 'message', role: 'assistant', delta: '你好' });
    expect(next.at(-1)?.kind).toBe('message');
  });

  it('keeps a user message in the live timeline (mirrors the JSONL)', () => {
    const base = normalizeSessionEntries([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '先' }] } }]);
    const next = applySurfaceEvent(base, { type: 'message', role: 'user', text: '先检查一下结果' });
    expect(next.at(-1)).toMatchObject({ kind: 'message', role: 'user', text: '先检查一下结果' });
  });

  it('does not double-echo the same consecutive user message', () => {
    const base = normalizeSessionEntries([]);
    const once = applySurfaceEvent(base, { type: 'message', role: 'user', text: '你好' });
    const twice = applySurfaceEvent(once, { type: 'message', role: 'user', text: '你好' });
    expect(twice).toHaveLength(1);
  });

  it('applies an assistant thinking delta onto entries', () => {
    const next = applySurfaceEvent([], { type: 'message', role: 'assistant', thinkingDelta: '让我想想' });
    expect(next.at(-1)).toMatchObject({ kind: 'message', role: 'assistant', thinking: '让我想想', streaming: true });
  });

  it('pairs tool_call with tool_result in the live stream', () => {
    let entries = applySurfaceEvent([], { type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', toolName: 'bash', toolCallId: 'c1' });
    entries = applySurfaceEvent(entries, { type: 'tool_result', toolName: 'bash', toolCallId: 'c1', result: { exitCode: 0 } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', result: { exitCode: 0 } });
  });

  it('maps a compaction event from history into a typed lifecycle entry', () => {
    const next = normalizeSessionEntries([{ type: 'compaction', summary: '已压缩', tokensBefore: 1000 }]);
    expect(next.at(-1)).toMatchObject({ kind: 'event', event: 'compaction' });
  });

  it('maps a live runtime_error event into a typed lifecycle entry', () => {
    const next = applySurfaceEvent([], { type: 'runtime_error', message: 'api rate limit' });
    expect(next.at(-1)).toMatchObject({ kind: 'event', event: 'runtime_error' });
  });

  it('normalizes assistant toolCall and toolResult content into a paired tool entry', () => {
    const out = normalizeSessionEntries([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'out' }] } },
    ]);
    const tool = out.find((e) => e.kind === 'tool') as any;
    expect(tool).toMatchObject({ kind: 'tool', toolName: 'bash', result: { content: [{ type: 'text', text: 'out' }] } });
  });

  it('derives done status when all steps completed', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', customType: 'workflow_step_start', data: { stepId: 'load' } },
      { type: 'custom', customType: 'workflow_step_end', data: { stepId: 'load', status: 'completed' } },
      { type: 'custom', customType: 'workflow_step_start', data: { stepId: 'report' } },
      { type: 'custom', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed' } },
    ]);
    expect(deriveWorkflowTimeline(entries)).toEqual({ status: 'done', step: 'report' });
  });

  it('derives running when a step started but not finished', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', customType: 'workflow_step_start', data: { stepId: 'compare' } },
    ]);
    expect(deriveWorkflowTimeline(entries)).toEqual({ status: 'running', step: 'compare' });
  });

  it('extracts the authoritative workflow result from workflow_state', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '报告' } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'compare', status: 'completed', output: [{ 条款: '第1条', 风险: '高' }] } },
    ]);
    expect(extractWorkflowResult(entries)).toMatchObject({ report: { title: '报告' }, compare: [{ 条款: '第1条', 风险: '高' }] });
  });

  it('keeps Pi custom entries in JSONL order with chat messages', () => {
    const out = normalizeSessionEntries([
      { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '开始' }] } },
      { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' }, timestamp: '2026-09-03T00:00:00Z' },
      { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: '{}' }] } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [] } } },
    ]);
    expect(out.map((e) => e.kind)).toEqual(['message', 'custom', 'message', 'custom']);
    expect(out[1]).toMatchObject({ kind: 'custom', id: 'c1', customType: 'workflow_step_start' });
  });

  it('applies live entry_appended the same as a JSONL custom row', () => {
    const next = applySurfaceEvent([], {
      type: 'entry_appended',
      entry: { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'load' } },
    });
    expect(next[0]).toMatchObject({ kind: 'custom', customType: 'workflow_step_start', data: { stepId: 'load' } });
  });

  it('merges step outputs by stepId', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '报告' } } },
    ]);
    expect(extractWorkflowResult(entries)).toEqual({
      review: { riskFindings: [{ id: 'r1' }] },
      report: { title: '报告' },
    });
  });
});
