import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { LinearRunner, type ProposalDecision, type RunContext, type WorkflowDef } from '@sparkii/agent-host';
import { connectorWriteProposal } from '@sparkii/agent-host';
import { documentConnector, knowledgeConnector, reportConnector, sparkiiOntoConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalSubmission } from '@sparkii/approval';
import type { ModelTask } from '@sparkii/model-router';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';
import type { TaskAdmissionToken } from './security/task-lifecycle.js';
import { buildAgentSaddle } from './saddle.js';
import { allocateAutoWorkspace } from './workspace.js';
import { loadSettings, type AppSettings } from './settings.js';
import { knowledgeFromManifest } from './rag-settings.js';
import { knowledgeBackendSettings, patchKnowledgeSettings, remoteKnowledgeBackend } from './knowledge-settings.js';
import { runMainKnowledgeSearch } from './rag-search.js';
import { executeDocumentRead } from './document-read.js';
import { executeOntologyTool } from './ontology-tools.js';
import { profilePoolMeta } from './pool-meta.js';

const allTools = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector, sparkiiOntoConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

type BrokerMeta = {
  sessionId: string;
  profileId: string;
  taskId?: string;
  admission?: TaskAdmissionToken;
};

export function createBroker(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const resolvers = new Map<string, {
    resolve: (d: ProposalDecision) => void;
    timer: ReturnType<typeof setTimeout>;
    meta: BrokerMeta;
    assertBinding?: () => void;
  }>();
  const settle = (id: string, decision: Omit<ProposalDecision, 'proposalId'>) => {
    const entry = resolvers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (!ownerActive(entry.meta, entry.assertBinding)) {
      entry.resolve({ approved: false, proposalId: id, status: 'denied' });
      resolvers.delete(id);
      return;
    }
    entry.resolve({ ...decision, proposalId: id });
    resolvers.delete(id);
  };
  if (typeof rt.gate.onProposalInvalidated === 'function') {
    rt.gate.onProposalInvalidated((proposal) => {
      settle(proposal.id, { approved: false, status: 'denied' });
    });
  }
  const bindingActive = (assertBinding?: () => void): boolean => {
    if (!assertBinding) return true;
    try { assertBinding(); return true; } catch { return false; }
  };
  const ownerActive = (meta: BrokerMeta, assertBinding?: () => void): boolean => {
    if (!bindingActive(assertBinding)) return false;
    const lifecycle = rt.security?.taskLifecycle;
    if (lifecycle && typeof lifecycle.owner === 'function') {
      const owner = lifecycle.owner(meta.sessionId);
      if (!owner) return false;
      if (meta.taskId && owner.taskId !== meta.taskId) return false;
      if (meta.admission && owner.admission !== meta.admission) return false;
      return true;
    }
    if (meta.taskId && rt.security?.taskLifecycle.active(meta.sessionId)?.taskId !== meta.taskId) return false;
    if (meta.admission && rt.security?.taskLifecycle.currentAdmission?.(meta.sessionId) !== meta.admission) return false;
    return true;
  };
  return {
    async request(req: ProposalSubmission, meta: BrokerMeta, assertBinding?: () => void): Promise<ProposalDecision> {
      assertBinding?.();
      const p = await rt.gate.submit(req, { profileId: meta.profileId, sessionId: meta.sessionId, actor: rt.subject?.userId ?? 'agent', taskId: meta.taskId });
      if (!ownerActive(meta, assertBinding)) throw new Error(`session ${meta.sessionId} proposal owner is no longer active`);
      getWindow()?.webContents.send('sparkii:event:approval', p);
      return new Promise<ProposalDecision>((resolve) => {
        const timer = setTimeout(() => {
          if (!ownerActive(meta, assertBinding)) {
            resolvers.delete(p.id);
            resolve({ approved: false, proposalId: p.id, status: 'denied' });
            return;
          }
          // 只把「仍处于 pending、用户一直没处理」的提案判为超时拒绝。
          // 提案一旦已被批准并进入执行（status 已离开 pending），超时回调绝不能
          // 抢先回「未执行」——否则长命令（docker compose pull / git clone 等）
          // 会在真实下载进行中收到 {approved:false, status:'approved'}，
          // 子进程据此打印「操作未执行:approved」。此时应继续等 decideApproval
          // 执行完毕由 broker.decide 回真实结果。
          void rt.gate.expire(p.id).then((expired) => {
            if (!ownerActive(meta, assertBinding)) {
              resolvers.delete(p.id);
              resolve({ approved: false, proposalId: p.id, status: 'denied' });
              return;
            }
            if (!expired) {
              resolvers.delete(p.id);
              resolve({ approved: false, proposalId: p.id, status: 'expired' });
              return;
            }
            if (expired.status === 'expired') {
              getWindow()?.webContents.send('sparkii:event:approval', expired);
              resolvers.delete(p.id);
              resolve({ approved: false, proposalId: p.id, status: 'expired' });
              return;
            }
            // approved/executed（长命令执行中）或仍未到期：不推、不 resolve，
            // 等 decideApproval 完成由 broker.decide 回真实结果。
          });
        }, rt.profileOf(meta.profileId).profile.security.approval.timeoutMs);
        resolvers.set(p.id, { resolve, timer, meta, assertBinding });
      });
    },
    route(req: ProposalSubmission, meta: BrokerMeta, assertBinding?: () => void): Promise<ProposalDecision> {
      assertBinding?.();
      if (['bash', 'edit', 'write', 'delete', 'move'].includes(req.toolName)) {
        void rt.audit?.append({
          actor: rt.subject?.userId ?? 'agent',
          action: 'execution.blocked',
          resource: req.toolName,
          payloadSummary: 'runtime action protocol required',
          sessionId: meta.sessionId,
        });
        return Promise.resolve({
          approved: false,
          proposalId: req.requestId,
          status: 'denied',
        });
      }
      return this.request(req, meta, assertBinding);
    },
    ownerTaskId(id: string): string | undefined {
      return resolvers.get(id)?.meta.taskId ?? rt.gate.get?.(id)?.taskId;
    },
    assertOwner(id: string): void {
      const entry = resolvers.get(id);
      if (entry) {
        if (ownerActive(entry.meta, entry.assertBinding)) return;
      } else {
        const proposal = rt.gate.get?.(id);
        const taskId = proposal?.taskId;
        const lifecycle = rt.security?.taskLifecycle;
        if (proposal && taskId) {
          if (lifecycle && typeof lifecycle.owner === 'function') {
            if (lifecycle.owner(proposal.sessionId)?.taskId === taskId) return;
          } else if (lifecycle?.active(proposal.sessionId)?.taskId === taskId) return;
        }
      }
      throw new Error(`approval ${id} owner is no longer active`);
    },
    decide(id: string, decision: Omit<ProposalDecision, 'proposalId'>) {
      if (decision.approved && typeof rt.gate.get === 'function') {
        const proposal = rt.gate.get(id);
        if (!proposal || proposal.privacyRedacted || (proposal.status !== 'approved' && proposal.status !== 'executed')) {
          settle(id, { approved: false, status: 'denied' });
          return;
        }
      }
      settle(id, decision);
    },
    async cancelSession(sessionId: string, reason: string): Promise<void> {
      const cancelled = typeof rt.gate.cancelSession === 'function'
        ? await rt.gate.cancelSession(sessionId, reason)
        : [];
      for (const proposal of cancelled) {
        getWindow()?.webContents.send('sparkii:event:approval', proposal);
      }
      for (const [id, entry] of [...resolvers.entries()]) {
        if (entry.meta.sessionId !== sessionId) continue;
        clearTimeout(entry.timer);
        entry.resolve({ approved: false, proposalId: id, status: 'denied' });
        resolvers.delete(id);
      }
    },
    async cancelTask(taskId: string, reason: string): Promise<void> {
      const cancelled = await rt.gate.cancelTask(taskId, reason);
      for (const proposal of cancelled) {
        getWindow()?.webContents.send('sparkii:event:approval', proposal);
      }
      for (const [id, entry] of [...resolvers.entries()]) {
        if (entry.meta.taskId !== taskId) continue;
        clearTimeout(entry.timer);
        entry.resolve({ approved: false, proposalId: id, status: 'denied' });
        resolvers.delete(id);
      }
    },
  };
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
  assertBinding?: () => void,
): Promise<void> {
  if (!level) return;
  assertBinding?.();
  const resp = await client.send({ type: 'set_thinking_level', level });
  assertBinding?.();
  if (!resp.success) throw new Error(`cannot set thinking level ${level}: ${resp.error ?? 'unknown'}`);
}

