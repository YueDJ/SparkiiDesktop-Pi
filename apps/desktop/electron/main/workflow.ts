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
import type { Logger } from './logger.js';
import { buildAgentSaddle } from './saddle.js';
import { isReadOnlyBashCommand, riskOfCommand } from './general-executor.js';
import { loadSettings, type AppSettings } from './settings.js';

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
        const command = String((req.payload as any)?.command ?? '');
        const risk = req.toolName === 'bash' ? riskOfCommand(command) : req.risk;
        req = { ...req, payload: attachDiff(rt, req), risk };
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

export function resolveModelTarget(
  settings: AppSettings,
  task: ModelTask,
): { provider: string; modelId: string } | null {
  const provider = settings.activeProviderId ?? 'deepseek';
  const routes = settings.routes ?? {};
  const modelId = routes[task] || routes.default || settings.defaultModel || '';
  if (!modelId) return null;
  return { provider, modelId };
}

export function resolveSessionModel(
  settings: AppSettings,
  rec: { model: string | null } | null | undefined,
): { provider: string; modelId: string } | null {
  const provider = settings.activeProviderId ?? 'deepseek';
  if (rec?.model) {
    const slash = rec.model.indexOf('/');
    return slash >= 0
      ? { provider: rec.model.slice(0, slash), modelId: rec.model.slice(slash + 1) }
      : { provider, modelId: rec.model };
  }
  return resolveModelTarget(settings, 'chat');
}

export function modelTargetKey(target: { provider: string; modelId: string }): string {
  return `${target.provider}/${target.modelId}`;
}

export function resolveThinkingLevel(
  settings: AppSettings,
  rec: { thinkingLevel: string | null } | null | undefined,
  target: { provider: string; modelId: string } | null,
): string | null {
  if (rec?.thinkingLevel) return rec.thinkingLevel;
  if (target) {
    const remembered = settings.modelThinkingLevels?.[`${target.provider}/${target.modelId}`];
    if (remembered) return remembered;
  }
  return settings.defaultThinkingLevel ?? null;
}

export async function applyThinkingLevel(
  client: { send: (command: any) => Promise<{ success: boolean; error?: string }> },
  level: string | null,
): Promise<void> {
  if (!level) return;
  const resp = await client.send({ type: 'set_thinking_level', level });
  if (!resp.success) throw new Error(`cannot set thinking level ${level}: ${resp.error ?? 'unknown'}`);
}

export async function selectModel(
  rt: Runtime,
  task: ModelTask,
  sessionId: string,
  override?: string | null,
): Promise<{ provider: string; modelId: string } | null> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  const settings = await loadSettings(rt.dataDir);
  const chosen = override ?? rt.chatSessions?.get?.(sessionId)?.model ?? null;
  let provider: string;
  let modelId: string;
  if (chosen) {
    const slash = chosen.indexOf('/');
    if (slash >= 0) {
      provider = chosen.slice(0, slash);
      modelId = chosen.slice(slash + 1);
    } else {
      provider = settings.activeProviderId ?? 'deepseek';
      modelId = chosen;
    }
  } else {
    const target = resolveModelTarget(settings, task);
    if (!target) return null;
    provider = target.provider;
    modelId = target.modelId;
  }
  const apiKey = await rt.keyFor(provider);
  if (apiKey) {
    const keyResp = await client.send({ type: 'set_api_key', provider, apiKey });
    if (!keyResp.success) throw new Error(`cannot set api key for ${provider}: ${keyResp.error ?? 'unknown'}`);
  }
  const resp = await client.send({ type: 'set_model', provider, modelId });
  if (!resp.success) throw new Error(`cannot select model ${provider}/${modelId}: ${resp.error ?? 'unknown'}`);
  return { provider, modelId };
}

function assistantTextFromMessage(message: unknown): string {
  const rec = message && typeof message === 'object' ? message as Record<string, unknown> : {};
  const content = rec.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block && typeof block === 'object' ? block as Record<string, unknown> : {};
        return b.type === 'text' ? String(b.text ?? '') : '';
      })
      .join('');
  }
  return typeof rec.text === 'string' ? rec.text : '';
}

async function sendPrompt(rt: Runtime, text: string, task: ModelTask, sessionId: string): Promise<string> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  const rec = rt.chatSessions?.get?.(sessionId);
  const target = await selectModel(rt, task, sessionId, rec?.model);
  if (target) {
    const settings = await loadSettings(rt.dataDir);
    await applyThinkingLevel(client, resolveThinkingLevel(settings, rec, target));
  }

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
    if ((e.type === 'message_update' || e.type === 'message_end') && e.message) {
      acc = assistantTextFromMessage(e.message);
    }
    if (e.type === 'agent_end') finish();
  });

  const resp = await client.send({ type: 'prompt', message: text });
  if (!resp.success) finish(new Error(resp.error ?? 'prompt failed'));

  await done;
  return acc;
}

