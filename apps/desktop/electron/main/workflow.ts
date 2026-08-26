import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { LinearRunner, type ProposalDecision, type RunContext, type WorkflowDef } from '@sparkii/agent-host';
import { computeEditDiff } from '@sparkii/agent-host';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalRequest } from '@sparkii/approval';
import type { ModelTask } from '@sparkii/model-router';
import type { Runtime } from './runtime.js';
import { buildProfileSaddle } from './saddle.js';
import { isReadOnlyBashCommand, riskOfCommand } from './general-executor.js';

const allTools = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

export function createBroker(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const resolvers = new Map<string, { resolve: (d: ProposalDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    async request(req: ProposalRequest, meta: { sessionId: string; profileId: string }): Promise<ProposalDecision> {
      const p = await rt.gate.submit(req, { profileId: meta.profileId, sessionId: meta.sessionId, actor: rt.subject?.userId ?? 'agent' });
      getWindow()?.webContents.send('sparkii:event:approval', p);
      return new Promise<ProposalDecision>((resolve) => {
        const timer = setTimeout(() => {
          rt.gate.expire(p.id).then((expired) => {
            resolve({ approved: false, proposalId: p.id, status: expired?.status ?? 'expired' });
            resolvers.delete(p.id);
          });
        }, rt.profileOf(meta.profileId).profile.security.approval.timeoutMs);
        resolvers.set(p.id, { resolve, timer });
      });
    },
    async requestReadOnly(req: ProposalRequest & { requestId: string }, meta: { sessionId: string; profileId: string }): Promise<ProposalDecision> {
      const result = await rt.executor.execute({
        ...req,
        id: req.requestId, profileId: meta.profileId, sessionId: meta.sessionId,
        payloadHash: '', status: 'approved', createdAt: Date.now(),
      } as any, { actor: rt.subject?.userId ?? 'agent' });
      await rt.audit.append({ actor: rt.subject?.userId ?? 'agent', action: 'tool.read', resource: req.toolName, sessionId: meta.sessionId });
      return { approved: true, proposalId: req.requestId, status: result.status, result: result.execution?.result };
    },
    route(req: ProposalRequest & { requestId: string }, meta: { sessionId: string; profileId: string }): Promise<ProposalDecision> {
      if (req.toolName === 'bash' && isReadOnlyBashCommand(String((req.payload as any)?.command ?? ''))) {
        return this.requestReadOnly(req, meta);
      }
      if (req.toolName === 'edit' || req.toolName === 'write' || req.toolName === 'bash') {
        req = { ...req, payload: attachDiff(rt, req), risk: req.toolName === 'bash' ? riskOfCommand(String((req.payload as any)?.command ?? '')) : req.risk };
      }
      return this.request(req, meta);
    },
    decide(id: string, decision: Omit<ProposalDecision, 'proposalId'>) {
      const entry = resolvers.get(id);
      if (entry) { clearTimeout(entry.timer); entry.resolve({ ...decision, proposalId: id }); resolvers.delete(id); }
    },
  };
}

function attachDiff(rt: Runtime, req: ProposalRequest & { requestId: string }): unknown {
  const payload = (req.payload ?? {}) as { path?: string; content?: string };
  if ((req.toolName === 'edit' || req.toolName === 'write') && payload.path) {
    let oldText = '';
    try { oldText = readFileSync(payload.path, 'utf8'); } catch { oldText = ''; }
    return { ...payload, diff: computeEditDiff(oldText, String(payload.content ?? ''), payload.path) };
  }
  return payload;
}

export async function selectModel(rt: Runtime, task: ModelTask, sessionId: string): Promise<void> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  const target = rt.profileOf('contract-review').router.resolve(task);
  if (!target) return;
  const resp = await client.send({ type: 'set_model', provider: target.provider, modelId: target.modelId });
  if (!resp.success) throw new Error(`cannot select model ${target.provider}/${target.modelId}: ${resp.error ?? 'unknown'}`);
}

async function sendPrompt(rt: Runtime, text: string, task: ModelTask, sessionId: string): Promise<string> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  await selectModel(rt, task, sessionId);

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
      profileId: rt.profileOf('contract-review').profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', requestId: randomUUID(),
    });
  }
  const d = await broker.route({
    requestId: randomUUID(), toolName, targetSystem: toolName.split('.')[0], summary: JSON.stringify(args).slice(0, 512), payload: args, risk: tool.sideEffect,
  }, { sessionId, profileId: 'contract-review' });
  return { ok: d.approved, data: d.result };
}

export function resolveWorkflowTemplates(def: WorkflowDef): WorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.type === 'skill' && step.ref) {
        // /skill:NAME expands the skill file into the prompt (pi-native), so the
        // agent follows the actual skill content instead of hunting for the file.
        return { ...step, template: `/skill:${step.ref}\n请严格遵循上述 skill 的内容完成本步骤，并将结果直接返回。` };
      }
      if (step.type === 'llm' && step.template) {
        return { ...step, template: `/skill:${step.template}\n严格遵循上述 skill 的内容完成本步骤。若 skill 要求调用写工具，请直接调用（工具调用会自动弹出审批请求，无需先在对话中征询用户），并将结果直接返回。` };
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
  const sessionId = randomUUID();
  const pr = rt.profileOf('contract-review');
  const slot = await rt.pool.acquire(sessionId, {
    saddle: buildProfileSaddle(pr, join(rt.dataDir, 'sessions', sessionId)),
  });
  slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId: 'contract-review' }));
  try {
    const rawDef = pr.profile.agent.workflow as unknown as WorkflowDef;
    const def = resolveWorkflowTemplates(rawDef);
    const ctx: RunContext = {
      profileId: pr.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', input,
      sendPrompt: (text, task) => sendPrompt(rt, text, (task as ModelTask) ?? 'default', sessionId),
      runTool: (name, args) => runTool(rt, broker, name, args, sessionId),
      requestApproval: async (req) => {
        const d = await broker.route({ ...req, requestId: randomUUID() }, { sessionId, profileId: 'contract-review' });
        return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
      },
    };
    const win = getWindow();
    let finalState: Record<string, unknown> = {};
    for await (const e of new LinearRunner().run(def, ctx)) {
      win?.webContents.send('sparkii:event:workflow', { ...e, sessionId });
      if (e.type === 'workflow_completed') finalState = e.result as Record<string, unknown>;
    }
    win?.webContents.send('sparkii:event:state', { workflow: { result: finalState }, sessionId });
  } finally {
    await rt.pool.release(sessionId);
  }
}