export async function selectModel(
  rt: Runtime,
  task: ModelTask,
  sessionId: string,
  override?: string | null,
  assertBinding?: () => void,
): Promise<{ provider: string; modelId: string } | null> {
  assertBinding?.();
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  const settings = await loadSettings(rt.dataDir);
  assertBinding?.();
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
  assertBinding?.();
  if (apiKey) {
    assertBinding?.();
    const keyResp = await client.send({ type: 'set_api_key', provider, apiKey });
    assertBinding?.();
    if (!keyResp.success) throw new Error(`cannot set api key for ${provider}: ${keyResp.error ?? 'unknown'}`);
  }
  assertBinding?.();
  const resp = await client.send({ type: 'set_model', provider, modelId });
  assertBinding?.();
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

async function sendPrompt(
  rt: Runtime,
  text: string,
  task: ModelTask,
  sessionId: string,
  assertOriginalBinding?: () => void,
  onPromptSend?: () => void,
  expectedAdmission?: TaskAdmissionToken,
): Promise<string> {
  assertOriginalBinding?.();
  const binding = rt.pool.getBinding(sessionId);
  if (!binding) throw new Error(`unknown session ${sessionId}`);
  const client = binding.client;
  const lease = binding.lease;
  const assertBinding = (): void => {
    assertOriginalBinding?.();
    const current = rt.pool.getBinding(sessionId);
    if (rt.pool.get(sessionId) !== client || current?.client !== client || current.lease !== lease) {
      throw new Error(`session ${sessionId} is no longer bound`);
    }
  };
  const rec = rt.chatSessions?.get?.(sessionId);
  const target = await selectModel(rt, task, sessionId, rec?.model, assertBinding);
  assertBinding();
  if (target) {
    const settings = await loadSettings(rt.dataDir);
    assertBinding();
    await applyThinkingLevel(client, resolveThinkingLevel(settings, rec, target), assertBinding);
  }
  assertBinding();

  let acc = '';
  let off = () => {};
  let settled = false;
  let terminalError: Error | undefined;
  let finish!: (err?: Error) => void;
  let timer!: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((resolve) => {
    finish = (err) => {
      if (err) terminalError ??= err;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve();
    };
    timer = setTimeout(() => finish(new Error('prompt timeout')), 300_000);
  });
  assertBinding();
  let promptId: string | undefined;
  let pendingErrorPromptId: string | undefined;
  let pendingError: Error | undefined;
  const applyPendingError = (): void => {
    if (promptId && pendingErrorPromptId === promptId && pendingError) finish(pendingError);
  };
  off = client.onEvent((e) => {
    try {
      assertBinding();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if ((e.type === 'message_update' || e.type === 'message_end') && e.message) {
      acc = assistantTextFromMessage(e.message);
    }
    // Pi 在有界重试前也会派发 agent_end（带 willRetry:true），只有非重试的 agent_end 才是本轮终态。
    if (e.type === 'agent_settled' || (e.type === 'agent_end' && e.willRetry !== true)) finish();
    if (e.type === 'prompt_error') {
      const error = new Error(String(e.error ?? 'prompt failed'));
      if (!promptId) {
        pendingErrorPromptId = typeof e.promptId === 'string' ? e.promptId : undefined;
        pendingError = error;
      } else if (e.promptId === promptId) {
        finish(error);
      }
    }
  });

  try {
    assertBinding();
    if (!rt.promptTurn) throw new Error('Main prompt-turn lane is unavailable');
    const turnResult = await rt.promptTurn({
      sessionId,
      text,
      expectedAdmission,
      retainTask: true,
      onPromptSend,
      onPromptId: (id: string) => {
        promptId = id;
        applyPendingError();
      },
      waitForSettled: true,
    }) as { promptId?: string } | undefined;
    if (!promptId) promptId = turnResult?.promptId;
    applyPendingError();
    assertBinding();
    finish();
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
  }

  await done;
  // An event can settle before send() completes. Keep a later binding failure
  // fatal instead of letting the already-resolved done promise hide it.
  if (terminalError) throw terminalError;
  assertBinding();
  return acc;
}

export async function runTool(
  rt: Runtime,
  broker: ReturnType<typeof createBroker>,
  toolName: string,
  args: unknown,
  sessionId: string,
  profileId: string,
  assertBinding?: () => void,
  owner?: { taskId?: string; admission?: TaskAdmissionToken },
) {
  assertBinding?.();
  const tool = allTools.get(toolName);
  if (!tool) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: toolName } };
  if (tool.sideEffect === 'read') {
    if (toolName === 'document.read') {
      const displayName = rt.profileOf(profileId)?.profile?.manifest?.displayName ?? profileId;
      const result = await executeDocumentRead(args as Record<string, unknown>, {
        profileId,
        sessionId,
        actor: rt.subject?.userId ?? 'agent',
        agentDisplayName: displayName,
      });
      assertBinding?.();
      return result;
    }
    if (toolName === 'knowledge.search') {
      const knowledge = knowledgeFromManifest(rt.profileOf(profileId).profile.manifest);
      // 两个远端后端都走 Main；`bm25`（本地语料）沿用下面的 tool.handler 兜底。
      if (knowledge.backend !== 'bm25') {
        const backend = remoteKnowledgeBackend(knowledge.backend);
        const rag = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
        assertBinding?.();
        const apiKey = await rt.knowledgeToken(backend);
        assertBinding?.();
        const result = await runMainKnowledgeSearch({
          args: (args ?? {}) as Record<string, unknown>,
          profileId,
          sessionId,
          backend: knowledge.backend,
          selection: null,
          knowledge,
          rag,
          apiKey,
          bm25: async () => { throw new Error('no bm25'); },
          persistDefault: async (id) => {
            assertBinding?.();
            const current = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
            assertBinding?.();
            const next = current.bindings.filter((b) => b.agentId !== profileId);
            next.push({ agentId: profileId, defaultDatasetId: id });
            await patchKnowledgeSettings(rt.dataDir, backend, { bindings: next });
            assertBinding?.();
          },
        });
        assertBinding?.();
        return result;
      }
    }
    if (toolName.startsWith('ontology.')) {
      const settings = await loadSettings(rt.dataDir);
      assertBinding?.();
      const credential = await rt.knowledgeToken('sparkiionto');
      assertBinding?.();
      const result = await executeOntologyTool({
        toolName,
        args: (args ?? {}) as Record<string, unknown>,
        profileId,
        settings,
        credential,
      });
      assertBinding?.();
      return result;
    }
    const result = await tool.handler(args as Record<string, unknown>, {
      profileId: rt.profileOf(profileId).profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', requestId: randomUUID(),
    });
    assertBinding?.();
    return result;
  }
  const routeOwner = owner ?? rt.security?.taskLifecycle.owner?.(sessionId);
  const d = await broker.route(connectorWriteProposal(toolName, args, {
    requestId: randomUUID(),
    risk: tool.sideEffect,
  }), {
    sessionId,
    profileId,
    taskId: routeOwner?.taskId,
    admission: routeOwner?.admission,
  }, assertBinding);
  assertBinding?.();
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
  onReady?: (
    sessionId: string,
    slot: Awaited<ReturnType<Runtime['pool']['acquire']>>,
    bindingLease: number,
  ) => TaskAdmissionToken | undefined | void | Promise<TaskAdmissionToken | undefined | void>;
  beforeRelease?: (
    sessionId: string,
    bindingLease: number,
    admission?: TaskAdmissionToken,
  ) => boolean | void | Promise<boolean | void>;
  logger?: Pick<Logger, 'log'>;
}