async function runTool(
  rt: Runtime,
  broker: ReturnType<typeof createBroker>,
  toolName: string,
  args: unknown,
  sessionId: string,
  profileId: string,
) {
  const tool = allTools.get(toolName);
  if (!tool) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: toolName } };
  if (tool.sideEffect === 'read') {
    return tool.handler(args as Record<string, unknown>, {
      profileId: rt.profileOf(profileId).profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', requestId: randomUUID(),
    });
  }
  const d = await broker.route({
    requestId: randomUUID(), toolName, targetSystem: toolName.split('.')[0], summary: JSON.stringify(args).slice(0, 512), payload: args, risk: tool.sideEffect,
  }, { sessionId, profileId });
  return { ok: d.approved, data: d.result };
}

/** Workflow saddle only exposes tool-step refs plus read. Other agent tools stay on the executor. */
export function workflowRuntimeTools(agentTools: string[], def: WorkflowDef): string[] {
  const stepTools = new Set(def.steps.filter((s) => s.type === 'tool').map((s) => s.ref));
  return agentTools.filter((t) => stepTools.has(t) || t === 'read');
}

export function resolveWorkflowTemplates(def: WorkflowDef): WorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.type === 'skill' && step.ref) {
        return { ...step, template: `/skill:${step.ref}` };
      }
      if (step.type === 'llm' && step.template) {
        return { ...step, template: `/skill:${step.template}` };
      }
      return step;
    }),
  };
}

export interface WorkflowRunHooks {
  onReady?: (sessionId: string, slot: Awaited<ReturnType<Runtime['pool']['acquire']>>) => void;
  beforeRelease?: (sessionId: string) => void | Promise<void>;
  logger?: Pick<Logger, 'log'>;
}

export async function runWorkflow(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
  profileId: string,
  opts?: WorkflowRunHooks,
): Promise<string> {
  const pr = rt.profileOf(profileId);
  const agent = rt.agentOf(profileId);
  const rawDef = pr.profile.agent.workflow as unknown as WorkflowDef;
  const runtimeAgent = { ...agent, tools: workflowRuntimeTools(agent.tools, rawDef) };
  const workspacePath = typeof input.workspacePath === 'string' && input.workspacePath.trim()
    ? input.workspacePath
    : undefined;
  const sessionModel = typeof input.model === 'string' && input.model.trim() ? input.model : null;
  const sessionThinking = typeof input.thinkingLevel === 'string' && input.thinkingLevel.trim()
    ? input.thinkingLevel
    : null;
  const settings = await loadSettings(rt.dataDir);
  const target = resolveSessionModel(settings, sessionModel ? { model: sessionModel } : null);
  const thinkingLevel = sessionThinking ?? resolveThinkingLevel(settings, { thinkingLevel: sessionThinking }, target);
  const tempKey = `new:${randomUUID()}`;
  const slot = await rt.pool.acquire(tempKey, {
    saddle: buildAgentSaddle(
      runtimeAgent,
      join(rt.dataDir, 'sessions', tempKey),
      workspacePath,
      target ?? undefined,
      thinkingLevel,
    ),
  });

  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  try {
    const freshResp = await slot.client.send({ type: 'new_session' });
    if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
    const stateResp = await slot.client.send({ type: 'get_state' });
    if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
    sessionId = (stateResp.data as { sessionId?: string } | undefined)?.sessionId;
    sessionFile = (stateResp.data as { sessionFile?: string } | undefined)?.sessionFile;
    if (!sessionId) throw new Error('runtime did not provide a session id');
    rt.pool.renameSession(tempKey, sessionId);

    const inputFiles = Array.isArray(input?.documents) ? JSON.stringify(input.documents) : null;
    rt.chatSessions?.create?.({
      id: sessionId,
      profileId,
      kind: 'workflow',
      currentStep: null,
      workspaceKind: input.workspaceKind === 'user' || (!input.workspaceKind && workspacePath) ? 'user' : 'auto',
      workspacePath: workspacePath ?? join(rt.dataDir, 'sessions', sessionId),
      model: sessionModel ?? (target ? modelTargetKey(target) : null),
      thinkingLevel: sessionThinking ?? thinkingLevel,
      inputs: inputFiles,
      piSessionFile: sessionFile ?? null,
    });
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId: sessionId!, profileId }));
    opts?.onReady?.(sessionId, slot);
  } catch (err) {
    if (sessionId) await opts?.beforeRelease?.(sessionId);
    await rt.pool.release(sessionId ?? tempKey);
    throw err;
  }

  const readySessionId = sessionId;
  void runWorkflowLoop(rt, getWindow, slot, broker, pr, readySessionId, profileId, input, opts).catch((error) => {
    void opts?.logger?.log({
      level: 'error',
      msg: 'workflow loop crashed',
      ctx: { sessionId: readySessionId, error: error instanceof Error ? error.message : String(error) },
    });
  });
  return readySessionId;
}

