import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { LinearRunner, type ProposalDecision, type RunContext, type WorkflowDef } from '@sparkii/agent-host';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalRequest } from '@sparkii/approval';
import type { ModelTask } from '@sparkii/model-router';
import type { Runtime } from './runtime.js';

const allTools = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

export function createBroker(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const resolvers = new Map<string, { resolve: (d: ProposalDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    async request(req: ProposalRequest, sessionId: string): Promise<ProposalDecision> {
      const p = await rt.gate.submit(req, { profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent' });
      getWindow()?.webContents.send('sparkii:event:approval', p);
      return new Promise<ProposalDecision>((resolve) => {
        const timer = setTimeout(() => {
          rt.gate.expire(p.id).then((expired) => {
            resolve({ approved: false, proposalId: p.id, status: expired?.status ?? 'expired' });
            resolvers.delete(p.id);
          });
        }, rt.profile.security.approval.timeoutMs);
        resolvers.set(p.id, { resolve, timer });
      });
    },
    decide(id: string, decision: Omit<ProposalDecision, 'proposalId'>) {
      const entry = resolvers.get(id);
      if (entry) { clearTimeout(entry.timer); entry.resolve({ ...decision, proposalId: id }); resolvers.delete(id); }
    },
  };
}

export async function selectModel(rt: Runtime, task: ModelTask): Promise<void> {
  const client = await rt.supervisor.start();
  const target = rt.router.resolve(task);
  if (!target) return;
  const resp = await client.send({ type: 'set_model', provider: target.provider, modelId: target.modelId });
  if (!resp.success) throw new Error(`cannot select model ${target.provider}/${target.modelId}: ${resp.error ?? 'unknown'}`);
}

async function sendPrompt(rt: Runtime, text: string, task: ModelTask = 'default'): Promise<string> {
  const client = await rt.supervisor.start();
  await selectModel(rt, task);

  let acc = '';
  let off = () => {};
  let settled = false;
  let finish!: (err?: Error) => void;
  let timer!: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((resolve, reject) => {
    finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(() => finish(new Error('prompt timeout')), 300_000);
  });
  off = client.onEvent((e) => {
    if (e.type === 'message' && e.role === 'assistant') {
      if (typeof e.delta === 'string') acc += e.delta;
      else if (typeof e.text === 'string') acc = e.text;
    }
    if (e.type === 'agent_end') finish();
  });

  const resp = await client.send({ type: 'prompt', message: text });
  if (!resp.success) finish(new Error(resp.error ?? 'prompt failed'));

  await done;
  return acc;
}

async function runTool(rt: Runtime, broker: ReturnType<typeof createBroker>, toolName: string, args: unknown, sessionId: string) {
  const tool = allTools.get(toolName);
  if (!tool) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: toolName } };
  if (tool.sideEffect === 'read') {
    return tool.handler(args as Record<string, unknown>, {
      profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', requestId: randomUUID(),
    });
  }
  const d = await broker.request({
    toolName, targetSystem: toolName.split('.')[0], summary: JSON.stringify(args).slice(0, 512), payload: args, risk: tool.sideEffect,
  }, sessionId);
  return { ok: d.approved, data: d.result };
}

export function resolveWorkflowTemplates(def: WorkflowDef, prompts: Record<string, string>): WorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.type === 'skill' && step.ref && prompts[step.ref] != null) {
        return { ...step, template: prompts[step.ref] };
      }
      if (step.type === 'llm' && step.template && prompts[step.template] != null) {
        return { ...step, template: prompts[step.template] };
      }
      return step;
    }),
  };
}

export async function runWorkflow(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
): Promise<void> {
  const rawDef = rt.profile.agent.workflow as unknown as WorkflowDef;
  const prompts = (rt.profile.agent.prompts ?? {}) as Record<string, string>;
  const def = resolveWorkflowTemplates(rawDef, prompts);
  const ctx: RunContext = {
    profileId: rt.profile.manifest.name, sessionId: 'default', actor: rt.subject?.userId ?? 'agent', input,
    sendPrompt: (text, task) => sendPrompt(rt, text, (task as ModelTask) ?? 'default'),
    runTool: (name, args) => runTool(rt, broker, name, args, 'default'),
    requestApproval: async (req) => {
      const d = await broker.request(req, 'default');
      return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
    },
  };
  const win = getWindow();
  let finalState: Record<string, unknown> = {};
  for await (const e of new LinearRunner().run(def, ctx)) {
    win?.webContents.send('sparkii:event:workflow', e);
    if (e.type === 'workflow_completed') finalState = e.result as Record<string, unknown>;
  }
  win?.webContents.send('sparkii:event:state', { workflow: { result: finalState } });
}
