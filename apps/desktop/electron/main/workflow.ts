import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { LinearRunner, type RunContext } from '@sparkii/agent-host';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalRequest } from '@sparkii/approval';
import type { Runtime } from './runtime.js';

export interface Decision { approved: boolean; proposalId: string; status: string; result?: unknown }

const allTools = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

export function createBroker(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const resolvers = new Map<string, { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    async request(req: ProposalRequest, sessionId: string): Promise<Decision> {
      const p = await rt.gate.submit(req, { profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent' });
      getWindow()?.webContents.send('sparkii:event:approval', p);
      return new Promise<Decision>((resolve) => {
        const timer = setTimeout(() => {
          rt.gate.expire(p.id).then((expired) => {
            resolve({ approved: false, proposalId: p.id, status: expired?.status ?? 'expired' });
            resolvers.delete(p.id);
          });
        }, rt.profile.security.approval.timeoutMs);
        resolvers.set(p.id, { resolve, timer });
      });
    },
    decide(id: string, decision: Omit<Decision, 'proposalId'>) {
      const entry = resolvers.get(id);
      if (entry) { clearTimeout(entry.timer); entry.resolve({ ...decision, proposalId: id }); resolvers.delete(id); }
    },
  };
}

async function sendPrompt(rt: Runtime, text: string): Promise<string> {
  const client = await rt.supervisor.start();
  let acc = '';
  let off = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
    off = client.onEvent((e) => {
      if (e.type === 'message' && e.role === 'assistant') acc += e.delta ?? e.text ?? '';
      if (e.type === 'agent_end') { clearTimeout(timeout); off(); resolve(); }
    });
  });
  await client.send({ type: 'prompt', message: text });
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

export async function runWorkflow(rt: Runtime, getWindow: () => BrowserWindow | null, input: Record<string, unknown>): Promise<void> {
  const def = rt.profile.agent.workflow as unknown as { version: 1; engine: 'linear'; steps: unknown[] };
  const broker = createBroker(rt, getWindow);
  const ctx: RunContext = {
    profileId: rt.profile.manifest.name, sessionId: 'default', actor: rt.subject?.userId ?? 'agent', input,
    sendPrompt: (text) => sendPrompt(rt, text),
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