function profileDisplayName(pr: ReturnType<Runtime['profileOf']>): string {
  const manifest = pr.profile.manifest as { displayName?: string; name?: string };
  return manifest.displayName ?? manifest.name ?? '';
}

function outputByteLength(output: unknown): number {
  if (output === undefined) return 0;
  try {
    return Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output) ?? '', 'utf8');
  } catch {
    return -1;
  }
}

/**
 * 步骤行写入器。成功记 debug；失败必须暴露：
 * Logger.error（只记 output 字节数，不写整份 output）+ 错误中心恰好一行（主进程唯一写入者，
 * 同一 `errorId` 经现有 chat-event 通知窗口）+ 尽量补一条很小的 failed end，然后停循环。
 */
function createStepJournal(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  slot: Awaited<ReturnType<Runtime['pool']['acquire']>>,
  pr: ReturnType<Runtime['profileOf']>,
  sessionId: string,
  logger?: Pick<Logger, 'log'>,
) {
  const append = async (customType: string, data: Record<string, unknown>): Promise<void> => {
    const resp = await slot.client?.send?.({ type: 'append_workflow_entry', customType, data });
    if (!resp?.success) throw new Error(resp?.error ?? 'append_workflow_entry failed');
    void logger?.log({
      level: 'debug',
      msg: 'workflow entry appended',
      ctx: { sessionId, stepId: String(data.stepId ?? ''), customType },
    });
  };

  const report = (customType: string, data: Record<string, unknown>, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    void logger?.log({
      level: 'error',
      msg: 'workflow entry append failed',
      ctx: {
        sessionId,
        stepId: String(data.stepId ?? ''),
        customType,
        error: message,
        outputBytes: outputByteLength(data.output),
      },
    });
    const errorId = randomUUID();
    const source = profileDisplayName(pr);
    const text = `步骤记录写入失败（${String(data.stepId ?? '')}）：${message}`;
    rt.errors?.append?.({ id: errorId, message: text, source, createdAt: Date.now() });
    getWindow()?.webContents.send('sparkii:event:chat-event', {
      type: 'runtime_error',
      sessionId,
      message: text,
      errorId,
      source,
    });
  };

  return {
    /** 返回 false = 这一步没记下，调用方必须停循环。 */
    async record(customType: string, data: Record<string, unknown>): Promise<boolean> {
      try {
        await append(customType, data);
        return true;
      } catch (error) {
        report(customType, data, error);
        if (customType === 'workflow_step_end') {
          try {
            await append('workflow_step_end', {
              stepId: data.stepId,
              status: 'failed',
              error: {
                code: 'WORKFLOW_ENTRY_APPEND_FAILED',
                message: error instanceof Error ? error.message : String(error),
              },
              finishedAt: new Date().toISOString(),
            });
          } catch {
            void logger?.log({
              level: 'error',
              msg: 'workflow failed-end append also failed',
              ctx: { sessionId, stepId: String(data.stepId ?? '') },
            });
          }
        }
        return false;
      }
    },
  };
}

async function runWorkflowLoop(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  slot: Awaited<ReturnType<Runtime['pool']['acquire']>>,
  broker: ReturnType<typeof createBroker>,
  pr: ReturnType<Runtime['profileOf']>,
  sessionId: string,
  profileId: string,
  input: Record<string, unknown>,
  hooks?: WorkflowRunHooks,
): Promise<void> {
  const journal = createStepJournal(rt, getWindow, slot, pr, sessionId, hooks?.logger);
  try {
    const rawDef = pr.profile.agent.workflow as unknown as WorkflowDef;
    const def = resolveWorkflowTemplates(rawDef);
    const ctx: RunContext = {
      profileId: pr.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', input,
      sendPrompt: (text, task) => sendPrompt(rt, text, (task as ModelTask) ?? 'default', sessionId),
      runTool: (name, args) => runTool(rt, broker, name, args, sessionId, profileId),
      requestApproval: async (req) => {
        const d = await broker.route({ ...req, requestId: randomUUID() }, { sessionId, profileId });
        return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
      },
    };
    for await (const e of new LinearRunner().run(def, ctx)) {
      if (e.type === 'step_started') {
        rt.chatSessions?.update?.(sessionId, { currentStep: e.stepId });
        const recorded = await journal.record('workflow_step_start', {
          stepId: e.stepId,
          startedAt: new Date().toISOString(),
        });
        if (!recorded) break;
      }
      if (e.type === 'step_completed') {
        const recorded = await journal.record('workflow_step_end', {
          stepId: e.stepId,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          output: e.output,
        });
        if (!recorded) break;
      }
      if (e.type === 'workflow_failed') {
        const recorded = await journal.record('workflow_step_end', {
          stepId: e.stepId,
          status: 'failed',
          error: e.error,
          finishedAt: new Date().toISOString(),
        });
        if (!recorded) break;
      }
    }
  } finally {
    await hooks?.beforeRelease?.(sessionId);
    await rt.pool.release(sessionId);
  }
}
