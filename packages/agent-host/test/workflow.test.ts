import { describe, it, expect } from 'vitest';
import { LinearRunner } from '../src/workflow/linear.js';
import type { RunContext, WorkflowDef } from '../src/workflow/types.js';

async function collect(def: WorkflowDef, ctx: RunContext) {
  const events = [];
  for await (const e of new LinearRunner().run(def, ctx)) events.push(e);
  return events;
}

const def: WorkflowDef = {
  version: 1, engine: 'linear',
  steps: [
    { id: 'load', type: 'tool', ref: 'document.read' },
    { id: 'extract', type: 'skill', ref: 'clause_extract', inputs: { from: 'load' } },
    { id: 'review', type: 'human', inputs: { from: 'extract' } },
  ],
};

describe('LinearRunner', () => {
  it('runs steps in order and emits lifecycle events', async () => {
    const ctx: RunContext = {
      profileId: 'p', sessionId: 's', actor: 'u1', input: {},
      runTool: async () => ({ ok: true, data: { text: 'clauses' } }),
      sendPrompt: async (t) => `echo:${t}`,
      requestApproval: async (req) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: 1 } as any),
    };
    const events = await collect(def, ctx);
    expect(events.map((e) => e.type)).toEqual(['step_started', 'tool_call', 'step_completed', 'step_started', 'step_completed', 'step_started', 'approval_required', 'step_completed', 'workflow_completed']);
  });

  it('fails workflow on tool error', async () => {
    const ctx: RunContext = { ...({} as RunContext), runTool: async () => ({ ok: false, error: { code: 'CONNECTOR_IO', message: 'x' } }) };
    const events = await collect(def, ctx);
    expect(events.at(-1)).toMatchObject({ type: 'workflow_failed' });
  });

  it('joins /skill:name and JSON args with a space so Pi can expand the skill', async () => {
    let prompt = '';
    const skillDef: WorkflowDef = {
      version: 1,
      engine: 'linear',
      steps: [{ id: 'extract', type: 'skill', ref: 'clause_extract', template: '/skill:clause_extract', inputs: { from: 'load' } }],
    };
    await collect(skillDef, {
      profileId: 'p', sessionId: 's', actor: 'u1',
      input: { load: { text: 'doc' } },
      runTool: async () => ({ ok: true, data: {} }),
      sendPrompt: async (t) => { prompt = t; return '{}'; },
      requestApproval: async (req) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: 1 } as any),
    });
    expect(prompt.startsWith('/skill:clause_extract ')).toBe(true);
    expect(prompt).not.toMatch(/^\/skill:[^\s]*\n/);
    expect(JSON.parse(prompt.slice('/skill:clause_extract '.length))).toEqual({ load: { text: 'doc' } });
  });

});