export async function runWorkflow(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
  profileId: string,
  opts: WorkflowRunHooks | undefined,
  documentsDir: string,
): Promise<string> {
  const pr = rt.profileOf(profileId);
  const agent = rt.agentOf(profileId);
  const rawDef = pr.profile.agent.workflow as unknown as WorkflowDef;
  const runtimeAgent = { ...agent, tools: workflowRuntimeTools(agent.tools, rawDef) };
  const requested = typeof input.workspacePath === 'string' && input.workspacePath.trim()
    ? input.workspacePath
    : undefined;
  const workspacePath = requested ?? allocateAutoWorkspace(documentsDir, profileId).workspacePath;
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
    meta: profilePoolMeta(rt, profileId),
  });

  const binding = rt.pool.getBinding(tempKey);
  if (!binding) {
    await rt.pool.release(tempKey);
    throw new Error(`unknown session ${tempKey}`);
  }
  const bindingLease = binding.lease;
  const ownsBinding = (sessionId: string): boolean => {
    const current = rt.pool.getBinding(sessionId);
    return rt.pool.get(sessionId) === slot.client
      && current?.lease === bindingLease;
  };
  const assertBinding = (sessionId: string): void => {
    if (!ownsBinding(sessionId)) throw new Error(`session ${sessionId} is no longer bound`);
  };
  const workflowOwnsAdmission = (): boolean => {
    if (!sessionId || !ownsBinding(sessionId)) return false;
    const current = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    return workflowAdmission ? current === workflowAdmission : current === undefined;
  };
  const admissionSafeAfterCleanup = (): boolean => {
    if (!sessionId || !ownsBinding(sessionId)) return false;
    const current = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    return workflowAdmission
      ? current === workflowAdmission || current === undefined
      : current === undefined;
  };
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let workflowAdmission: TaskAdmissionToken | undefined;
  let workflowTaskId: string | undefined;
  try {
    assertBinding(tempKey);
    const freshResp = await slot.client.send({ type: 'new_session' });
    assertBinding(tempKey);
    if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
    const stateResp = await slot.client.send({ type: 'get_state' });
    assertBinding(tempKey);
    if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
    sessionId = (stateResp.data as { sessionId?: string } | undefined)?.sessionId;
    sessionFile = (stateResp.data as { sessionFile?: string } | undefined)?.sessionFile;
    if (!sessionId) throw new Error('runtime did not provide a session id');
    rt.pool.renameSession(tempKey, sessionId);
    assertBinding(sessionId);

    const inputFiles = Array.isArray(input?.documents) ? JSON.stringify(input.documents) : null;
    rt.chatSessions?.create?.({
      id: sessionId,
      profileId,
      kind: 'workflow',
      currentStep: null,
      workspaceKind: input.workspaceKind === 'user' ? 'user' : 'auto',
      workspacePath,
      model: sessionModel ?? (target ? modelTargetKey(target) : null),
      thinkingLevel: sessionThinking ?? thinkingLevel,
      inputs: inputFiles,
      piSessionFile: sessionFile ?? null,
    });
    slot.supervisor.onProposal(async (req, context) => {
      assertBinding(sessionId!);
      const owner = rt.resolveRuntimeOrigin?.(sessionId!, context?.originToken, slot.client, bindingLease);
      if (!owner) throw new Error(`session ${sessionId} workflow proposal origin is not executable`);
      const taskId = owner.taskId;
      const admission = owner.admission;
      const assertOwner = (): void => {
        assertBinding(sessionId!);
        if (opts?.onReady && (!taskId || !admission)) {
          throw new Error(`session ${sessionId} workflow task admission is not ready`);
        }
        if (taskId && admission && rt.security?.taskLifecycle.assertOwner) {
          try {
            rt.security.taskLifecycle.assertOwner(sessionId!, { taskId, admission });
          } catch {
            throw new Error(`session ${sessionId} proposal owner is no longer active`);
          }
        } else {
          if (taskId && rt.security?.taskLifecycle.active(sessionId!)?.taskId !== taskId) {
            throw new Error(`session ${sessionId} proposal task is no longer active`);
          }
          if (admission && rt.security?.taskLifecycle.currentAdmission?.(sessionId!) !== admission) {
            throw new Error(`session ${sessionId} proposal admission is no longer current`);
          }
        }
      };
      const decision = await broker.route(req, { sessionId: sessionId!, profileId, taskId, admission }, assertOwner);
      assertOwner();
      return decision;
    });
    workflowAdmission = (await opts?.onReady?.(sessionId, slot, bindingLease)) ?? undefined;
    assertBinding(sessionId);
    if (workflowAdmission) rt.security?.taskLifecycle.assertCurrentAdmission?.(sessionId, workflowAdmission);
  } catch (err) {
    let mayRelease = sessionId ? workflowOwnsAdmission() : ownsBinding(tempKey);
    if (sessionId && mayRelease) {
      const released = await opts?.beforeRelease?.(sessionId, bindingLease, workflowAdmission);
      mayRelease = released !== false && admissionSafeAfterCleanup();
    }
    if (!mayRelease) throw err;
    await rt.pool.release(sessionId ?? tempKey, bindingLease);
    throw err;
  }

  const readySessionId = sessionId;
  workflowTaskId = rt.security?.taskLifecycle.active(readySessionId)?.taskId;
  assertBinding(readySessionId);
  void runWorkflowLoop(rt, getWindow, slot, broker, pr, readySessionId, profileId, input, opts, bindingLease, workflowAdmission, workflowTaskId).catch((error) => {
    if (!ownsBinding(readySessionId)) return;
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
  bindingLease: number,
  logger?: Pick<Logger, 'log'>,
  admission?: TaskAdmissionToken,
) {
  const ownsBinding = (): boolean => {
    const current = rt.pool.getBinding(sessionId);
    return rt.pool.get(sessionId) === slot.client
      && current?.lease === bindingLease
      && (!admission || rt.security?.taskLifecycle.currentAdmission?.(sessionId) === admission);
  };
  const append = async (customType: string, data: Record<string, unknown>): Promise<void> => {
    if (!ownsBinding()) throw new Error(`session ${sessionId} is no longer bound`);
    const resp = await slot.client?.send?.({ type: 'append_workflow_entry', customType, data });
    if (!ownsBinding()) throw new Error(`session ${sessionId} is no longer bound`);
    if (!resp?.success) throw new Error(resp?.error ?? 'append_workflow_entry failed');
    void logger?.log({
      level: 'debug',
      msg: 'workflow entry appended',
      ctx: { sessionId, stepId: String(data.stepId ?? ''), customType },
    });
  };

  const report = (customType: string, data: Record<string, unknown>, error: unknown): void => {
    if (!ownsBinding()) return;
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
            if (ownsBinding()) {
              void logger?.log({
                level: 'error',
                msg: 'workflow failed-end append also failed',
                ctx: { sessionId, stepId: String(data.stepId ?? '') },
              });
            }
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
  hooks: WorkflowRunHooks | undefined,
  bindingLease: number,
  workflowAdmission?: TaskAdmissionToken,
  workflowTaskId?: string,
): Promise<void> {
  const ownsBinding = (): boolean => {
    const current = rt.pool.getBinding(sessionId);
    return rt.pool.get(sessionId) === slot.client
      && current?.lease === bindingLease;
  };
  const assertBinding = (): void => {
    if (!ownsBinding()) throw new Error(`session ${sessionId} is no longer bound`);
    if (workflowAdmission) rt.security?.taskLifecycle.assertCurrentAdmission?.(sessionId, workflowAdmission);
  };
  const ownsWorkflow = (): boolean => ownsBinding()
    && (!workflowAdmission || rt.security?.taskLifecycle.currentAdmission?.(sessionId) === workflowAdmission);
  const journal = createStepJournal(rt, getWindow, slot, pr, sessionId, bindingLease, hooks?.logger, workflowAdmission);
  let promptSent = false;
  try {
    const rawDef = pr.profile.agent.workflow as unknown as WorkflowDef;
    const def = resolveWorkflowTemplates(rawDef);
    const ctx: RunContext = {
      profileId: pr.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', input,
      sendPrompt: (text, task) => sendPrompt(
        rt, text, (task as ModelTask) ?? 'default', sessionId, assertBinding,
        () => { promptSent = true; },
        workflowAdmission,
      ),
      runTool: (name, args) => runTool(rt, broker, name, args, sessionId, profileId, assertBinding, {
        taskId: workflowTaskId,
        admission: workflowAdmission,
      }),
      requestApproval: async (req) => {
        assertBinding();
        const d = await broker.route({ ...req, requestId: randomUUID() }, {
          sessionId,
          profileId,
          taskId: workflowTaskId,
          admission: workflowAdmission,
        }, assertBinding);
        assertBinding();
        return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
      },
    };
    for await (const e of new LinearRunner().run(def, ctx)) {
      if (!ownsWorkflow()) break;
      if (e.type === 'step_started') {
        if (!ownsWorkflow()) break;
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
    const currentAdmission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    const ownsAdmission = workflowAdmission
      ? currentAdmission === workflowAdmission
      : currentAdmission === undefined;
    if (!ownsAdmission) return;
    if (!ownsBinding()) {
      if (promptSent) await rt.pool.release(sessionId, bindingLease);
      return;
    }
    const released = await hooks?.beforeRelease?.(sessionId, bindingLease, workflowAdmission);
    const afterAdmission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    if (released === false || !ownsBinding()) return;
    if (workflowAdmission
      ? afterAdmission !== workflowAdmission && afterAdmission !== undefined
      : afterAdmission !== undefined) return;
    await rt.pool.release(sessionId, bindingLease);
  }
}
