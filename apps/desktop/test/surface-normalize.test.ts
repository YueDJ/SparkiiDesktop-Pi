import { describe, it, expect } from 'vitest';
import { normalizeSessionEntries, applySurfaceEvent, deriveWorkflowTimeline, extractWorkflowResult } from '../src/surface/normalize.js';

describe('surface normalize', () => {
  it('maps workflow_step_start/end to typed entries', () => {
    const out = normalizeSessionEntries([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上传合同' }] } },
      { type: 'workflow_step_start', data: { stepId: 'compare', startedAt: '2026-09-02T00:00:00Z' } },
      { type: 'workflow_step_end', data: { stepId: 'compare', status: 'completed' } },
      { type: 'workflow_state', data: { stepId: 'compare', action: 'risk_confirmed', payload: { riskId: 'f0' } } },
    ]);
    expect(out.map((e) => e.kind)).toContain('workflow_step');
    expect(out.map((e) => e.kind)).toContain('workflow_state');
    const step = out.find((e) => e.kind === 'workflow_step') as any;
    expect(step.state).toBe('start');
  });

  it('applies a live message event onto entries', () => {
    const base = normalizeSessionEntries([]);
    const next = applySurfaceEvent(base, { type: 'message', role: 'assistant', delta: '你好' });
    expect(next.at(-1)?.kind).toBe('message');
  });

  it('derives done status when all steps completed', () => {
    const entries = normalizeSessionEntries([
      { type: 'workflow_step_start', data: { stepId: 'load' } },
      { type: 'workflow_step_end', data: { stepId: 'load', status: 'completed' } },
      { type: 'workflow_step_start', data: { stepId: 'report' } },
      { type: 'workflow_step_end', data: { stepId: 'report', status: 'completed' } },
    ]);
    expect(deriveWorkflowTimeline(entries)).toEqual({ status: 'done', step: 'report' });
  });

  it('derives running when a step started but not finished', () => {
    const entries = normalizeSessionEntries([
      { type: 'workflow_step_start', data: { stepId: 'compare' } },
    ]);
    expect(deriveWorkflowTimeline(entries)).toEqual({ status: 'running', step: 'compare' });
  });

  it('extracts the authoritative workflow result from workflow_state', () => {
    const entries = normalizeSessionEntries([
      { type: 'workflow_state', data: { stepId: 'report', action: 'result', payload: { report: { title: '报告' }, compare: [{ 条款: '第1条', 风险: '高' }] } } },
    ]);
    expect(extractWorkflowResult(entries)).toMatchObject({ report: { title: '报告' }, compare: [{ 条款: '第1条', 风险: '高' }] });
  });
});
