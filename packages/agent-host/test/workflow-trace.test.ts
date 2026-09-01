import { describe, expect, it } from 'vitest';
import { parseWorkflowTimeline } from '../src/session-catalog.js';

describe('parseWorkflowTimeline', () => {
  it('parses workflow step markers and state entries', () => {
    const entries = [
      { type: 'workflow_step_start', stepId: 'compare' },
      { type: 'message', message: { role: 'assistant', content: 'x' } },
      { type: 'workflow_step_end', stepId: 'compare', status: 'completed' },
      { type: 'workflow_state', stepId: 'compare', action: 'risk_confirmed', riskId: 'r1' },
    ];

    const timeline = parseWorkflowTimeline(entries);
    expect(timeline.steps).toHaveLength(2);
    expect(timeline.stateEvents).toHaveLength(1);
    expect(timeline.stateEvents[0].action).toBe('risk_confirmed');
  });
});
