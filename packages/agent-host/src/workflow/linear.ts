import type { RunContext, WorkflowDef, WorkflowEvent, WorkflowRunner } from './types.js';

export class LinearRunner implements WorkflowRunner {
  async *run(def: WorkflowDef, ctx: RunContext): AsyncIterable<WorkflowEvent> {
    const state: Record<string, unknown> = { ...ctx.input };
    for (const step of def.steps) {
      yield { type: 'step_started', stepId: step.id };
      try {
        if (step.type === 'tool') {
          yield { type: 'tool_call', stepId: step.id, toolName: step.ref };
          const r = await ctx.runTool(step.ref, resolveToolArgs(step, state));
          if (!r.ok) throw new Error(`${r.error?.code ?? 'ERROR'}: ${r.error?.message}`);
          state[step.id] = r.data;
        } else if (step.type === 'skill' || step.type === 'llm') {
          const text = await ctx.sendPrompt(`${step.template ?? ''}\n\n${JSON.stringify(resolveInputs(step, state))}`);
          state[step.id] = text;
        } else if (step.type === 'human') {
          const p = await ctx.requestApproval({ toolName: 'workflow.approval', targetSystem: 'workflow', summary: `step ${step.id}`, payload: { stepId: step.id, data: resolveInputs(step, state) }, risk: 'high-risk' });
          yield { type: 'approval_required', stepId: step.id, proposalId: p.id };
          state[step.id] = { proposalId: p.id, status: p.status };
        }
        yield { type: 'step_completed', stepId: step.id, output: state[step.id] };
      } catch (e) {
        yield { type: 'workflow_failed', stepId: step.id, error: { code: 'WORKFLOW_STEP_FAILED', message: (e as Error).message } };
        return;
      }
    }
    yield { type: 'workflow_completed', result: state };
  }
}

function resolveInputs(step: WorkflowDef['steps'][number], state: Record<string, unknown>): unknown {
  if (!step.inputs) return state;
  const refs = Array.isArray(step.inputs.from) ? step.inputs.from : [step.inputs.from];
  const picked = Object.fromEntries(refs.map((r) => [r, state[r]]));
  return picked;
}

function getPath(state: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[key] : undefined,
    state,
  );
}

function resolveToolArgs(step: WorkflowDef['steps'][number], state: Record<string, unknown>): unknown {
  if (step.map) return Object.fromEntries(Object.entries(step.map).map(([k, path]) => [k, getPath(state, path)]));
  return resolveInputs(step, state);
}
