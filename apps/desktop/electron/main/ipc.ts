import { ipcMain, dialog, app, shell, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { listPiSessions, readPiSessionEntries, connectorWriteProposal, type PiProviderInfo, type SessionSaddle, type ConnectorReadRequest, type ConnectorReadResult, type PiRuntimeRequestContext } from '@sparkii/agent-host';
import { knowledgeConnector, sparkiiOntoConnector, SparkiiRagClient } from '@sparkii/connectors';
import { applyThinkingLevel, createBroker, modelTargetKey, resolveModelTarget, resolveSessionModel, resolveThinkingLevel, runWorkflow, selectModel } from './workflow.js';
import { documentReadAuditSummary, executeDocumentRead } from './document-read.js';
import { executeOntologyTool, ontologyAuditSummary } from './ontology-tools.js';
import { getDocumentParseSupervisor } from './document-parse-supervisor.js';
import { findCompatibleModels, type ModelCapability } from '@sparkii/model-router';
import { sortAgents } from './agent-catalog.js';
import { resolveExportPath } from './export-path.js';
import { loadSettings, saveSettings } from './settings.js';
import { getUpdateService, hasUpdateService } from './update/service.js';
import { isSafeVersionSegment } from './update/dirs.js';
import type { UpdateActionResult, UpdateSettingsPatch, UpdateSettingsPublic, UpdateState } from '../preload/api-types.js';
import { knowledgeFromManifest, patchRagSettings, ragFromSettings, type KnowledgeSelection } from './rag-settings.js';
import {
  checkKnowledgeBaseUrl,
  isKnowledgeBackendId,
  knowledgeBackendSettings,
  patchKnowledgeSettings,
  remoteKnowledgeBackend,
  type KnowledgeBackendId,
  type KnowledgeSettingsPartial,
} from './knowledge-settings.js';
import {
  invalidBackendProbeResult,
  probeKnowledgeBackend,
  type KnowledgeProbeOverride,
  type KnowledgeProbeResult,
} from './knowledge-probe.js';
import { documentParseFromSettings, saveDocumentParseSettings } from './document-parse-settings.js';
import {
  DOWNLOAD_UNREACHABLE,
  downloadDocumentParseModule,
  importDocumentParseModule,
  listDocumentParseModules,
} from './document-parse-modules.js';
import { profilePoolMeta } from './pool-meta.js';
import { knowledgeClientFor, runMainKnowledgeSearch, searchAuditSummary, SESSION_DATASET_GONE } from './rag-search.js';
import { fetchAndCacheDocument } from './rag-open.js';
import {
  KNOWLEDGE_TURN,
  knowledgeTurnPayload,
  markSearchResult,
  resetTurn,
  sealTurn,
  shouldAbortGeneration,
  type GroundingTurn,
} from './rag-grounding.js';
import { buildProviderList, findReservedProviderConflict, isReservedKnowledgeProviderId } from './provider-catalog.js';
import { allocateAutoWorkspace, assertAgentId, ensureWorkspaceDir } from './workspace.js';
import { relocateWorkspace, type RelocateResult } from './workspace-relocation.js';
import { buildAgentSaddle } from './saddle.js';
import { ExtractionScheduler, IdleConsolidator, handleMemoryToolAction } from './memory/index.js';
import { buildAttachmentPrompt, stageAttachments } from './attachments.js';
import { resizeImageForAttachment } from './image-resize.js';
import { writePiModelsConfig } from './pi-model-config.js';
import { probeProviderModels } from './provider-probe.js';
import { verifyRuntime } from './runtime-provision.js';
import { mutateQueues, type QueueMutation, type QueueSnapshot } from './queue-mutation.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';
import type { ChatAttachment, ChooseDocumentOptions } from '../preload/api-types.js';
import { DEFAULT_CHOOSE_EXTENSIONS, grantDocumentPath, readGrantedDocumentBytes } from './document-bytes.js';
import {
  importUserSkill,
  listUserSkills,
  previewUserSkill,
  uninstallUserSkill,
} from './skill-library.js';
import type { AgentRuntime } from './agent-registry.js';
import {
  hashPayload,
  resolvePermissionMode,
  type PlatformPermissionMode,
  type Proposal,
  type SecurityAction,
  type TaskGrant,
} from '@sparkii/approval';
import { createTaskGrant } from './security/task-grant-factory.js';
import type { TaskAdmissionToken, TaskOwner } from './security/task-lifecycle.js';
import { createWorkspaceFileService, type WorkspaceFileOp } from './security/workspace-file-service.js';
import { createRenderDiagramService } from './security/render-diagram-service.js';
import { createElectronSvgRenderer } from './security/electron-svg-renderer.js';
import { compileDocx } from './security/docx-compile-service.js';
import { createRuntimeActionRouter } from './security/runtime-action-router.js';
import { authorizeDocumentReadPaths } from './security/document-access.js';
import { ShellGrantStore } from './security/shell-grant-store.js';
import { resolveSessionPermissionMode } from './security/session-permission-mode.js';
import { REVIEWER_USER_TASK_LIMIT } from './security/reviewer-policy.js';

/** 按后端探活：读该后端自己的配置块与凭据，再交给 `knowledge-probe`。 */
async function probeKnowledgeConnection(
  rt: Runtime,
  backend: KnowledgeBackendId,
  override?: KnowledgeProbeOverride,
): Promise<KnowledgeProbeResult> {
  const settings = await loadSettings(rt.dataDir);
  return probeKnowledgeBackend(backend, {
    baseUrl: knowledgeBackendSettings(backend, settings).baseUrl,
    credential: await rt.knowledgeToken(backend),
    override,
  });
}

/** 旧 IPC 的薄封装（renderer 兼容）：只改实现，不改返回形状与文案。 */
async function probeRag(
  rt: Runtime,
  apiKeyOverride?: string | null,
): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }> {
  const result = await probeKnowledgeConnection(
    rt,
    'sparkiirag',
    apiKeyOverride ? { apiKey: apiKeyOverride } : undefined,
  );
  return result.ok
    ? { ok: true, datasets: result.datasets ?? [] }
    : { ok: false, error: result.error?.message ?? '连接失败' };
}

function parseSessionInputs(raw: string | null | undefined): { path: string; name?: string; missing?: boolean }[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return undefined;
    return arr.map((item) => {
      if (typeof item === 'string') return { path: item };
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        path: String(rec.path ?? ''),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
        missing: !existsSync(String(rec.path ?? '')),
      };
    });
  } catch {
    return undefined;
  }
}

function assistantText(message: unknown): string {
  const rec = (message ?? {}) as Record<string, unknown>;
  const content = rec.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = (block ?? {}) as Record<string, unknown>;
        return b.type === 'text' ? String(b.text ?? '') : '';
      })
      .join('');
  }
  return typeof rec.text === 'string' ? rec.text : '';
}

function lastAssistantOfBranch(entries: unknown[]): unknown | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = (entries[i] ?? {}) as Record<string, unknown>;
    if (String(entry.type) !== 'message') continue;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    if (message.role === 'assistant') return message;
  }
  return null;
}

function lastAssistantOfMessages(messages: unknown[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = (messages[i] ?? {}) as Record<string, unknown>;
    if (message.role === 'assistant') return message;
  }
  return null;
}

/**
 * `message_end` 先清空 `streamingMessage`，之后才 `appendMessage`。夹在中间打开会两边都没有
 * 这一句，此时它只在 `get_messages` 里。仅在这条微缝上补一次，不把 `get_messages` 当时间线。
 */
async function recoverInFlightAssistant(
  client: { send: (command: { type: 'get_messages' }) => Promise<{ success: boolean; data?: unknown }> },
  branch: unknown[],
): Promise<unknown | null> {
  const resp = await client.send({ type: 'get_messages' });
  if (!resp.success) return null;
  const candidate = lastAssistantOfMessages(Array.isArray(resp.data) ? resp.data : []);
  if (!candidate) return null;
  const committed = lastAssistantOfBranch(branch);
  if (committed && assistantText(committed) === assistantText(candidate)) return null;
  return candidate;
}

function approvedProposalForExecution(
  rt: Runtime,
  id: string,
  expected: Proposal,
): Proposal | undefined {
  const current = rt.gate.get(id);
  if (
    !current
    || current.status !== 'approved'
    || current.privacyRedacted
    || current.id !== expected.id
    || current.requestId !== expected.requestId
    || current.profileId !== expected.profileId
    || current.sessionId !== expected.sessionId
    || current.toolName !== expected.toolName
    || current.targetSystem !== expected.targetSystem
    || current.executionMode !== expected.executionMode
    || current.risk !== expected.risk
    || current.createdAt !== expected.createdAt
    || current.payloadHash !== expected.payloadHash
    || current.payloadHash !== hashPayload(current.payload)
  ) return undefined;
  return current;
}

function proposalMatchesConnectorAction(proposal: Proposal, action: SecurityAction): boolean {
  return proposal.id === action.id
    && action.capability === 'connector.invoke'
    && proposal.decisionBy === action.subjectId
    && proposal.sessionId === action.sessionId
    && proposal.profileId === action.profileId
    && proposal.toolName === action.toolName
    && proposal.risk === action.risk
    && proposal.payloadHash === action.payloadHash
    && proposal.payloadHash === hashPayload(proposal.payload)
    && proposal.executionMode !== 'caller';
}

function proposalMatchesAction(proposal: Proposal, action: SecurityAction): boolean {
  return proposal.requestId === action.id
    && proposal.decisionBy === action.subjectId
    && proposal.sessionId === action.sessionId
    && proposal.profileId === action.profileId
    && proposal.toolName === action.toolName
    && proposal.targetSystem === `platform:${action.capability}`
    && proposal.risk === action.risk
    && proposal.payloadHash === action.payloadHash
    && proposal.payloadHash === hashPayload(proposal.payload)
    && proposal.executionMode === 'caller';
}

function canonicalActionForApproval(action: SecurityAction, proposal: Proposal): SecurityAction {
  return {
    ...action,
    id: proposal.requestId,
    subjectId: proposal.decisionBy ?? action.subjectId,
    sessionId: proposal.sessionId,
    profileId: proposal.profileId,
    toolName: proposal.toolName,
    payload: proposal.payload,
    payloadHash: proposal.payloadHash,
    risk: proposal.risk,
    reason: proposal.summary,
  };
}

function userLibraryAgent(rt: Runtime): AgentRuntime | null {
  return [...rt.agents.values()]
    .filter((agent) => agent.manifest.skillLibrary === 'user')
    .sort((a, b) => (a.manifest.sortOrder ?? 0) - (b.manifest.sortOrder ?? 0))[0] ?? null;
}

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  rt.memory?.setEmitter((type, payload) => {
    getWindow()?.webContents.send('sparkii:event:memory-event', { type, ...payload });
  });
  /**
   * 提炼与整合共用的模型目标与内部槽位：模型走用户已配置的大模型（同路由/同 key），
   * 槽位自借 idle 的，拿不到就顺延——绝不挤占交互队列。
   */
  const memoryTarget = async () => {
    const settings = await loadSettings(rt.dataDir);
    return resolveModelTarget(settings, 'memory') ?? resolveModelTarget(settings, 'default');
  };
  const acquireMemorySlot = async (
    target: { provider: string; modelId: string },
    label = '内部记忆整理',
  ) => {
    const key = `memory:${randomUUID()}`;
    const slot = await rt.pool.acquireIfIdle(key, {
      meta: { profileId: 'internal', profileName: label, label, internal: true },
    });
    if (!slot) return null;
    await injectProbeKey(slot.client, target.provider);
    return {
      release: async () => { await rt.pool.release(key); },
      complete: async (text: string, modelTarget: { provider: string; modelId: string }) => {
        const resp = await slot.client.send({
          type: 'complete',
          provider: modelTarget.provider,
          modelId: modelTarget.modelId,
          text,
        });
        if (!resp.success) throw new Error(resp.error ?? 'memory complete failed');
        return String(resp.data ?? '').trim();
      },
    };
  };
  const memoryExtraction = rt.memory ? new ExtractionScheduler({
    service: rt.memory,
    errors: rt.errors,
    logger,
    contextOf: (sessionId) => {
      const rec = rt.chatSessions.get(sessionId);
      if (!rec) return null;
      return {
        sessionId,
        profileId: rec.profileId,
        workspacePath: rec.workspacePath ?? undefined,
        workspaceKind: rec.workspaceKind === 'user' ? 'user' : 'auto',
        piSessionFile: rec.piSessionFile ?? undefined,
      };
    },
    target: memoryTarget,
    acquireInternalSlot: (target) => acquireMemorySlot(target),
    complete: async () => { throw new Error('memory extraction requires an internal slot'); },
  }) : null;
  /** 空闲整合：与提炼同一个内部槽位入口，同样绝不排队。 */
  const memoryConsolidation = rt.memory ? new IdleConsolidator({
    service: rt.memory,
    errors: rt.errors,
    logger,
    isBusy: () => rt.pool.snapshot().slots.some((slot) => slot.status === 'streaming'),
    target: memoryTarget,
    acquireInternalSlot: (target) => acquireMemorySlot(target, '内部记忆整合'),
    complete: async () => { throw new Error('memory consolidation requires an internal slot'); },
  }) : null;
  if (memoryConsolidation) {
    memoryConsolidation.start();
    app.once('will-quit', () => memoryConsolidation.stop());
  }
  const shellGrants = rt.security?.shellGrants ?? new ShellGrantStore();
  const transientPromptCancels = new Map<string, Array<{ lease: number; admission?: TaskAdmissionToken; cancel: () => void }>>();
  /** The prompt text of the live Task, trimmed, for the Reviewer only. */
  const userTaskBySession = new Map<string, string>();
  /** Only "can the platform still review?" and the last verdict leave Main. */
  let reviewerUnavailable = false;
  const lastReviewBySession = new Map<string, {
    decision: 'allow' | 'ask' | 'deny';
    risk: string;
    reason: string;
  }>();
  const actionRouter = rt.security
    ? createRuntimeActionRouter({
      lifecycle: rt.security.taskLifecycle,
      normalizer: rt.security.actionNormalizer,
      shellGrants,
      allowShellExecution: rt.security.hostShellReport.status === 'available',
      reviewerModel: rt.security.reviewerModel,
      reviewerPolicyVersion: rt.security.reviewerPolicyVersion,
      userTaskOf: (sessionId) => userTaskBySession.get(sessionId) ?? '',
      async reviewShell(input) {
        const reviewer = rt.security?.reviewer;
        if (!reviewer) throw new Error('Reviewer unavailable');
        try {
          const reviewed = await reviewer.review(input);
          reviewerUnavailable = false;
          lastReviewBySession.set(input.sessionId, {
            decision: reviewed.decision,
            risk: reviewed.risk,
            reason: reviewed.reason,
          });
          getWindow()?.webContents.send('sparkii:event:permission-event', {
            sessionId: input.sessionId,
            taskId: input.taskId,
            decision: reviewed.decision,
            risk: reviewed.risk,
            reason: reviewed.reason,
          });
          return reviewed;
        } catch (error) {
          reviewerUnavailable = true;
          void logger.log({
            level: 'warn',
            msg: 'reviewer.availability.changed',
            ctx: {
              available: false,
              sessionId: input.sessionId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        }
      },
      profilePolicyOf: (profileId) =>
        rt.security?.profilePolicies.get(profileId)
        ?? {
          // Unknown profiles fail closed: Ask only, everything needs approval.
          defaultPermissionMode: 'ask',
          allowedPermissionModes: ['ask'],
          requireApproval: [
            'fs.read',
            'fs.write',
            'process.exec',
            'net.connect',
            'connector.invoke',
            'task.delegate',
          ],
        },
      platformReady: (action) =>
        Boolean(
          rt.security
          && rt.security.profilePolicies.has(action.profileId)
          && rt.security.platformReadyFor(action),
        ),
      async execute(action, grant) {
        if (!rt.security) throw new Error('platform security unavailable');
        if (action.capability === 'fs.write') {
          return {
            result: await rt.security.workspaceExecutor.execute(action, grant),
          };
        }
        if (action.capability === 'fs.read') {
          const target = action.resources.find((resource) => resource.kind === 'path');
          return {
            result: {
              authorized: true,
              canonicalPath: target?.value,
            },
          };
        }
        if (action.capability === 'process.exec') {
          const payload = (action.payload ?? {}) as { command?: unknown; timeout?: unknown };
          const command = String(payload.command ?? '');
          if (!command.trim()) {
            throw new Error('empty shell command');
          }
          await rt.security.workspaceExecutor.ensureWorkspace(grant);
          const requested = Number(payload.timeout ?? 60_000);
          const timeoutMs = Number.isFinite(requested)
            ? Math.max(1_000, Math.min(300_000, Math.floor(requested)))
            : 60_000;
          const result = await rt.security.hostShell.run({
            taskId: grant.taskId,
            workspaceRoot: grant.workspaceRoot,
            scratchRoot: grant.scratchRoot,
            command,
            timeoutMs,
          });
          return {
            result: {
              exitCode: result.exitCode,
              output: `${result.stdout}${result.stderr}`,
              timedOut: result.timedOut,
              // The host runs the command; Workspace is only the working directory.
              executionBoundary: 'host',
              backend: rt.security.hostShellReport.backend,
              truncated: result.truncated,
            },
          };
        }
        throw new Error(`execution backend unavailable for ${action.capability}`);
      },
      async requestApproval(action, _grant, riskOverride) {
        const decision = await broker.request({
          requestId: action.id,
          toolName: action.toolName,
          targetSystem: `platform:${action.capability}`,
          summary: action.reason,
          preview: {
            kind: 'text',
            lines: action.resources.map((resource) =>
              `${resource.scope}: ${resource.value}`),
          },
          payload: action.payload,
          risk: riskOverride ?? action.risk,
          executionMode: 'caller',
        }, {
          sessionId: action.sessionId,
          profileId: action.profileId,
        });
        if (!decision.approved) return { choice: 'deny' as const };
        const proposal = rt.gate.get(decision.proposalId);
        if (
          !proposal
          || proposal.status !== 'approved'
          || proposal.privacyRedacted
          || !proposalMatchesAction(proposal, action)
        ) {
          return { choice: 'deny' as const };
        }
        return {
          choice: decision.approvalScope === 'task' ? 'task' as const : 'once' as const,
          proposalId: proposal.id,
        };
      },
      validateApproval(action, resolution) {
        if (resolution.choice === 'deny') return null;
        const proposal = rt.gate.get(resolution.proposalId);
        if (
          !proposal
          || proposal.status !== 'approved'
          || proposal.privacyRedacted
          || !proposalMatchesAction(proposal, action)
        ) return null;
        return canonicalActionForApproval(action, proposal);
      },
      async revalidate(action, grant) {
        if (!rt.security) return false;
        try {
          for (const resource of action.resources) {
            if (resource.kind !== 'path') continue;
            const inspected = await rt.security.pathProbe.inspect(resource.value);
            if (resource.identity && inspected.identity !== resource.identity) {
              return false;
            }
            if (resource.parentIdentity) {
              const parent = await rt.security.pathProbe.inspect(
                dirname(inspected.canonicalPath),
              );
              if (parent.identity !== resource.parentIdentity) return false;
            }
          }
          const root = await rt.security.pathProbe.inspect(grant.workspaceRoot);
          const liveTask = rt.security.taskLifecycle.assertActive(
            grant.sessionId,
            grant.taskId,
          );
          const expectedIdentity = rt.security.workspaceExecutor
            .liveWorkspaceIdentity(grant.taskId)
            ?? liveTask.workspaceIdentity;
          return root.identity === expectedIdentity
            || root.exists === false;
        } catch {
          return false;
        }
      },
      audit: rt.audit,
      actor: () => rt.subject?.userId ?? 'agent',
      platformName: process.platform,
      sandboxVersion: rt.security?.hostShellReport.version,
    })
    : null;

  // A Task that ends takes its routing state with it: no shell grant, no
  // evidence, no denial memory. A new Task starts from zero.
  rt.security?.taskGrants.onRevoke((taskId) => {
    shellGrants.revoke(taskId);
    actionRouter?.clearTask(taskId);
  });

  const captureTaskOwner = (sessionId: string): TaskOwner | undefined => {
    const lifecycle = rt.security?.taskLifecycle;
    if (lifecycle && typeof lifecycle.owner === 'function') return lifecycle.owner(sessionId);
    const taskId = lifecycle?.active(sessionId)?.taskId;
    return taskId ? { taskId, admission: lifecycle?.currentAdmission?.(sessionId) } : undefined;
  };
  const assertTaskOwner = (
    sessionId: string,
    expected: TaskOwner | undefined,
    kind: 'action' | 'proposal',
  ): void => {
    const lifecycle = rt.security?.taskLifecycle;
    if (lifecycle && typeof lifecycle.owner === 'function') {
      try {
        lifecycle.assertOwner(sessionId, expected);
      } catch {
        throw new Error(`session ${sessionId} ${kind} owner is no longer active`);
      }
      return;
    }
    if (expected?.taskId && lifecycle?.active(sessionId)?.taskId !== expected.taskId) {
      throw new Error(`session ${sessionId} ${kind} task is no longer active`);
    }
    if (expected?.admission && lifecycle?.currentAdmission?.(sessionId) !== expected.admission) {
      throw new Error(`session ${sessionId} ${kind} admission is no longer current`);
    }
  };

  const bindRuntimeActions = (
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>,
    sessionId: string,
    captured = captureRuntimeBinding(sessionId),
  ): void => {
    if (typeof slot.supervisor.onAction !== 'function') return;
    slot.supervisor.onAction(async (request, context) => {
      assertRuntimeRequest(context, captured);
      const owner = resolveRuntimeOrigin(sessionId, context.originToken, captured.client, captured.lease);
      if (!owner) {
        return {
          requestId: request.requestId,
          status: 'denied' as const,
          decision: { decision: 'deny' as const, ruleId: 'runtime-origin.invalid', reason: 'Runtime request has no current prompt-turn origin' },
          error: { code: 'ORIGIN_REQUIRED', message: 'Runtime request origin is missing, stale, or superseded' },
        };
      }
      const taskId = owner.taskId;
      const admission = owner.admission;
      const assertOwner = (): void => {
        assertRuntimeRequest(context, captured);
        assertTaskOwner(sessionId, owner, 'action');
      };
      // 平台可信分支：记忆工具不进 action-normalizer、不依赖 rt.security（非 win32 也可用）。
      if (rt.memory && typeof request.toolName === 'string' && request.toolName.startsWith('memory_')) {
        const rec = rt.chatSessions.get(sessionId);
        return handleMemoryToolAction(request, {
          service: rt.memory,
          audit: rt.audit,
          actor: rt.subject.userId,
          sessionId,
          profileId: rec?.profileId ?? '',
          workspacePath: rec?.workspacePath ?? undefined,
          workspaceKind: rec?.workspaceKind === 'user' ? 'user' : 'auto',
          propose: (proposal) => broker.route(proposal, { sessionId, profileId: rec?.profileId ?? '', taskId, admission }, assertOwner),
          proposalOf: (proposalId) => rt.gate.get(proposalId),
          assertOwner,
        });
      }
      if (!actionRouter) {
        return {
          requestId: request.requestId,
          status: 'denied' as const,
          decision: {
            decision: 'deny' as const,
            ruleId: 'platform.security-unavailable',
            reason: 'Main security layer is unavailable',
          },
        };
      }
      assertOwner();
      const result = await actionRouter.route(request, sessionId, admission);
      assertOwner();
      assertRuntimeRequest(context, captured);
      return result;
    });
  };

  const bindProposalRequests = (
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>,
    sessionId: string,
    profileId: string,
  ): void => {
    const captured = captureRuntimeBinding(sessionId);
    slot.supervisor.onProposal(async (request, context) => {
      assertRuntimeRequest(context, captured);
      const owner = resolveRuntimeOrigin(sessionId, context.originToken, captured.client, captured.lease);
      if (!owner) throw new Error(`session ${sessionId} proposal origin is not executable`);
      const taskId = owner?.taskId;
      const admission = owner?.admission;
      const assertOwner = (): void => {
        assertRuntimeRequest(context, captured);
        assertTaskOwner(sessionId, owner, 'proposal');
      };
      const decision = await broker.route(request, { sessionId, profileId, taskId, admission }, assertOwner);
      assertOwner();
      return decision;
    });
  };

  const startSessionTask = async (
    sessionId: string,
    profileId: string,
    replace: boolean,
    assertBinding?: () => void,
  ): Promise<StartedSessionTask> => {
    assertBinding?.();
    const security = rt.security;
    if (!security) return {};
    const currentOwner = captureTaskOwner(sessionId);
    if (!replace) {
      if (currentOwner) return { admission: currentOwner.admission };
      if (typeof security.taskLifecycle.owner === 'function'
        && security.taskLifecycle.currentAdmission?.(sessionId) !== undefined) {
        throw new Error(`session ${sessionId} task replacement is pending`);
      }
    }
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    const workspacePath = rec?.workspacePath;
    if (!workspacePath) throw new Error('session workspace missing');
    const policy = security.profilePolicies.get(profileId);
    if (!policy) throw new Error(`no security policy for profile ${profileId}`);
    const rawInputs = rec?.inputs;
    const inputs = (parseSessionInputs(rawInputs ?? undefined) ?? []).flatMap((input) => {
      const path = input?.path;
      return typeof path === 'string' && path.length > 0 ? [path] : [];
    });
    let admission: TaskAdmissionToken | undefined;
    const grant = await security.taskLifecycle.start(async () => {
      assertBinding?.();
      return createTaskGrant({
      sessionId,
      agentId: profileId,
      profileId,
      actorId: rt.subject.userId,
      unattended: false,
      planMode: 'execute',
      permissionMode: resolvePermissionMode({
        sessionId,
        profileId,
        sessionMode: rt.chatSessions.get(sessionId)?.permissionMode ?? rec.permissionMode,
        profileDefaultMode: policy.defaultPermissionMode,
        allowedModes: policy.allowedPermissionModes,
      }),
      workspacePath,
      scratchParent: security.scratchParent,
      inputRoots: inputs,
      protectedRoots: security.protectedRoots,
      probe: security.pathProbe,
      });
    }, (token) => {
      admission = token;
      try {
        assertBinding?.();
        security.taskLifecycle.assertCurrentAdmission?.(sessionId, token);
      } catch (error) {
        throw new Error(`session ${sessionId} admission cancelled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, (startedGrant) => {
      security.taskLifecycle.registerCancellation(
        startedGrant.taskId,
        'host-shell',
        async () => {
          await security.hostShell.terminate(startedGrant.taskId);
          await rm(startedGrant.scratchRoot, { recursive: true, force: true }).catch(() => {});
        },
      );
      security.taskLifecycle.registerCancellation(
        startedGrant.taskId,
        'reviewer',
        () => security.reviewer.cancel(startedGrant.taskId),
      );
      security.taskLifecycle.registerCancellation(
        startedGrant.taskId,
        'capability-gateway',
        async () => { security.capabilityGateway.revokeTask(startedGrant.taskId); },
      );
      security.taskLifecycle.registerCancellation(
        startedGrant.taskId,
        'pending-approval',
        () => broker.cancelTask(startedGrant.taskId, 'task-revoked'),
      );
      security.taskLifecycle.registerCancellation(
        startedGrant.taskId,
        'user-task',
        async () => { userTaskBySession.delete(sessionId); },
      );
    }, sessionId);
    try {
      assertBinding?.();
      if (admission) security.taskLifecycle.assertCurrentAdmission?.(sessionId, admission);
      if (typeof security.taskLifecycle.assertOwner === 'function') {
        security.taskLifecycle.assertOwner(sessionId, { taskId: grant.taskId, admission });
      }
    } catch (error) {
      await security.taskLifecycle.revokeTask(grant.taskId, 'runtime-released', admission);
      throw error;
    }
    return { grant, admission };
  };

  // ── P1: generic workspace file IPC ────────────────────────────────────────
  // Platform capability, no business/agent specifics. Every operation is
  // fenced by Workspace Admission, audited and fails closed (product §14 P1,
  // hard condition R1). This is a distinct path from readDocumentBytes
  // (restricted preview bytes) and requestExportReport (approval-broker export)
  // — none of those handlers are modified here.
  const workspaceFiles = createWorkspaceFileService({
    chatSessions: rt.chatSessions,
    audit: rt.audit,
    security: rt.security,
    subjectUserId: rt.subject?.userId ?? 'agent',
  });
  const workspaceFileHandler = (op: WorkspaceFileOp) =>
    async (_e: unknown, req: { sessionId: string; path: string; content?: string; bytesBase64?: string; to?: string }) =>
      workspaceFiles.execute(op, {
        sessionId: String(req?.sessionId ?? ''),
        path: String(req?.path ?? ''),
        ...(typeof req?.content === 'string' ? { content: req.content } : {}),
        ...(typeof req?.bytesBase64 === 'string' ? { bytesBase64: req.bytesBase64 } : {}),
        ...(typeof req?.to === 'string' ? { to: req.to } : {}),
      });
  ipcMain.handle('sparkii:workspaceRead', workspaceFileHandler('read'));
  ipcMain.handle('sparkii:workspaceReadBytes', workspaceFileHandler('readBytes'));
  ipcMain.handle('sparkii:workspaceWrite', workspaceFileHandler('write'));
  ipcMain.handle('sparkii:workspaceWriteBytes', workspaceFileHandler('writeBytes'));
  ipcMain.handle('sparkii:workspaceList', workspaceFileHandler('list'));
  ipcMain.handle('sparkii:workspaceMkdir', workspaceFileHandler('mkdir'));
  ipcMain.handle('sparkii:workspaceDelete', workspaceFileHandler('delete'));
  ipcMain.handle('sparkii:workspaceRename', workspaceFileHandler('rename'));
  ipcMain.handle('sparkii:workspaceMove', workspaceFileHandler('move'));

  // ── 记忆模块（平台能力；文件为真相源，SQLite 为派生索引） ────────────────
  const memoryService = () => {
    if (!rt.memory) throw new Error('记忆模块未就绪');
    return rt.memory;
  };
  ipcMain.handle('sparkii:listMemories', () => memoryService().list());
  ipcMain.handle('sparkii:addMemory', (_e, req: {
    scope: string; text: string; pinned?: boolean; agentId?: string;
    workspacePath?: string; workspaceKind?: 'auto' | 'user'; sessionId?: string; excerpt?: string;
  }) => {
    const rec = typeof req?.sessionId === 'string' ? rt.chatSessions.get(req.sessionId) : undefined;
    const workspacePath = req?.workspacePath || rec?.workspacePath || undefined;
    return memoryService().addMemory({
      ...req,
      workspacePath,
      workspaceKind: req?.workspaceKind ?? (rec && rec.workspaceKind === 'user' ? 'user' : 'auto'),
    });
  });
  ipcMain.handle('sparkii:updateMemory', (_e, id: string, patch: { text?: string; pinned?: boolean; status?: 'active' | 'superseded' }) =>
    memoryService().updateMemory(String(id), patch ?? {}));
  ipcMain.handle('sparkii:deleteMemory', async (_e, id: string, opts?: { mode?: 'normal' | 'privacy'; includeHistory?: boolean }) => {
    const memory = memoryService();
    if (opts?.mode !== 'privacy') return memory.deleteMemory(String(id), opts ?? {});
    const sessionId = memory.privacySourceSessionFor(String(id));
    const result = await withSessionDeletion(sessionId, () => memory.deleteMemory(String(id), opts ?? {}), () => memory.privacyDeletePending(sessionId));
    return result ?? { ok: true, removed: [] };
  });
  ipcMain.handle('sparkii:resolvePending', (_e, id: string, decision: 'approve' | 'reject') =>
    memoryService().resolvePending(String(id), decision === 'approve' ? 'approve' : 'reject'));
  ipcMain.handle('sparkii:archiveProject', (_e, workspacePath: string, archived: boolean) =>
    memoryService().archiveProject(String(workspacePath), archived !== false));
  ipcMain.handle('sparkii:getMemorySettings', () => memoryService().getSettings());
  ipcMain.handle('sparkii:saveMemorySettings', (_e, partial: Record<string, unknown>) =>
    memoryService().saveSettings(partial as never));
  ipcMain.handle('sparkii:rebuildMemoryIndex', () => memoryService().rebuildIndex());
  ipcMain.handle('sparkii:repairProjectMemory', (_e, workspacePath: string, mode: 'empty' | 'replace', content?: string) =>
    memoryService().repairProjectMemory(String(workspacePath), mode === 'replace' ? 'replace' : 'empty', content));
  ipcMain.handle('sparkii:searchMemory', (_e, query: string, opts?: { limit?: number; includeHistory?: boolean }) =>
    memoryService().searchMemory(String(query ?? ''), opts ?? {}));
  // ── end P1 ────────────────────────────────────────────────────────────────

  // ── P7: generic SVG → PNG render (platform capability, no business semantics) ──
  // Renders in-process via bundled Electron Chromium, then writes the PNG back
  // through the same fenced P1 writeBytes path (Workspace Admission + audit).
  const diagramRenderer = createRenderDiagramService(createElectronSvgRenderer());
  ipcMain.handle('sparkii:renderDiagram', async (
    _e,
    req: { sessionId: string; path: string; svg: string; sourceXml?: string; width?: number; height?: number; scale?: number },
  ) => {
    const rendered = await diagramRenderer.render({
      svg: String(req?.svg ?? ''),
      ...(typeof req?.sourceXml === 'string' ? { sourceXml: req.sourceXml } : {}),
      ...(typeof req?.width === 'number' ? { width: req.width } : {}),
      ...(typeof req?.height === 'number' ? { height: req.height } : {}),
      ...(typeof req?.scale === 'number' ? { scale: req.scale } : {}),
    });
    if (!rendered.ok || !rendered.png) {
      return { ok: false, code: 'RENDER_FAILED', reason: rendered.error ?? 'render failed' };
    }
    return workspaceFiles.execute('writeBytes', {
      sessionId: String(req?.sessionId ?? ''),
      path: String(req?.path ?? ''),
      bytesBase64: rendered.png.toString('base64'),
    });
  });
  // ── end P7 ────────────────────────────────────────────────────────────────

  // ── P1 (export): generic MD + images → DOCX compile ────────────────────────
  // User-initiated export pre-authorizes the identical target/payload; the
  // compiled file is written inside the fixed workspace through the fenced P1
  // writeBytes path (Workspace Admission + audit). No Approval Proposal.
  ipcMain.handle('sparkii:compileDocx', async (
    _e,
    req: {
      sessionId: string;
      outPath: string;
      title: string;
      chapters: Array<{ title: string; markdown: string }>;
      images: string[];
    },
  ) => {
    const sessionId = String(req?.sessionId ?? '');
    const images = [];
    for (const ref of req?.images ?? []) {
      const cleanRef = String(ref).replace(/^\.\//, '').replace(/\\/g, '/');
      const rel = cleanRef.startsWith('figures/')
        ? `output/${cleanRef}`
        : `output/manuscript/${cleanRef}`;
      const read = await workspaceFiles.execute('readBytes', { sessionId, path: rel });
      if (read.ok && read.bytesBase64) {
        images.push({ ref: String(ref), data: Buffer.from(read.bytesBase64, 'base64') });
      }
    }
    const compiled = await compileDocx(
      (req?.chapters ?? []).map((c) => ({ title: String(c.title ?? ''), markdown: String(c.markdown ?? '') })),
      images,
      String(req?.title ?? 'document'),
    );
    if (!compiled.ok || !compiled.docx) {
      return { ok: false, code: 'COMPILE_FAILED', reason: compiled.error ?? 'compile failed' };
    }
    return workspaceFiles.execute('writeBytes', {
      sessionId,
      path: String(req?.outPath ?? 'output/final/document.docx'),
      bytesBase64: compiled.docx.toString('base64'),
    });
  });
  // ── end export ────────────────────────────────────────────────────────────

  const win = getWindow();
  if (win) {
    win.on('maximize', () => {
      if (!win.isDestroyed()) win.webContents.send('sparkii:event:window-maximized', true);
    });
    win.on('unmaximize', () => {
      if (!win.isDestroyed()) win.webContents.send('sparkii:event:window-maximized', false);
    });
  }
  rt.pool.subscribe?.((snapshot) => {
    getWindow()?.webContents.send('sparkii:event:runtime-pool', snapshot);
  });
  const documentParseSupervisor = getDocumentParseSupervisor();
  documentParseSupervisor.subscribe((snap) => {
    getWindow()?.webContents.send('sparkii:event:document-parse', snap);
  });
  documentParseSupervisor.setErrorReporter((message) => {
    const id = randomUUID();
    rt.errors?.append?.({ id, message, source: '文档解析', createdAt: Date.now() });
    getWindow()?.webContents.send('sparkii:event:chat-event', {
      type: 'runtime_error', message, errorId: id, source: '文档解析',
    });
  });
  void loadSettings(rt.dataDir).then((prev) => {
    const dp = documentParseFromSettings(prev);
    documentParseSupervisor.setIdleMinutes(dp.idleMinutes);
    documentParseSupervisor.setKeepResident(dp.keepResident);
  }).catch(() => {});
  type OpenSession = {
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>;
    profileId: string;
    lease: number;
  };
  type StartedSessionTask = {
    grant?: TaskGrant;
    admission?: TaskAdmissionToken;
  };
  type RuntimeRequestBinding = {
    sessionId: string;
    client: OpenSession['slot']['client'];
    lease: number | undefined;
    open?: OpenSession;
    assertBinding: () => void;
  };
  const openSessions = new Map<string, OpenSession>();
  const sessionOpenPromises = new Map<string, Promise<OpenSession>>();
  const sessionOpenEpochs = new Map<string, number>();
  const stoppingSessions = new Set<string>();
  const deletionTombstones = new Set<string>();
  const deletionPromises = new Map<string, Promise<unknown>>();
  const sessionStopPromises = new Map<string, Promise<boolean>>();
  /** 一根进程一根管子；键是 client（进程稳），不是每次 acquire 的新包装对象。 */
  const processPipes = new WeakMap<object, () => void>();
  const appliedModelBySession = new Map<string, { provider: string; modelId: string }>();
  const sessionKnowledgeSelections = new Map<string, KnowledgeSelection>();
  const groundingTurns = new Map<string, GroundingTurn>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightWorkflowRuns = new Map<string, number>();

  function hasCurrentWorkflowRun(sessionId: string): boolean {
    const lease = rt.pool.getBinding(sessionId)?.lease;
    return lease !== undefined && inFlightWorkflowRuns.get(sessionId) === lease;
  }
  /**
   * Prompt turns are serialized because the Pi protocol's agent_settled event has
   * no turn id. A replacement prompt cannot start until the prior turn's terminal
   * event has been observed and its admission cleanup has completed.
   */
  interface PromptTurn {
    promptId: string;
    originToken: string;
    taskId?: string;
    admission?: TaskAdmissionToken;
    client: OpenSession['slot']['client'];
    lease: number;
    readyForSettled: boolean;
    terminal: boolean;
    started: boolean;
    retainTask: boolean;
    settled: Promise<void>;
    resolveSettled: () => void;
    queued: Promise<void>;
    releaseQueued: () => void;
  }
  const promptTurnsBySession = new Map<string, PromptTurn>();
  const promptQueueTailsBySession = new Map<string, Promise<void>>();
  const runtimeOrigins = new Map<string, {
    sessionId: string;
    client: OpenSession['slot']['client'];
    lease: number;
    taskId?: string;
    admission?: TaskAdmissionToken;
  }>();
  const createPromptTurn = (
    queued: Promise<void>,
    releaseQueued: () => void,
    client: OpenSession['slot']['client'],
    lease: number,
    retainTask = false,
  ): PromptTurn => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    return {
      promptId: randomUUID(), originToken: randomUUID(), client, lease, retainTask,
      readyForSettled: false, terminal: false, started: false,
      settled, resolveSettled, queued, releaseQueued,
    };
  };
  const completePromptQueue = (sessionId: string, queued: Promise<void>, release: () => void): void => {
    release();
    if (promptQueueTailsBySession.get(sessionId) === queued) promptQueueTailsBySession.delete(sessionId);
  };
  const completePromptTurn = (sessionId: string, turn: PromptTurn): void => {
    if (promptTurnsBySession.get(sessionId) === turn) promptTurnsBySession.delete(sessionId);
    runtimeOrigins.delete(turn.originToken);
    turn.resolveSettled();
    completePromptQueue(sessionId, turn.queued, turn.releaseQueued);
  };
  const completePromptTurnForBinding = (
    sessionId: string,
    client: OpenSession['slot']['client'],
    lease: number,
    admission?: TaskAdmissionToken,
  ): void => {
    const turn = promptTurnsBySession.get(sessionId);
    if (turn?.client !== client || turn.lease !== lease) return;
    if (admission !== undefined && turn.admission !== admission) return;
    completePromptTurn(sessionId, turn);
  };
  const completePromptTurnWithoutBinding = (sessionId: string): void => {
    if (rt.pool.getBinding(sessionId)) return;
    const turn = promptTurnsBySession.get(sessionId);
    if (turn) completePromptTurn(sessionId, turn);
  };
  const resolveRuntimeOrigin = (
    sessionId: string,
    originToken: unknown,
    client: OpenSession['slot']['client'],
    lease: number | undefined,
  ): TaskOwner | undefined => {
    if (typeof originToken !== 'string' || !originToken.trim()) return undefined;
    const origin = runtimeOrigins.get(originToken);
    if (!origin || origin.sessionId !== sessionId || origin.client !== client || origin.lease !== lease) return undefined;
    const lifecycle = rt.security?.taskLifecycle;
    if (origin.admission) {
      if (!lifecycle || typeof lifecycle.ownerForAdmission !== 'function') return undefined;
      return lifecycle.ownerForAdmission(sessionId, origin.admission);
    }
    // Security is mandatory in production. Connector-only hosts without a Task
    // registry still require the exact live origin, but have no Task owner.
    return Object.freeze({ taskId: origin.taskId ?? '' });
  };
  rt.resolveRuntimeOrigin = resolveRuntimeOrigin;
  // P9 — 保持槽位 + 更激进 idle 释放（15s），与 B1 的 end 修复协同：
  // setup 阶段的 new_session settled 在槽位建立时就消化掉，不在首条 prompt
  // 建立 Grant 之后迟到触发误撤销。
  const sessionIdleReleaseMs = 15_000;

  const anchorDir = (sessionId: string) => join(rt.dataDir, 'sessions', sessionId);

  function cancelIdleRelease(sessionId: string): void {
    const timer = idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(sessionId);
    }
  }

  function scheduleIdleRelease(sessionId: string): void {
    cancelIdleRelease(sessionId);
    const lease = rt.pool.getBinding(sessionId)?.lease;
    if (lease === undefined) return;
    const timer = setTimeout(() => {
      idleTimers.delete(sessionId);
      if (rt.pool.getBinding(sessionId)?.lease === lease) {
        void releaseSessionSlotInternal(sessionId).catch(() => {});
      }
    }, sessionIdleReleaseMs);
    idleTimers.set(sessionId, timer);
  }

  function buildSaddle(profileId: string, sessionId: string): SessionSaddle {
    const rec = rt.chatSessions.get(sessionId);
    return buildAgentSaddle(
      rt.agentOf(profileId),
      anchorDir(sessionId),
      rec?.workspacePath,
      undefined,
      undefined,
      rt.memory?.buildBlock({
        sessionId,
        profileId,
        workspacePath: rec?.workspacePath ?? undefined,
        workspaceKind: rec?.workspaceKind,
      }),
      rt.memory?.getSettings().enabled === true,
    );
  }

  async function withProbeSlot<T>(fn: (client: Awaited<ReturnType<typeof rt.pool.acquire>>['client']) => Promise<T>): Promise<T> {
    const key = `probe:${randomUUID()}`;
    const slot = await rt.pool.acquire(key, {
      meta: { profileId: 'internal', profileName: '内部探测', label: '内部探测', internal: true },
    });
    try {
      return await fn(slot.client);
    } finally {
      await rt.pool.release(key);
    }
  }

  async function injectProbeKey(client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'], providerId: string): Promise<void> {
    const key = await rt.keyFor(providerId);
    if (key) await client.send({ type: 'set_api_key', provider: providerId, apiKey: key });
  }

  async function providerProbeTarget(providerId: string, apiKeyOverride?: string | null) {
    const settings = await loadSettings(rt.dataDir);
    const custom = (settings.providers ?? []).find((p) => p.id === providerId);
    const apiKey = apiKeyOverride ?? (await rt.keyFor(providerId));
    if (custom) return { baseUrl: custom.baseUrl, api: custom.api, apiKey };
    const runtimeProviders = await withProbeSlot(async (client) => {
      const resp = await client.send({ type: 'list_providers' });
      if (!resp.success) throw new Error(resp.error ?? 'list_providers failed');
      return (resp.data ?? []) as PiProviderInfo[];
    });
    const base = runtimeProviders.find((p) => p.id === providerId);
    if (!base) throw new Error(`unknown provider ${providerId}`);
    return { baseUrl: base.baseUrl, api: undefined, apiKey };
  }

const MODEL_CAPABILITY_DEFAULTS: Record<string, ModelCapability[]> = {
  'deepseek-flash': ['chat', 'vision', 'toolCall'],
  'deepseek-v4-pro': ['chat', 'reasoning', 'longContext', 'toolCall', 'thinking'],
  'deepseek-v4-flash': ['chat', 'fast', 'toolCall'],
  'deepseek-vision': ['chat', 'vision'],
};

  const chatStateData = (data: unknown): {
    isStreaming?: boolean;
    streaming?: boolean;
    isCompacting?: boolean;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
    streamingMessage?: unknown;
  } => (data ?? {}) as {
    isStreaming?: boolean;
    streaming?: boolean;
    isCompacting?: boolean;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
    streamingMessage?: unknown;
  };

  function cancelTransientWaiters(
    sessionId: string,
    lease?: number,
    admission?: TaskAdmissionToken,
  ): void {
    const waiters = transientPromptCancels.get(sessionId);
    if (!waiters) return;
    const matches = (waiter: { lease: number; admission?: TaskAdmissionToken }): boolean =>
      lease !== undefined && waiter.lease < lease
      || (lease === undefined || waiter.lease === lease) && (admission === undefined || waiter.admission === admission);
    for (const waiter of waiters) {
      if (matches(waiter)) waiter.cancel();
    }
    const remaining = waiters.filter((waiter) => !matches(waiter));
    if (remaining.length) transientPromptCancels.set(sessionId, remaining);
    else transientPromptCancels.delete(sessionId);
  }

  function removeTransientWaiter(sessionId: string, waiter: { lease: number; admission?: TaskAdmissionToken; cancel: () => void }): void {
    const waiters = transientPromptCancels.get(sessionId);
    if (!waiters) return;
    const remaining = waiters.filter((candidate) => candidate !== waiter);
    if (remaining.length) transientPromptCancels.set(sessionId, remaining);
    else transientPromptCancels.delete(sessionId);
  }

  function assertOpenBinding(sessionId: string, open: OpenSession): void {
    const binding = rt.pool.getBinding(sessionId);
    if (open.slot.getSessionId() !== sessionId
      || rt.pool.get(sessionId) !== open.slot.client
      || binding?.client !== open.slot.client
      || binding.lease !== open.lease) {
      throw new Error(`session ${sessionId} is no longer bound`);
    }
  }

  function assertCapturedBinding(
    sessionId: string,
    open: OpenSession | undefined,
    client: OpenSession['slot']['client'] | undefined,
    lease: number | undefined,
  ): void {
    if (open) {
      if (openSessions.get(sessionId) !== open) throw new Error(`session ${sessionId} is no longer bound`);
      assertOpenBinding(sessionId, open);
      return;
    }
    const binding = rt.pool.getBinding(sessionId);
    if (client === undefined) {
      if (binding !== undefined) {
        throw new Error(`session ${sessionId} is no longer bound`);
      }
      return;
    }
    if (binding?.client !== client || binding.lease !== lease || rt.pool.get(sessionId) !== client) {
      throw new Error(`session ${sessionId} is no longer bound`);
    }
  }

  function captureRuntimeBinding(sessionId: string): RuntimeRequestBinding {
    const open = openSessions.get(sessionId);
    const binding = rt.pool.getBinding(sessionId);
    const client = open?.slot.client ?? binding?.client;
    const lease = open?.lease ?? binding?.lease;
    const assertBinding = (): void => assertCapturedBinding(sessionId, open, client, lease);
    assertBinding();
    return { sessionId, client: client!, lease, open, assertBinding };
  }

  function assertRuntimeRequest(context: PiRuntimeRequestContext, binding: RuntimeRequestBinding): void {
    if (context.client !== binding.client || context.sessionGeneration !== binding.client.sessionGeneration()) {
      throw new Error(`session ${binding.sessionId} runtime request is stale`);
    }
    binding.assertBinding();
  }

  function ensureOpenSession(sessionId: string): Promise<OpenSession> {
    const existing = sessionOpenPromises.get(sessionId);
    if (existing) return existing;
    const opening = ensureOpenSessionOwned(sessionId).then(
      (open) => {
        if (sessionOpenPromises.get(sessionId) === opening) sessionOpenPromises.delete(sessionId);
        return open;
      },
      (error: unknown) => {
        if (sessionOpenPromises.get(sessionId) === opening) sessionOpenPromises.delete(sessionId);
        throw error;
      },
    );
    sessionOpenPromises.set(sessionId, opening);
    return opening;
  }

  async function ensureOpenSessionOwned(sessionId: string): Promise<OpenSession> {
    if (stoppingSessions.has(sessionId) || deletionTombstones.has(sessionId)) throw new Error(`session ${sessionId} is being deleted`);
    const epoch = sessionOpenEpochs.get(sessionId) ?? 0;
    const assertOpeningCurrent = (): void => {
      if (deletionTombstones.has(sessionId) || stoppingSessions.has(sessionId) || (sessionOpenEpochs.get(sessionId) ?? 0) !== epoch) {
        throw new Error(`session ${sessionId} opening was cancelled`);
      }
    };
    let open = openSessions.get(sessionId);
    if (open) {
      try {
        assertOpenBinding(sessionId, open);
        return open;
      } catch {
        openSessions.delete(sessionId);
      }
    }

    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    let named: string | undefined;
    try {
      named = (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId)?.name?.trim() || undefined;
    } catch {
      named = undefined;
    }
    assertOpeningCurrent();
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildSaddle(rec.profileId, sessionId),
      resumeSessionFile: rt.chatSessions.rawPiSessionFile(sessionId),
      meta: profilePoolMeta(rt, rec.profileId, named),
    });
    const acquiredLease = slot.lease;
    let binding: ReturnType<typeof rt.pool.getBinding>;
    try {
      assertOpeningCurrent();
      binding = rt.pool.getBinding(sessionId);
      if (!binding || binding.lease !== acquiredLease) throw new Error(`unknown session ${sessionId}`);
      open = { slot, profileId: rec.profileId, lease: acquiredLease };
      assertOpenBinding(sessionId, open);
      assertOpeningCurrent();
    } catch (error) {
      const current = rt.pool.getBinding(sessionId);
      if (current?.lease === acquiredLease) {
        await rt.pool.release(sessionId, acquiredLease);
      }
      throw error;
    }
    openSessions.set(sessionId, open);
    return open;
  }

  /**
   * 每个子进程只订一次事件与退出。出门时当场读池子里的活 `slot.sessionId` 盖章：牌子为空就不送窗口，
   * 进程借给下一条会话时同一根管子自动改盖新 id。
   */
  function ensureProcessPipe(slot: Awaited<ReturnType<typeof rt.pool.acquire>>): void {
    if (processPipes.has(slot.client)) return;
    const off = slot.client.onEvent((ev) => {
      const sessionId = slot.getSessionId();
      if (!sessionId) return;
      getWindow()?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
      if (ev.type === 'agent_start' || ev.type === 'turn_start') {
        const turn = promptTurnsBySession.get(sessionId);
        if (turn?.readyForSettled) turn.started = true;
      }
      if (ev.type === 'prompt_error') {
        const turn = promptTurnsBySession.get(sessionId);
        const binding = rt.pool.getBinding(sessionId);
        // Unlike agent_settled, this terminal event carries the admission turn id.
        // Require every ownership dimension; generic runtime_error never reaches here.
        if (!turn || !turn.readyForSettled || turn.client !== slot.client
          || binding?.client !== slot.client || binding.lease !== turn.lease
          || ev.command !== 'prompt' || ev.terminal !== true
          || typeof ev.promptId !== 'string' || ev.promptId !== turn.promptId) return;
        const lifecycle = rt.security?.taskLifecycle;
        let ownsPrompt = !lifecycle;
        if (lifecycle && turn.taskId) {
          if (typeof lifecycle.assertOwner === 'function') {
            try {
              lifecycle.assertOwner(sessionId, { taskId: turn.taskId, admission: turn.admission });
              ownsPrompt = true;
            } catch {
              ownsPrompt = false;
            }
          } else {
            ownsPrompt = lifecycle.active(sessionId)?.taskId === turn.taskId
              && (!turn.admission || lifecycle.currentAdmission?.(sessionId) === turn.admission);
          }
        }
        const cancelled = Boolean(turn.admission && lifecycle
          && typeof lifecycle.isCurrentAdmission === 'function'
          && !lifecycle.isCurrentAdmission(sessionId, turn.admission));
        if (ownsPrompt || cancelled) {
          turn.terminal = true;
          void (async () => {
            try {
              if (ownsPrompt && !turn.retainTask) await lifecycle?.end(sessionId, 'session-ended', turn.admission);
            } finally {
              completePromptTurn(sessionId, turn);
            }
          })();
        }
      }
      if (ev.type === 'agent_settled') {
        memoryConsolidation?.noteActivity();
        const turn = promptTurnsBySession.get(sessionId);
        const turnTaskId = turn?.taskId;
        if (turn?.readyForSettled && (turnTaskId || !rt.security?.taskLifecycle)) {
          const lifecycle = rt.security?.taskLifecycle;
          let ownsSettled = false;
          if (lifecycle && turnTaskId && typeof lifecycle.assertOwner === 'function') {
            try {
              lifecycle.assertOwner(sessionId, { taskId: turnTaskId, admission: turn.admission });
              ownsSettled = true;
            } catch {
              ownsSettled = false;
            }
          } else if (lifecycle) {
            ownsSettled = lifecycle.active(sessionId)?.taskId === turnTaskId
              && (!turn.admission || lifecycle.currentAdmission?.(sessionId) === turn.admission);
          } else {
            ownsSettled = true;
          }
          const cancelled = Boolean(
            (turn.admission && lifecycle && typeof lifecycle.isCurrentAdmission === 'function'
              && !lifecycle.isCurrentAdmission(sessionId, turn.admission))
            || ev.aborted === true,
          );
          // A replacement is armed before its first runtime start event. A
          // duplicate settled from the prior turn can arrive in that window;
          // without a turn id it must not consume the not-yet-started replacement.
          if ((ownsSettled && turn.started) || cancelled) {
            void (async () => {
              try {
                // A cancelled/aborted turn may no longer own a grant. Its observed
                // terminal event still releases the serialization barrier, but it
                // must never end a different task's grant. An unexplained owner
                // mismatch may be a late event from an older session, so it does
                // not consume the armed turn.
                if (ownsSettled && !turn.retainTask) await lifecycle?.end(sessionId, 'session-ended', turn.admission);
              } finally {
                completePromptTurn(sessionId, turn);
              }
            })();
          }
        }
        void persistHitTurn(sessionId);
        memoryExtraction?.noteSettled(sessionId);
        // 迟到的 settled 不属于本轮，仍可调度 idle 释放空闲槽位，但绝不碰 Grant。
        if (!hasCurrentWorkflowRun(sessionId)) {
          scheduleIdleRelease(sessionId);
        }
      }
    });
    // 退出跟管子同一套去重：订多次会让一次崩溃打 N 行日志、卸 N 次。
    const offExit = slot.supervisor.onExit((code) => {
      const sessionId = slot.getSessionId();
      void logger.log({ level: 'error', msg: 'pi runtime exited', ctx: { sessionId, code } });
      if (!sessionId) return;
      const binding = rt.pool.getBinding(sessionId);
      const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
      void (async () => {
        try {
          await rt.security?.taskLifecycle.end(sessionId, 'runtime-released', admission);
        } finally {
          // 子进程没了就问不到 sessionFile，也不去抢救 streamingMessage：JSONL 是唯一的账。
          cancelIdleRelease(sessionId);
          openSessions.delete(sessionId);
          appliedModelBySession.delete(sessionId);
          await unbindAndRelease(sessionId, binding?.lease, admission);
        }
      })().catch(() => {});
    });
    processPipes.set(slot.client, () => { off(); offExit(); });
    bindConnectorRead(slot);
  }

  function bindConnectorRead(slot: Awaited<ReturnType<typeof rt.pool.acquire>>, knownProfileId?: string): void {
    const sessionId = slot.getSessionId();
    if (!sessionId) return;
    const captured = captureRuntimeBinding(sessionId);
    const profileId = knownProfileId ?? openSessions.get(sessionId)?.profileId ?? rt.chatSessions.get(sessionId)?.profileId;
    if (!profileId) return;
    slot.supervisor.onConnectorRead?.(async (req, context): Promise<ConnectorReadResult> => {
      assertRuntimeRequest(context, captured);
      const owner = resolveRuntimeOrigin(sessionId, context.originToken, captured.client, captured.lease);
      if (!owner) return { ok: false, error: { code: 'ORIGIN_REQUIRED', message: 'Connector read origin is missing, stale, or superseded' } };
      const assertOrigin = (): void => {
        assertRuntimeRequest(context, captured);
        assertTaskOwner(sessionId, owner, 'action');
      };
      assertOrigin();
      const result = await handleConnectorRead(req, profileId, sessionId, captured, owner, assertOrigin);
      assertOrigin();
      return result;
    });
  }

  async function appendKnowledgeTurn(sessionId: string, data: ReturnType<typeof knowledgeTurnPayload>): Promise<void> {
    const open = openSessions.get(sessionId);
    if (!open) return;
    await open.slot.client.send({ type: 'append_workflow_entry', customType: KNOWLEDGE_TURN, data });
  }

  async function persistHitTurn(sessionId: string): Promise<void> {
    const open = openSessions.get(sessionId);
    if (!open) return;
    const knowledge = knowledgeFromManifest(rt.profileOf(open.profileId).profile.manifest);
    // `bm25` 是本地语料，没有出处可写；两个远端后端都要写。
    if (knowledge.backend === 'bm25') return;
    const turn = groundingTurns.get(sessionId);
    if (!turn?.searchCalled || turn.miss || turn.sealed) return;
    groundingTurns.set(sessionId, sealTurn(turn));
    await appendKnowledgeTurn(sessionId, knowledgeTurnPayload(turn));
  }

  async function refuseEmptySearch(binding: RuntimeRequestBinding, payload: ReturnType<typeof knowledgeTurnPayload>): Promise<void> {
    binding.assertBinding();
    const appended = await binding.client.send({ type: 'append_workflow_entry', customType: KNOWLEDGE_TURN, data: payload });
    binding.assertBinding();
    if (!appended.success) throw new Error(appended.error ?? 'append_workflow_entry failed');
    groundingTurns.set(binding.sessionId, sealTurn(groundingTurns.get(binding.sessionId) ?? resetTurn()));
    binding.assertBinding();
    const aborted = await binding.client.send({ type: 'abort' });
    binding.assertBinding();
    if (!aborted.success) throw new Error(aborted.error ?? 'abort failed');
  }

  /** 默认域写入必须落在该后端自己的配置块里（否则 Onto 会话会把域 id 写进 rag.bindings）。 */
  async function persistDefaultDataset(profileId: string, backend: KnowledgeBackendId, datasetId: string, assertBinding: () => void): Promise<void> {
    assertBinding();
    const current = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
    assertBinding();
    const bindings = current.bindings.filter((b) => b.agentId !== profileId);
    bindings.push({ agentId: profileId, defaultDatasetId: datasetId });
    assertBinding();
    await patchKnowledgeSettings(rt.dataDir, backend, { bindings });
    assertBinding();
  }

  /** 原文落盘：按后端取该后端的地址/凭据/客户端（`knowledge.fetch_document` 与"打开原文"共用）。 */
  async function cacheRagFile(
    args: { datasetId: string; documentId: string; fileName?: string },
    backend: KnowledgeBackendId,
    assertBinding: () => void = () => {},
  ): Promise<{ ok: true; path: string } | { ok: false; error: { code: string; message: string } }> {
    assertBinding();
    const rag = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
    assertBinding();
    const credential = await rt.knowledgeToken(backend);
    assertBinding();
    const client = knowledgeClientFor(backend, rag, credential);
    if (!client) {
      const label = backend === 'sparkiionto' ? 'API Token' : 'API Key';
      return { ok: false, error: { code: 'CONNECTOR_DENIED', message: `未配置 ${label}` } };
    }
    try {
      const cached = await fetchAndCacheDocument({
        client,
        cacheDir: join(rt.dataDir, 'rag-cache'),
        backend,
        datasetId: args.datasetId,
        documentId: args.documentId,
        fileName: args.fileName,
      });
      assertBinding();
      return { ok: true, path: cached.path };
    } catch (e) {
      return { ok: false, error: { code: 'CONNECTOR_IO', message: (e as Error).message } };
    }
  }

  async function handleConnectorRead(
    req: ConnectorReadRequest,
    profileId: string,
    sessionId: string,
    binding: RuntimeRequestBinding,
    owner: TaskOwner,
    assertOrigin: () => void,
  ): Promise<ConnectorReadResult> {
    const assertBinding = (): void => {
      binding.assertBinding();
      assertOrigin();
    };
    assertBinding();
    if (req.toolName === 'knowledge.fetch_document') {
      const datasetId = String(req.args.datasetId ?? '');
      const documentId = String(req.args.documentId ?? '');
      const fileName = typeof req.args.fileName === 'string' ? req.args.fileName : undefined;
      // 模型自己取原文时同样按 manifest 的后端路由（`bm25` 沿既有 RAG 行为）。
      const fetchBackend = remoteKnowledgeBackend(
        knowledgeFromManifest(rt.profileOf(profileId).profile.manifest).backend,
      );
      const cached = await cacheRagFile({ datasetId, documentId, fileName }, fetchBackend, assertBinding);
      if (!cached.ok) return { ok: false, error: cached.error };
      return { ok: true, data: { path: cached.path } };
    }
    if (req.toolName === 'document.read') {
      const displayName = rt.profileOf(profileId)?.profile?.manifest?.displayName ?? profileId;
      let args = req.args;
      let authorizedTaskId: string | undefined;
      if (rt.security) {
        rt.security.taskLifecycle.assertOwner(sessionId, owner);
        const grant = rt.security.taskGrants.get(sessionId);
        if (!grant) {
          return {
            ok: false,
            error: { code: 'CONNECTOR_DENIED', message: 'Task grant is not active' },
          };
        }
        authorizedTaskId = grant.taskId;
        const requested = Array.isArray(req.args.documents)          ? req.args.documents.map((value) => String(value ?? ''))
          : [];
        const authorized = await authorizeDocumentReadPaths(
          requested,
          grant,
          rt.security.actionNormalizer,
        );
        assertBinding();
        rt.security.taskLifecycle.assertOwner(sessionId, owner);
        if (!authorized.ok) {
          await rt.audit.append({
            actor: rt.subject.userId,
            action: 'tool.read.denied',
            resource: 'document.read',
            sessionId,
            payloadSummary: authorized.message,
          });
          return {
            ok: false,
            error: { code: 'CONNECTOR_DENIED', message: authorized.message },
          };
        }
        args = { ...req.args, documents: authorized.paths };
      }
      const result = await executeDocumentRead(args, {
        profileId,
        sessionId,
        actor: rt.subject.userId,
        requestId: req.requestId,
        agentDisplayName: displayName,
      });
      assertBinding();
      if (rt.security && authorizedTaskId) rt.security.taskLifecycle.assertOwner(sessionId, owner);
      await rt.audit.append({
        actor: rt.subject.userId,
        action: 'tool.read',
        resource: 'document.read',
        sessionId,
        payloadSummary: documentReadAuditSummary(req.args, result),
      });
      assertBinding();
      return result;
    }
    if (req.toolName.startsWith('ontology.')) {
      const ontoTool = sparkiiOntoConnector.tools.find((t) => t.name === req.toolName);
      if (!ontoTool) {
        return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'unhandled' } };
      }
      const settings = await loadSettings(rt.dataDir);
      assertBinding();
      const credential = await rt.knowledgeToken('sparkiionto');
      assertBinding();
      const result = await executeOntologyTool({
        toolName: req.toolName,
        args: req.args,
        profileId,
        settings,
        credential,
      });
      assertBinding();
      await rt.audit.append({
        actor: rt.subject.userId,
        action: 'tool.read',
        resource: req.toolName,
        sessionId,
        payloadSummary: ontologyAuditSummary(req.toolName, req.args, result),
      });
      assertBinding();
      return result;
    }
    if (req.toolName !== 'knowledge.search') {
      return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'unhandled' } };
    }
    const knowledge = knowledgeFromManifest(rt.profileOf(profileId).profile.manifest);
    const backend = remoteKnowledgeBackend(knowledge.backend);
    const rag = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
    assertBinding();
    const apiKey = knowledge.backend === 'bm25' ? null : await rt.knowledgeToken(backend);
    assertBinding();
    const searchTool = knowledgeConnector.tools.find((t) => t.name === 'knowledge.search')!;
    const out = await runMainKnowledgeSearch({
      args: req.args,
      profileId,
      sessionId,
      backend: knowledge.backend,
      selection: sessionKnowledgeSelections.get(sessionId) ?? null,
      knowledge,
      rag,
      apiKey,
      bm25: async (query, topK) => {
        assertBinding();
        const result = await searchTool.handler({ query, topK }, {
          profileId,
          sessionId,
          actor: rt.subject.userId,
          requestId: req.requestId,
        });
        assertBinding();
        if (!result.ok) throw new Error(result.error?.message ?? 'bm25 failed');
        return result.data;
      },
      persistDefault: (id) => persistDefaultDataset(profileId, backend, id, assertBinding),
    });
    assertBinding();
    await rt.audit.append({
      actor: rt.subject.userId,
      action: 'tool.read',
      resource: 'knowledge.search',
      sessionId,
      payloadSummary: searchAuditSummary(String(req.args.query ?? ''), out.data),
    });
    assertBinding();
    if (out.ok && knowledge.backend !== 'bm25') {
      const data = (out.data ?? {}) as { chunks?: unknown[]; documents?: GroundingTurn['documents'] };
      const next = markSearchResult(groundingTurns.get(sessionId) ?? resetTurn(), {
        chunks: Array.isArray(data.chunks) ? data.chunks : [],
        documents: data.documents,
      });
      groundingTurns.set(sessionId, next);
      if (shouldAbortGeneration(next)) {
        const payload = knowledgeTurnPayload(next);
        queueMicrotask(() => {
          void refuseEmptySearch(binding, payload).catch(() => {});
        });
      }
    } else if (!out.ok && knowledge.backend !== 'bm25' && out.error?.message === SESSION_DATASET_GONE) {
      queueMicrotask(() => {
        void refuseEmptySearch(binding, { refused: true, text: SESSION_DATASET_GONE, documents: [], citations: [] }).catch(() => {});
      });
    }
    return out;
  }

  /** 会话前探活：按该 profile 的后端取配置与凭据（`bm25` 不需要探活）。 */
  async function assertKnowledgeReady(profileId: string): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
    const knowledge = knowledgeFromManifest(rt.profileOf(profileId).profile.manifest);
    if (knowledge.backend === 'bm25') return { ok: true };
    const backend = remoteKnowledgeBackend(knowledge.backend);
    const rag = knowledgeBackendSettings(backend, await loadSettings(rt.dataDir));
    const credential = await rt.knowledgeToken(backend);
    if (backend === 'sparkiirag') {
      if (!rag.baseUrl || !credential) {
        return { ok: false, code: 'CONNECTOR_DENIED', error: '请先在设置 → 知识库配置 SparkiiRAG' };
      }
      try {
        const datasets = await new SparkiiRagClient({ baseUrl: rag.baseUrl, apiKey: credential }).listDatasets();
        if (datasets.length === 0) {
          return { ok: false, code: 'CONNECTOR_DENIED', error: '请先在 SparkiiRAG 建库' };
        }
      } catch (e) {
        return { ok: false, code: 'CONNECTOR_IO', error: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true };
    }
    if (!credential) {
      return { ok: false, code: 'CONNECTOR_DENIED', error: '请先在设置 → 知识库配置 SparkiiOnto' };
    }
    try {
      const client = knowledgeClientFor(backend, rag, credential);
      const datasets = await client!.listDatasets();
      if (datasets.length === 0) {
        return { ok: false, code: 'CONNECTOR_DENIED', error: '请先在 SparkiiOnto 建域' };
      }
    } catch (e) {
      return { ok: false, code: 'CONNECTOR_IO', error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true };
  }

  /** 解绑：先让窗口停转圈，再卸牌子（池子内部先 `sessionId = null` 才 `new_session`）。 */
  async function unbindAndRelease(sessionId: string, expectedLease?: number, admission?: TaskAdmissionToken): Promise<void> {
    const current = rt.pool.getBinding(sessionId);
    if (!current) {
      completePromptTurnWithoutBinding(sessionId);
      return;
    }
    const lease = current.lease;
    if (expectedLease !== undefined && expectedLease !== lease) return;
    cancelTransientWaiters(sessionId, lease, admission);
    getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_unbound', sessionId });
    await rt.pool.release(sessionId, lease);
    const remaining = rt.pool.getBinding(sessionId);
    if (!remaining || remaining.client !== current.client || remaining.lease !== lease) {
      completePromptTurnForBinding(sessionId, current.client, lease, admission);
    }
  }

  async function readQueues(entry: { slot: Awaited<ReturnType<typeof rt.pool.acquire>> }): Promise<QueueSnapshot> {
    const state = await entry.slot.client.send({ type: 'get_state' });
    if (!state.success) throw new Error(state.error ?? 'get_state failed');
    const data = chatStateData(state.data);
    return {
      steering: Array.isArray(data.steering) ? data.steering : [],
      followUp: Array.isArray(data.followUp) ? data.followUp : [],
    };
  }

  async function rebuildQueues(
    client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'],
    snapshot: QueueSnapshot,
    assertBinding: () => void,
    originToken?: string,
    promptId?: string,
  ): Promise<void> {
    if (!originToken) throw new Error('session has no current prompt-turn origin');
    for (const message of snapshot.steering) {
      assertBinding();
      await client.send({ type: 'steer', message, originToken });
      assertBinding();
    }
    for (const message of snapshot.followUp) {
      assertBinding();
      await client.send({ type: 'follow_up', message, originToken, promptId });
      assertBinding();
    }
  }

  async function waitForIdle(
    client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'],
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await client.send({ type: 'get_state' });
      if (!state.success) throw new Error(state.error ?? 'get_state failed');
      const data = chatStateData(state.data);
      const streaming = data.isStreaming ?? data.streaming ?? false;
      if (!streaming) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('stop timeout');
  }

  async function openOrCreateSession(
    sessionId: string | null,
    context: { profileId?: string; workspacePath?: string | null; workspaceKind?: 'auto' | 'user'; model?: string | null; thinkingLevel?: string | null; permissionMode?: PlatformPermissionMode },
  ): Promise<{ open: Awaited<ReturnType<typeof ensureOpenSession>>; sessionId: string; workspacePath: string | undefined }> {
    if (sessionId) {
      cancelIdleRelease(sessionId);
      const open = await ensureOpenSession(sessionId);
      assertOpenBinding(sessionId, open);
      ensureProcessPipe(open.slot);
      bindProposalRequests(open.slot, sessionId, open.profileId);
      bindRuntimeActions(open.slot, sessionId);
      const rec = rt.chatSessions.get(sessionId);
      const settings = await loadSettings(rt.dataDir);
      assertOpenBinding(sessionId, open);
      const target = rec?.model
        ? resolveSessionModel(settings, rec)
        : resolveSessionModel(settings, null);
      if (target) {
        const applied = appliedModelBySession.get(sessionId);
        if (!applied || applied.provider !== target.provider || applied.modelId !== target.modelId) {
          await selectModel(rt, 'chat', sessionId, `${target.provider}/${target.modelId}`, () => assertOpenBinding(sessionId, open));
          assertOpenBinding(sessionId, open);
          appliedModelBySession.set(sessionId, target);
        }
        const latestSettings = await loadSettings(rt.dataDir);
        assertOpenBinding(sessionId, open);
        await applyThinkingLevel(open.slot.client, resolveThinkingLevel(latestSettings, rec, target));
        assertOpenBinding(sessionId, open);
      }
      assertOpenBinding(sessionId, open);
      return { open, sessionId, workspacePath: rec?.workspacePath };
    }

    const profileId = context.profileId;
    if (!profileId) throw new Error('profileId is required');
    const requestedPath = context.workspacePath?.trim();
    const workspacePath = requestedPath
      || allocateAutoWorkspace(app.getPath('documents'), profileId).workspacePath;
    const workspaceKind = requestedPath
      ? (context.workspaceKind === 'user' ? 'user' : 'auto')
      : 'auto';
    const settings = await loadSettings(rt.dataDir);
    const rawMaxAgents = Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4);
    const maxAgents = Number.isFinite(rawMaxAgents) && rawMaxAgents > 0 ? Math.floor(rawMaxAgents) : 4;
    rt.pool.setMaxAgents?.(maxAgents);
    if (rt.pool.activeCount() >= maxAgents && settings.queueEnabled === false) {
      throw new Error(`已达到最大并发会话数 ${maxAgents}，请先释放一个线程`);
    }

    const target = context.model
      ? resolveSessionModel(settings, { model: context.model })
      : resolveSessionModel(settings, null);
    const thinkingLevel = context.thinkingLevel ?? resolveThinkingLevel(settings, null, target);
    const tempKey = `new:${randomUUID()}`;
    const slot = await rt.pool.acquire(tempKey, {
      saddle: buildAgentSaddle(
        rt.agentOf(profileId), anchorDir(tempKey), workspacePath, target ?? undefined, thinkingLevel,
        rt.memory?.buildBlock({ profileId, workspacePath, workspaceKind }),
        rt.memory?.getSettings().enabled === true,
      ),
      meta: profilePoolMeta(rt, profileId),
    });

    let createdSessionId: string | undefined;
    let createdLease: number | undefined;
    let tempLease: number | undefined;
    let entry: OpenSession | undefined;
    let createdRecord = false;
    try {
      tempLease = rt.pool.getBinding(tempKey)?.lease;
      if (tempLease === undefined) throw new Error(`unknown session ${tempKey}`);
      const ownsTemp = (): boolean => {
        const current = rt.pool.getBinding(tempKey);
        return slot.getSessionId() === tempKey && current?.client === slot.client && current.lease === tempLease;
      };
      const freshResp = await slot.client.send({ type: 'new_session' });
      if (!ownsTemp()) throw new Error(`session ${tempKey} is no longer bound`);
      if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
      const state = await slot.client.send({ type: 'get_state' });
      if (!ownsTemp()) throw new Error(`session ${tempKey} is no longer bound`);
      if (!state.success) throw new Error(state.error ?? 'get_state failed');
      createdSessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
      const sessionFile = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (!createdSessionId) throw new Error('runtime did not provide a session id');
      rt.pool.renameSession(tempKey, createdSessionId);
      createdLease = rt.pool.getBinding(createdSessionId)?.lease;
      if (createdLease === undefined) throw new Error(`unknown session ${createdSessionId}`);
      const lease = createdLease;
      entry = { slot, profileId, lease };
      const ownsCreated = (): boolean => {
        const current = rt.pool.getBinding(createdSessionId!);
        return slot.getSessionId() === createdSessionId
          && current?.client === slot.client && current.lease === lease;
      };
      await mkdir(anchorDir(createdSessionId), { recursive: true });
      if (!ownsCreated()) throw new Error(`session ${createdSessionId} is no longer bound`);
      // A draft carries the mode the user picked before the row existed. A mode
      // the profile does not allow silently degrades to Ask.
      let permissionMode: PlatformPermissionMode = 'ask';
      const policy = rt.security?.profilePolicies.get(profileId);
      if (context.permissionMode && policy) {
        try {
          permissionMode = resolveSessionPermissionMode(
            createdSessionId, profileId, policy, context.permissionMode,
          );
        } catch {
          permissionMode = 'ask';
        }
      }
      rt.chatSessions.create({
        id: createdSessionId,
        profileId,
        workspaceKind,
        workspacePath,
        model: target ? modelTargetKey(target) : null,
        thinkingLevel: context.thinkingLevel ?? null,
        piSessionFile: sessionFile ?? null,
        permissionMode,
      });
      createdRecord = true;
      rt.memory?.ensureProject(workspacePath, workspaceKind);
      if (target) {
        const apiKey = await rt.keyFor(target.provider);
        if (!ownsCreated()) throw new Error(`session ${createdSessionId} is no longer bound`);
        if (apiKey) {
          const keyResp = await slot.client.send({ type: 'set_api_key', provider: target.provider, apiKey });
          if (!ownsCreated()) throw new Error(`session ${createdSessionId} is no longer bound`);
          if (!keyResp.success) throw new Error(keyResp.error ?? 'set_api_key failed');
        }
      }
      if (!ownsCreated()) throw new Error(`session ${createdSessionId} is no longer bound`);
      openSessions.set(createdSessionId, entry);
      ensureProcessPipe(slot);
      bindProposalRequests(slot, createdSessionId!, profileId);
      bindRuntimeActions(slot, createdSessionId!);
      return { open: entry, sessionId: createdSessionId, workspacePath };
    } catch (e) {
      if (createdSessionId && createdLease !== undefined) {
        const current = rt.pool.getBinding(createdSessionId);
        const ownsCreated = current?.client === slot.client && current.lease === createdLease
          && slot.getSessionId() === createdSessionId;
        if (entry && openSessions.get(createdSessionId) === entry) openSessions.delete(createdSessionId);
        if (ownsCreated) {
          if (createdRecord) rt.chatSessions.delete(createdSessionId);
          await rt.pool.release(createdSessionId, createdLease);
        }
      } else {
        await rt.pool.release(tempKey, tempLease);
      }
      throw e;
    }
  }

  ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      // 进程还活着：起步 = getBranch() + streamingMessage。不读磁盘（首条 assistant 落盘前
      // 文件可能是空的，树上已有步骤行），也不用 get_messages 当时间线。
      const [entriesResp, stateResp] = await Promise.all([
        open.slot.client.send({ type: 'get_session_entries' }),
        open.slot.client.send({ type: 'get_state' }),
      ]);
      const rec = rt.chatSessions.get(sessionId);
      const entries = (entriesResp.data ?? []) as unknown[];
      const state = chatStateData(stateResp.data);
      const streaming = Boolean(state.isStreaming ?? state.streaming ?? false);
      const streamingMessage = state.streamingMessage
        ?? (streaming ? await recoverInFlightAssistant(open.slot.client, entries) : null);
      return {
        entries,
        streamingMessage: streamingMessage ?? null,
        streaming,
        inputs: parseSessionInputs(rec?.inputs),
        workspacePath: rec?.workspacePath ?? null,
        workspaceKind: rec?.workspaceKind ?? null,
      };
    }
    const rec = rt.chatSessions.get(sessionId) ?? (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
    if (!rec) throw new Error('session not found');
    const stored = rt.chatSessions.get(sessionId);
    const file = (stored ? rt.chatSessions.rawPiSessionFile(sessionId) : undefined)
      ?? (rec as { piSessionFile?: string | null }).piSessionFile
      ?? (rec as { path?: string }).path;
    const dead = (entries: unknown[]) => ({
      entries,
      streamingMessage: null,
      streaming: false,
      inputs: parseSessionInputs((rec as { inputs?: string }).inputs),
      workspacePath: (rec as { workspacePath?: string | null }).workspacePath ?? null,
      workspaceKind: (rec as { workspaceKind?: 'auto' | 'user' | null }).workspaceKind ?? null,
    });
    if (!file) return dead([]);
    try {
      return dead(readPiSessionEntries(file));
    } catch (e) {
      // 空会话或尚未落盘的会话（首条 assistant 才写 jsonl）没有文件，返回空时间线。
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return dead([]);
      throw e;
    }
  });

  /**
   * 收养孤儿 Pi 会话：磁盘上有会话文件、但 chat_sessions 表里没有记录
   * （历史版本/异常退出遗留）。这类会话此前会以 profileId=undefined 落到
   * 渲染层的「空白分组」下，且点击无法打开。自动工作区的路径形如
   * `<Documents>/Sparkii/workspaces/<agentId>/<key>`，可从中无歧义地反推
   * profileId —— 通用规则，不含任何业务分支。
   */
  async function adoptOrphanPiSession(s: { id: string; cwd: string }): Promise<string | undefined> {
    const existing = rt.chatSessions.get(s.id);
    if (existing) return existing.profileId;
    const match = /[\\/]Sparkii[\\/]workspaces[\\/]([^\\/]+)[\\/][^\\/]+[\\/]?$/.exec(s.cwd);
    const profileId = match?.[1];
    if (!profileId) return undefined;
    try {
      rt.chatSessions.create({ id: s.id, profileId, workspaceKind: 'auto', workspacePath: s.cwd });
    } catch { /* 竞态：另一窗口已收养，忽略 */ }
    return profileId;
  }

  ipcMain.handle('sparkii:listChatSessions', async (
    _e,
    profileId?: string,
    opts?: { includeEmpty?: boolean },
  ) => {
    const all = await listPiSessions(join(rt.piAgentDir, 'sessions'));
    const mapped: Array<{
      id: string;
      title?: string;
      firstMessage: string;
      profileId?: string;
      workspacePath?: string;
      updatedAt: number;
      piFile: string | null;
      pinned: boolean;
      archived: boolean;
      sortOrder: number | null;
      empty?: boolean;
    }> = [];
    for (const s of all) {
      let rec = rt.chatSessions.get(s.id);
      if (!rec) {
        const adopted = await adoptOrphanPiSession(s);
        if (!adopted) continue; // 无法推断归属的会话不进入历史列表
        rec = rt.chatSessions.get(s.id);
      }
      mapped.push({
        id: s.id,
        title: s.name,
        firstMessage: s.firstMessage,
        profileId: rec?.profileId,
        workspacePath: rec?.workspacePath ?? s.cwd,
        updatedAt: s.modified.getTime(),
        piFile: s.path,
        pinned: rec?.pinned ?? false,
        archived: rec?.archived ?? false,
        sortOrder: rec?.sortOrder ?? null,
        empty: (s.messageCount ?? 0) === 0,
      });
    }
    // P9: a workspace-bound session can be real and user-visible before its
    // first Pi message is flushed. Generic callers may opt into those rows;
    // the default keeps the historical "empty chat drafts are invisible" rule.
    if (opts?.includeEmpty === true) {
      const seen = new Set(mapped.map((m) => m.id));
      for (const rec of rt.chatSessions.list()) {
        if (seen.has(rec.id)) continue;
        mapped.push({
          id: rec.id,
          title: undefined,
          firstMessage: '(no messages)',
          profileId: rec.profileId,
          workspacePath: rec.workspacePath,
          updatedAt: rec.updatedAt,
          piFile: rec.piSessionFile,
          pinned: rec.pinned,
          archived: rec.archived,
          sortOrder: rec.sortOrder,
          empty: true,
        });
      }
    }
    // Read-only display fallback for sessions whose Pi jsonl has no name yet
    // (e.g. a project is created but no message has been sent, then the app is
    // restarted). Must go through the fenced workspace-file service keyed by
    // sessionId — never by bare workspacePath. No business/agent branching:
    // any session workspace containing project.json gets its name field used.
    // Missing/unreadable files fall through silently to the original logic.
    for (const row of mapped) {
      if (row.title) continue;
      try {
        const result = await workspaceFiles.execute('read', { sessionId: row.id, path: 'project.json' });
        if (!result.ok || typeof result.content !== 'string') continue;
        const parsed = JSON.parse(result.content) as { name?: unknown };
        if (typeof parsed?.name === 'string' && parsed.name.trim()) row.title = parsed.name.trim();
      } catch { /* keep the original display fallback */ }
    }
    const filtered = profileId
      ? mapped.filter((m) => m.profileId === profileId || m.profileId === undefined)
      : mapped;
    return filtered.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  });
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);

  /**
   * P9 — create an EMPTY session bound to a workspace, WITHOUT dispatching any
   * prompt. Generic capability (no agent/business branch): any custom surface
   * that must own a fixed workspace before the user is ready to talk to the
   * model — e.g. set up project files, then start writing on explicit confirm.
   *
   * openOrCreateSession(null, …) already creates the Pi session file + session
   * record (with workspacePath), which is what listChatSessions / the fenced
   * workspace-file IPC need. No `prompt` is sent, so no LLM turn is triggered.
   *
   * Idle slot (P9 — 折中策略，设计稿决策⑤): 保持已绑定的槽位，用更激进的
   * 15s idle 定时器回收。槽位内没有 prompt 就不会有 `agent_settled`，因此
   * 不能靠事件回收；但也不再「建完即解绑」——立即解绑会发出 new_session，
   * 其迟到的 agent_settled 曾在首条 prompt 建立 Grant 后被误判为任务结束
   * （B1）。保持槽位后，首次 promptSession(sessionId, …) 直接复用；若用户
   * 一直停在 setup，15s 后 idle 定时器走 releaseSessionSlotInternal 回收，
   * 不会长期占用 maxAgents。
   */
  ipcMain.handle('sparkii:createSession', async (
    _e,
    context: {
      profileId?: string;
      workspacePath?: string | null;
      workspaceKind?: 'auto' | 'user';
      model?: string | null;
      thinkingLevel?: string | null;
      permissionMode?: PlatformPermissionMode;
    } = {},
  ) => {
    const { sessionId, workspacePath } = await openOrCreateSession(null, context);
    scheduleIdleRelease(sessionId);
    return { ok: true, sessionId, workspacePath };
  });

  const promptSession = async (
    _e: unknown,
    sessionId: string | null,
    text: string,
    options?: { behavior?: 'steer' | 'followUp' | 'prompt' },
    attachments: ChatAttachment[] = [],
    context: { profileId?: string; workspacePath?: string | null; workspaceKind?: 'auto' | 'user'; model?: string | null; thinkingLevel?: string | null; permissionMode?: PlatformPermissionMode; allowDegradedKnowledge?: boolean } = {},
    internal?: { expectedAdmission?: TaskAdmissionToken; retainTask?: boolean; onPromptSend?: () => void },
  ) => {
    const profileIdForGate = sessionId
      ? rt.chatSessions.get(sessionId)?.profileId
      : context.profileId;
    // Callers that declare knowledge optional skip the preflight entirely: for
    // them RAG is an enhancement, and the knowledge tool already degrades to a
    // typed CONNECTOR_DENIED result when unconfigured. Running the probe anyway
    // would add a 30s-per-request network stall to every session creation/prompt
    // (product §15). Callers that omit the flag keep the strict gate and its
    // "configure RAG first" message (knowledge-qa etc.).
    if (profileIdForGate && context.allowDegradedKnowledge !== true) {
      const ragReady = await assertKnowledgeReady(profileIdForGate);
      if (!ragReady.ok) return ragReady;
    }

    const { open, sessionId: resolvedSessionId, workspacePath } = await openOrCreateSession(sessionId, context);
    const assertBinding = (): void => assertOpenBinding(resolvedSessionId, open);
    assertBinding();
    if (!sessionId) {
      const draftKey = `draft:${open.profileId}`;
      const draftSelection = sessionKnowledgeSelections.get(draftKey);
      if (draftSelection && !sessionKnowledgeSelections.has(resolvedSessionId)) {
        sessionKnowledgeSelections.set(resolvedSessionId, draftSelection);
        sessionKnowledgeSelections.delete(draftKey);
      } else {
        sessionKnowledgeSelections.delete(draftKey);
      }
    }

    const list = attachments ?? [];
    const isImage = (a: ChatAttachment) => (a.type ?? '').toLowerCase().startsWith('image/')
      && (a.type ?? '').toLowerCase() !== 'image/svg+xml';
    const imageAtts = list.filter(isImage);
    const fileAtts = list.filter((a) => !isImage(a));

    if (fileAtts.length && !workspacePath) {
      throw new Error('会话缺少工作区，无法放置附件');
    }
    const staged = workspacePath ? await stageAttachments(workspacePath, fileAtts) : [];
    assertBinding();
    const finalText = buildAttachmentPrompt(text, staged);

    const images = await Promise.all(imageAtts.map(async (att) => {
      const resized = resizeImageForAttachment(att.path, att.type ?? '');
      const buffer = resized ? resized.buffer : await readFile(att.path);
      return {
        type: 'image' as const,
        mimeType: resized ? resized.mimeType : (att.type || 'image/png'),
        data: buffer.toString('base64'),
      };
    }));

    assertBinding();
    const stateResp = await open.slot.client.send({ type: 'get_state' });
    assertBinding();
    if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
    const state = chatStateData(stateResp.data);
    const isStreaming = state.isStreaming ?? state.streaming ?? false;
    const behavior: 'steer' | 'followUp' | 'prompt' = options?.behavior ?? (isStreaming ? 'followUp' : 'prompt');
    assertBinding();

    let turn: PromptTurn | undefined;
    let promptMayBeRunning = false;
    let queuedAdmission: TaskAdmissionToken | undefined;
    if (behavior === 'prompt') {
      // Pi's agent_settled event has no turn id. Reserve each queue position
      // synchronously so concurrent replacements cannot both arm after the same
      // terminal event; only one prompt may own a session at a time.
      const previousQueued = promptQueueTailsBySession.get(resolvedSessionId) ?? Promise.resolve();
      let releaseQueued!: () => void;
      const queued = new Promise<void>((resolve) => { releaseQueued = resolve; });
      promptQueueTailsBySession.set(resolvedSessionId, queued);
      try {
        await previousQueued;
        assertBinding();
        turn = createPromptTurn(queued, releaseQueued, open.slot.client, open.lease, internal?.retainTask === true);
        promptTurnsBySession.set(resolvedSessionId, turn);
      } catch (error) {
        completePromptQueue(resolvedSessionId, queued, releaseQueued);
        throw error;
      }
    }

    try {
    if (behavior !== 'prompt') {
      const activeTurn = promptTurnsBySession.get(resolvedSessionId);
      if (!activeTurn || !activeTurn.readyForSettled
        || (!activeTurn.admission && rt.security?.taskLifecycle)
        || activeTurn.client !== open.slot.client || activeTurn.lease !== open.lease) {
        throw new Error(`session ${resolvedSessionId} has no current prompt turn`);
      }
      queuedAdmission = activeTurn.admission;
      assertBinding();
      if (queuedAdmission) rt.security?.taskLifecycle.assertCurrentAdmission?.(resolvedSessionId, queuedAdmission);
    }
    const startedTask = internal?.expectedAdmission
      ? { admission: internal.expectedAdmission, grant: rt.security?.taskLifecycle.active(resolvedSessionId) }
      : behavior === 'prompt'
        ? await startSessionTask(resolvedSessionId, open.profileId, true, assertBinding)
        : { admission: queuedAdmission, grant: queuedAdmission ? rt.security?.taskLifecycle.active(resolvedSessionId) : undefined };
    const promptAdmission = startedTask.admission;
    if (internal?.expectedAdmission && promptAdmission !== internal.expectedAdmission) {
      throw new Error(`session ${resolvedSessionId} workflow admission is no longer current`);
    }
    const promptTaskId = startedTask.grant?.taskId ?? captureTaskOwner(resolvedSessionId)?.taskId;
    const assertPromptOwnership = (): void => {
      assertBinding();
      // A correlated terminal may end this admission before the prompt command's
      // response/post-send state read resumes. That is this turn's own completion,
      // not a replacement; never apply the exception once the turn is removed.
      if (turn?.terminal && promptTurnsBySession.get(resolvedSessionId) === turn) return;
      if (promptAdmission) {
        rt.security?.taskLifecycle.assertCurrentAdmission?.(resolvedSessionId, promptAdmission);
      }
      if (promptTaskId && typeof rt.security?.taskLifecycle.assertOwner === 'function') {
        rt.security.taskLifecycle.assertOwner(resolvedSessionId, { taskId: promptTaskId, admission: promptAdmission });
      } else if (promptTaskId && rt.security?.taskLifecycle.active(resolvedSessionId)?.taskId !== promptTaskId) {
        throw new Error(`session ${resolvedSessionId} prompt task is no longer active`);
      }
    };
    assertPromptOwnership();
    // A new prompt starts a new Task, so the Reviewer only ever sees the prompt
    // that owns the current Task. steer/followUp keep the existing one.
    if (behavior === 'prompt') {
      userTaskBySession.set(resolvedSessionId, text.slice(0, REVIEWER_USER_TASK_LIMIT));
    }

    if (turn) {
      turn.taskId = promptTaskId;
      turn.admission = promptAdmission;
      turn.readyForSettled = Boolean(promptTaskId) || !rt.security?.taskLifecycle;
      runtimeOrigins.set(turn.originToken, {
        sessionId: resolvedSessionId,
        client: open.slot.client,
        lease: open.lease,
        taskId: promptTaskId,
        admission: promptAdmission,
      });
    }

    if (behavior === 'steer') {
      assertPromptOwnership();
      const resp = await open.slot.client.send(images.length
        ? { type: 'steer', message: finalText, images, originToken: promptTurnsBySession.get(resolvedSessionId)?.originToken }
        : { type: 'steer', message: finalText, originToken: promptTurnsBySession.get(resolvedSessionId)?.originToken });
      assertPromptOwnership();
      if (!resp.success) throw new Error(resp.error ?? 'steer failed');
    } else if (behavior === 'followUp') {
      assertPromptOwnership();
      const resp = await open.slot.client.send(images.length
        ? { type: 'follow_up', message: finalText, images, promptId: promptTurnsBySession.get(resolvedSessionId)?.promptId, originToken: promptTurnsBySession.get(resolvedSessionId)?.originToken }
        : { type: 'follow_up', message: finalText, promptId: promptTurnsBySession.get(resolvedSessionId)?.promptId, originToken: promptTurnsBySession.get(resolvedSessionId)?.originToken });
      assertPromptOwnership();
      if (!resp.success) throw new Error(resp.error ?? 'follow_up failed');
    } else {
      const knowledge = knowledgeFromManifest(rt.profileOf(open.profileId).profile.manifest);
      // 每轮开始重置该会话的接地状态：两个远端后端都要重置。
      if (knowledge.backend !== 'bm25') {
        assertPromptOwnership();
        groundingTurns.set(resolvedSessionId, resetTurn());
      }
      assertPromptOwnership();
      // Once the command is attempted, a transport rejection is ambiguous: the
      // runtime may already be running the turn even though no response arrived.
      promptMayBeRunning = true;
      internal?.onPromptSend?.();
      const resp = await open.slot.client.send(images.length
        ? { type: 'prompt', message: finalText, images, promptId: turn?.promptId, originToken: turn?.originToken }
        : { type: 'prompt', message: finalText, promptId: turn?.promptId, originToken: turn?.originToken });
      if (!resp.success) promptMayBeRunning = false;
      assertPromptOwnership();
      if (!resp.success) throw new Error(resp.error ?? 'prompt failed');
    }
    const after = await open.slot.client.send({ type: 'get_state' });
    assertPromptOwnership();
    if ((after.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(resolvedSessionId, {
        piSessionFile: (after.data as { sessionFile: string }).sessionFile,
      });
    }
    assertPromptOwnership();
    return { ok: true, sessionId: resolvedSessionId, behavior: behavior === 'prompt' ? 'prompt' : behavior };
    } catch (error) {
      // A post-send failure is not a terminal event. Keep the serialization
      // barrier until an owned/cancelled settled arrives, abort confirms idle,
      // or the runtime binding is retired. Releasing it here lets a late settled
      // from this turn be attributed to the replacement.
      if (turn && !promptMayBeRunning) completePromptTurn(resolvedSessionId, turn);
      throw error;
    }
  };
  ipcMain.handle('sparkii:promptSession', promptSession);
  rt.promptTurn = (input) => promptSession(
    null, input.sessionId, input.text, { behavior: input.behavior ?? 'prompt' }, [],
    { allowDegradedKnowledge: true }, input,
  );

  ipcMain.handle('sparkii:abortChat', async (_e, sessionId: string) => {
    let capturedOpen = openSessions.get(sessionId);
    if (capturedOpen) {
      try { assertOpenBinding(sessionId, capturedOpen); } catch { capturedOpen = undefined; }
    }
    const capturedBinding = rt.pool.getBinding(sessionId);
    const capturedClient = capturedOpen?.slot.client ?? capturedBinding?.client;
    const capturedLease = capturedOpen?.lease ?? capturedBinding?.lease;
    const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    if (admission) await rt.security?.taskLifecycle.end(sessionId, 'user', admission);
    else await rt.security?.taskLifecycle.end(sessionId, 'user');
    const assertAbortCurrent = (target: OpenSession): void => {
      if (rt.security?.taskLifecycle.currentAdmission?.(sessionId) !== undefined) {
        throw new Error(`session ${sessionId} admission is no longer current`);
      }
      assertCapturedBinding(sessionId, target, capturedClient, capturedLease);
    };
    assertCapturedBinding(sessionId, capturedOpen, capturedClient, capturedLease);
    await getDocumentParseSupervisor().failSession(sessionId);
    assertCapturedBinding(sessionId, capturedOpen, capturedClient, capturedLease);
    const open = capturedOpen ?? await ensureOpenSession(sessionId);
    assertAbortCurrent(open);
    ensureProcessPipe(open.slot);
    const cleared = await readQueues(open);
    assertAbortCurrent(open);

    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    assertAbortCurrent(open);
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    const abortResp = await open.slot.client.send({ type: 'abort' });
    assertAbortCurrent(open);
    if (!abortResp.success) throw new Error(abortResp.error ?? 'abort failed');
    await waitForIdle(open.slot.client);
    assertAbortCurrent(open);
    if (capturedClient && capturedLease !== undefined) {
      completePromptTurnForBinding(sessionId, capturedClient, capturedLease, admission);
    }
    return { ok: true, cleared };
  });

  ipcMain.handle('sparkii:getChatState', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) {
      return {
        streaming: false,
        steering: [],
        followUp: [],
        isCompacting: false,
        contextUsage: null,
      };
    }
    ensureProcessPipe(open.slot);
    const resp = await open.slot.client.send({ type: 'get_state' });
    if (!resp.success) throw new Error(resp.error ?? 'get_state failed');
    const data = chatStateData(resp.data);
    return {
      streaming: data.isStreaming ?? data.streaming ?? false,
      steering: data.steering ?? [],
      followUp: data.followUp ?? [],
      isCompacting: data.isCompacting ?? false,
      contextUsage: data.contextUsage ?? null,
    };
  });

  ipcMain.handle('sparkii:queueMutate', async (_e, sessionId: string, mutation: QueueMutation) => {
    const open = await ensureOpenSession(sessionId);
    const assertBinding = (): void => assertOpenBinding(sessionId, open);
    assertBinding();
    const activeTurn = promptTurnsBySession.get(sessionId);
    if (!activeTurn?.readyForSettled
      || (!activeTurn.admission && rt.security?.taskLifecycle)
      || activeTurn.client !== open.slot.client || activeTurn.lease !== open.lease) {
      throw new Error(`session ${sessionId} has no current prompt turn`);
    }
    if (activeTurn.admission) rt.security?.taskLifecycle.assertCurrentAdmission?.(sessionId, activeTurn.admission);
    ensureProcessPipe(open.slot);
    const snapshot = await readQueues(open);
    assertBinding();
    const next = mutateQueues(snapshot, mutation);

    assertBinding();
    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    assertBinding();
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    await rebuildQueues(open.slot.client, next, assertBinding, activeTurn.originToken, activeTurn.promptId);
    return { ok: true, steering: next.steering, followUp: next.followUp };
  });

  ipcMain.handle('sparkii:setChatTitle', async (_e, sessionId: string, title: string, source?: 'user' | 'agent') => {
    const trimmed = String(title ?? '').trim();
    if (!trimmed) return { ok: false };
    if (stoppingSessions.has(sessionId)) return { ok: false };
    const origin = source === 'user' ? 'user' : 'agent';
    const rec = rt.chatSessions.get(sessionId);
    if (origin === 'agent' && rec?.titleLockedByUser) return { ok: false, reason: 'locked' };
    if (origin === 'user' && rec) {
      rt.chatSessions.update(sessionId, { titleLockedByUser: true });
    }
    getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_title', sessionId, title: trimmed });
    rt.pool.updateMeta(sessionId, { label: trimmed });
    if (!rec) return { ok: true };
    try {
      const open = await ensureOpenSession(sessionId);
      if (stoppingSessions.has(sessionId)) return { ok: false };
      assertOpenBinding(sessionId, open);
      rt.pool.updateMeta(sessionId, { label: trimmed });
      await open.slot.client.send({ type: 'set_session_name', name: trimmed });
    } catch {
      return { ok: true };
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:completeText', async (_e, sessionId: string, text: string) => {
    const open = await ensureOpenSession(sessionId);
    const assertBinding = (): void => assertOpenBinding(sessionId, open);
    assertBinding();
    const settings = await loadSettings(rt.dataDir);
    assertBinding();
    const target = resolveModelTarget(settings, 'title') ?? resolveModelTarget(settings, 'default');
    if (!target) return { ok: false };
    assertBinding();
    const resp = await open.slot.client.send({
      type: 'complete',
      provider: target.provider,
      modelId: target.modelId,
      text: String(text ?? ''),
    });
    assertBinding();
    if (!resp.success) return { ok: false };
    const out = String(resp.data ?? '').trim();
    return out ? { ok: true, text: out } : { ok: false };
  });

  ipcMain.handle('sparkii:setChatModel', async (_e, sessionId: string, model: string | null) => {
    const open = openSessions.get(sessionId);
    const assertBinding = (): void => {
      if (open) assertOpenBinding(sessionId, open);
    };
    const settings = await loadSettings(rt.dataDir);
    assertBinding();
    const target = resolveSessionModel(settings, { model });
    if (open) {
      assertBinding();
      ensureProcessPipe(open.slot);
      if (target) {
        const applied = appliedModelBySession.get(sessionId);
        const changed = !applied || applied.provider !== target.provider || applied.modelId !== target.modelId;
        if (changed) {
          assertBinding();
          await selectModel(rt, 'chat', sessionId, `${target.provider}/${target.modelId}`, assertBinding);
          assertBinding();
          appliedModelBySession.set(sessionId, target);
          getWindow()?.webContents.send('sparkii:event:chat-event', {
            type: 'model_change',
            sessionId,
            provider: target.provider,
            modelId: target.modelId,
          });
        }
      }
    }
    assertBinding();
    rt.chatSessions.update(sessionId, { model: target ? modelTargetKey(target) : null });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatThinkingLevel', async (_e, sessionId: string, level: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    const open = openSessions.get(sessionId);
    const binding = rt.pool.getBinding(sessionId);
    const client = open?.slot.client ?? binding?.client;
    const lease = open?.lease ?? binding?.lease;
    const assertBinding = (): void => assertCapturedBinding(sessionId, open, client, lease);
    assertBinding();
    if (open && level) {
      ensureProcessPipe(open.slot);
      assertBinding();
      const resp = await open.slot.client.send({ type: 'set_thinking_level', level });
      assertBinding();
      if (!resp.success) throw new Error(resp.error ?? 'set_thinking_level failed');
    }
    if (level) {
      const settings = await loadSettings(rt.dataDir);
      assertBinding();
      const target = resolveSessionModel(settings, rec);
      if (target) {
        const next = { ...(settings.modelThinkingLevels ?? {}), [`${target.provider}/${target.modelId}`]: level };
        assertBinding();
        await saveSettings(rt.dataDir, { ...settings, modelThinkingLevels: next });
        assertBinding();
      }
    }
    assertBinding();
    const current = rt.chatSessions.get(sessionId);
    if (!current || current.thinkingLevel !== rec.thinkingLevel) {
      throw new Error(`session ${sessionId} thinking level changed concurrently`);
    }
    rt.chatSessions.update(sessionId, { thinkingLevel: level });
    return { ok: true };
  });

  ipcMain.handle('sparkii:listThinkingLevels', async (_e, providerId: string, modelId: string) => {
    return withProbeSlot(async (client) => {
      await injectProbeKey(client, providerId);
      const modelResp = await client.send({ type: 'set_model', provider: providerId, modelId });
      if (!modelResp.success) throw new Error(modelResp.error ?? 'set_model failed');
      const resp = await client.send({ type: 'list_thinking_levels' });
      if (!resp.success) throw new Error(resp.error ?? 'list_thinking_levels failed');
      return (resp.data ?? []) as string[];
    });
  });

  ipcMain.handle('sparkii:setChatWorkspace', async (_e, sessionId: string, path: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    const open = openSessions.get(sessionId);
    const binding = rt.pool.getBinding(sessionId);
    const client = open?.slot.client ?? binding?.client;
    const lease = open?.lease ?? binding?.lease;
    const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    const assertCurrent = (allowCapturedAdmission = false): void => {
      assertCapturedBinding(sessionId, open, client, lease);
      const current = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
      if (allowCapturedAdmission ? current !== admission : current !== undefined) {
        throw new Error(`session ${sessionId} admission is no longer current`);
      }
    };
    assertCurrent(true);
    const previousSaddle = open ? buildSaddle(open.profileId, sessionId) : undefined;
    const nextWorkspacePath = path ?? allocateAutoWorkspace(app.getPath('documents'), rec.profileId).workspacePath;
    const nextWorkspaceKind = path ? 'user' as const : 'auto' as const;
    const nextSaddle = open ? buildAgentSaddle(
      rt.agentOf(open.profileId),
      anchorDir(sessionId),
      nextWorkspacePath,
      undefined,
      undefined,
      rt.memory?.buildBlock({
        sessionId,
        profileId: open.profileId,
        workspacePath: nextWorkspacePath,
        workspaceKind: nextWorkspaceKind,
      }),
      rt.memory?.getSettings().enabled === true,
    ) : undefined;
    if (admission) await rt.security?.taskLifecycle.end(sessionId, 'workspace-changed', admission);
    else await rt.security?.taskLifecycle.end(sessionId, 'workspace-changed');
    assertCurrent();
    if (open && nextSaddle) {
      assertCurrent();
      const resp = await open.slot.client.send({ type: 'configure_session', saddle: nextSaddle });
      assertCurrent();
      if (!resp.success) throw new Error(`configure_session failed: ${resp.error ?? 'unknown'}`);
    }
    assertCurrent();
    const current = rt.chatSessions.get(sessionId);
    if (!current || current.workspacePath !== rec.workspacePath || current.workspaceKind !== rec.workspaceKind) {
      if (open && previousSaddle) {
        assertCurrent();
        await open.slot.client.send({ type: 'configure_session', saddle: previousSaddle });
        assertCurrent();
      }
      throw new Error(`session ${sessionId} workspace changed concurrently`);
    }
    rt.chatSessions.update(sessionId, { workspaceKind: nextWorkspaceKind, workspacePath: nextWorkspacePath });
    return { ok: true };
  });

  // ── P10: generic workspace-root relocation (no bid-writing branch) ────────
  // Moves a session's fixed workspace to a user-chosen empty directory while
  // keeping sessionId stable (chat history, KB bindings and T1 index follow).
  // The ordered 12-step core lives in workspace-relocation.ts; this handler
  // wires platform facts (store/slots/security) and broadcasts the result.
  ipcMain.handle('sparkii:relocateWorkspace', async (
    _e,
    sessionId: string,
    newPath: string,
  ): Promise<RelocateResult> => {
    const security = rt.security;
    if (!security) {
      return { ok: false, code: 'ADMISSION_FAILED', reason: 'security layer unavailable' };
    }
    const capturedOpen = openSessions.get(sessionId);
    const capturedBinding = rt.pool.getBinding(sessionId);
    const capturedClient = capturedOpen?.slot.client ?? capturedBinding?.client;
    const capturedLease = capturedOpen?.lease ?? capturedBinding?.lease;
    const assertBinding = (): void => assertCapturedBinding(sessionId, capturedOpen, capturedClient, capturedLease);
    assertBinding();
    const result = await relocateWorkspace(
      { sessionId: String(sessionId ?? ''), newPath: String(newPath ?? ''), workspaceKind: 'user' },
      {
        getSession: (id) => rt.chatSessions.get(id),
        sessionsByWorkspace: (wp) => {
          assertBinding();
          return rt.chatSessions.list().filter((r) => r.workspacePath === wp)
            .map((r) => ({ id: r.id, profileId: r.profileId, open: openSessions.has(r.id) }));
        },
        updateWorkspacePathInTransaction: (oldPath, nextPath, kind) => {
          assertBinding();
          rt.chatSessions.updateWorkspacePathInTransaction(oldPath, nextPath, kind);
        },
        isIdle: (id) => security ? security.taskLifecycle.active(id) === undefined : true,
        configureSession: async (id, profileId) => {
          assertBinding();
          if (!capturedOpen) return;
          const resp = await capturedOpen.slot.client.send({
            type: 'configure_session',
            saddle: buildSaddle(profileId, id),
          });
          assertBinding();
          if (!resp.success) throw new Error(resp.error ?? 'configure_session failed');
        },
        pathProbe: security.pathProbe,
        protectedRoots: security.protectedRoots,
        audit: (event) => rt.audit.append(event as never),
        actor: rt.subject?.userId ?? 'agent',
      },
    );
    if (result.ok) {
      assertBinding();
      // 跨窗口状态同步：其他窗口的 activeProject.workspacePath 仍是旧值，
      // 需强制 refreshProjects，否则后续 writeProject 会把旧路径写回。
      getWindow()?.webContents.send('sparkii:event:workspace-relocated', {
        sessionId,
        workspacePath: result.workspacePath,
      });
    }
    return result;
  });

  ipcMain.handle('sparkii:updateWorkflowState', async (_e, sessionId: string, entry: Record<string, unknown>) => {
    const open = await ensureOpenSession(sessionId);
    const assertBinding = (): void => assertCapturedBinding(sessionId, open, open.slot.client, open.lease);
    assertBinding();
    ensureProcessPipe(open.slot);
    assertBinding();
    const resp = await open.slot.client.send({
      type: 'append_workflow_entry',
      customType: 'workflow_state',
      data: entry,
    });
    assertBinding();
    if (!resp.success) throw new Error(resp.error ?? 'append workflow_state failed');
    if (!hasCurrentWorkflowRun(sessionId)) scheduleIdleRelease(sessionId);
    return { ok: true };
  });

  ipcMain.handle('sparkii:requestExportReport', async (_e, sessionId: string, summary: Record<string, unknown>) => {
    const open = await ensureOpenSession(sessionId);
    assertOpenBinding(sessionId, open);
    ensureProcessPipe(open.slot);
    const { grant, admission } = await startSessionTask(sessionId, open.profileId, true, () => assertCapturedBinding(sessionId, open, open.slot.client, open.lease));
    const assertBinding = (): void => {
      assertCapturedBinding(sessionId, open, open.slot.client, open.lease);
      if (admission) rt.security?.taskLifecycle.assertCurrentAdmission?.(sessionId, admission);
    };
    assertBinding();
    try {
      const d = await broker.route(connectorWriteProposal('report.export', summary, {
        requestId: randomUUID(),
        risk: 'write',
      }), { sessionId, profileId: open.profileId, taskId: grant?.taskId, admission }, assertBinding);
      assertBinding();
      if (d.approved) {
        assertBinding();
        const resp = await open.slot.client.send({
          type: 'append_workflow_entry',
          customType: 'workflow_state',
          data: { stepId: 'report', action: 'report_exported', at: new Date().toISOString(), ...summary },
        });
        assertBinding();
        if (!resp.success) throw new Error(resp.error ?? 'append workflow_state failed');
      }
      if (!hasCurrentWorkflowRun(sessionId)) scheduleIdleRelease(sessionId);
      return { ok: true, approved: d.approved };
    } catch (error) {
      if (grant) await rt.security?.taskLifecycle.revokeTask(grant.taskId, 'runtime-released', admission);
      throw error;
    }
  });

  ipcMain.handle('sparkii:allocateAutoWorkspace', (_e, agentId: string) => {
    assertAgentId(agentId);
    if (!rt.agents.has(agentId) && !rt.profiles.has(agentId)) throw new Error('unknown agent');
    return { workspacePath: allocateAutoWorkspace(app.getPath('documents'), agentId).workspacePath };
  });

  ipcMain.handle('sparkii:chooseWorkspace', async (_e, opts?: { defaultPath?: string }) => {
    const defaultPath = String(opts?.defaultPath ?? '').trim();
    const dialogOpts: { properties: ['openDirectory']; defaultPath?: string } = { properties: ['openDirectory'] };
    const win = getWindow();
    if (!win) return {};
    if (defaultPath && isAbsolute(defaultPath)) {
      await ensureWorkspaceDir(defaultPath);
      dialogOpts.defaultPath = defaultPath;
    }
    const result = await dialog.showOpenDialog(win, dialogOpts);
    return result.canceled ? {} : { path: result.filePaths[0] };
  });

  ipcMain.handle('sparkii:openWorkspace', async (_e, path?: string) => {
    const target = String(path ?? '').trim();
    if (!target || !isAbsolute(target)) return { ok: false };
    await ensureWorkspaceDir(target);
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('sparkii:listUserSkills', async () => {
    const agent = userLibraryAgent(rt);
    if (!agent) return { agent: null, skills: [] };
    return {
      agent: { id: agent.id, name: agent.manifest.displayName ?? agent.id },
      skills: await listUserSkills(agent.skillsDir),
    };
  });

  ipcMain.handle('sparkii:listAgentSkills', async (_e, agentId: string) => {
    const agent = rt.agents.get(String(agentId ?? ''));
    if (!agent) return { skills: [] };
    return { skills: await listUserSkills(agent.skillsDir) };
  });

  ipcMain.handle('sparkii:previewUserSkill', async (_e, sourceDir: string) => {
    return previewUserSkill(String(sourceDir ?? ''));
  });

  ipcMain.handle('sparkii:chooseSkillFolder', async () => {
    const e2e = process.env.SPARKII_E2E_SKILL_DIR;
    if (e2e) return { path: e2e };
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? {} : { path: result.filePaths[0] };
  });

  ipcMain.handle('sparkii:importUserSkill', async (_e, opts: { sourceDir?: string; overwrite?: boolean } = {}) => {
    const agent = userLibraryAgent(rt);
    if (!agent) return { ok: false, reason: 'no-user-library' };
    const sourceDir = String(opts.sourceDir ?? '');
    const result = await importUserSkill(agent.skillsDir, sourceDir, { overwrite: opts.overwrite });
    if (result.ok) {
      await rt.audit.append({
        actor: rt.subject.userId,
        action: 'skill.installed',
        resource: result.name,
        payloadSummary: sourceDir,
      });
    }
    return result;
  });

  ipcMain.handle('sparkii:uninstallUserSkill', async (_e, opts: { name?: string } = {}) => {
    const agent = userLibraryAgent(rt);
    if (!agent) return { ok: false, reason: 'no-user-library' };
    const name = String(opts.name ?? '');
    const result = await uninstallUserSkill(agent.skillsDir, name);
    if (result.ok) {
      await rt.audit.append({
        actor: rt.subject.userId,
        action: 'skill.uninstalled',
        resource: name,
        payloadSummary: name,
      });
    }
    return result;
  });

  ipcMain.handle('sparkii:openUserSkillsDir', async () => {
    const agent = userLibraryAgent(rt);
    if (!agent) return { ok: false, reason: 'no-user-library' };
    await mkdir(agent.skillsDir, { recursive: true });
    try {
      await shell.openPath(agent.skillsDir);
    } catch {
      /* headless / E2E: still return the path */
    }
    return { ok: true, path: agent.skillsDir };
  });

  ipcMain.handle('sparkii:getModelOptions', async (_e, agentId?: string) => {
    const settings = await loadSettings(rt.dataDir);
    const providerId = settings.activeProviderId ?? 'deepseek';
    const modelEntries = await withProbeSlot(async (client) => {
      await injectProbeKey(client, providerId);
      const resp = await client.send({ type: 'list_models', provider: providerId });
      if (!resp.success) return [] as Array<{ modelId: string; supportsImages?: boolean }>;
      return (resp.data ?? []) as Array<{ modelId: string; supportsImages?: boolean }>;
    }).catch(() => [] as Array<{ modelId: string; supportsImages?: boolean }>);
    const models = modelEntries.map((m) => m.modelId);
    const supportsImages: Record<string, boolean> = {};
    for (const m of modelEntries) supportsImages[m.modelId] = m.supportsImages ?? false;
    const requirements = agentId
      ? (rt.agentOf(agentId).manifest.modelRequirements ?? { requires: ['chat'] })
      : { requires: ['chat'] };
    const descriptors = modelEntries.map((m) => ({
      provider: providerId,
      modelId: m.modelId,
      capabilities: MODEL_CAPABILITY_DEFAULTS[m.modelId]
        ?? ([
          'chat',
          'toolCall',
          ...(m.supportsImages ? ['vision' as const] : []),
        ] as ModelCapability[]),
    }));
    const compatible = findCompatibleModels(descriptors, requirements);
    const compatibleSet = new Set(compatible.map((m) => m.modelId));
    return {
      defaultModel: settings.defaultModel ?? null,
      models,
      provider: providerId,
      supportsImages,
      modelRequirements: requirements,
      compatibleModels: models.filter((modelId) => compatibleSet.has(modelId)),
      incompatibleModels: models.filter((modelId) => !compatibleSet.has(modelId)),
    };
  });

  async function withSessionDeletion<T>(sessionId: string, commit: () => T | Promise<T>, keepTombstoneOnFailure?: () => boolean): Promise<T | undefined> {
    const existing = deletionPromises.get(sessionId);
    if (existing) {
      await existing;
      return undefined;
    }
    deletionTombstones.add(sessionId);
    let retained = false;
    const deletion = (async () => {
      try {
        if (!await stopSessionRuntime(sessionId)) throw new Error('会话在删除期间被重新绑定');
        return await commit();
      } catch (error) {
        retained = keepTombstoneOnFailure?.() === true;
        throw error;
      }
    })().finally(() => {
      if (deletionPromises.get(sessionId) === deletion) deletionPromises.delete(sessionId);
      if (!retained) deletionTombstones.delete(sessionId);
    });
    deletionPromises.set(sessionId, deletion);
    return deletion;
  }

  function stopSessionRuntime(sessionId: string): Promise<boolean> {
    const existing = sessionStopPromises.get(sessionId);
    if (existing) return existing;
    stoppingSessions.add(sessionId);
    sessionOpenEpochs.set(sessionId, (sessionOpenEpochs.get(sessionId) ?? 0) + 1);
    // Capture before cancellation: waitForAcquire must include a bind already in
    // flight, not only acquisitions queued behind the current binding.
    const acquisition = rt.pool.waitForAcquire(sessionId);
    rt.pool.cancelAcquire(sessionId);
    const stopping = stopSessionRuntimeOwned(sessionId, acquisition).finally(() => {
      if (sessionStopPromises.get(sessionId) === stopping) sessionStopPromises.delete(sessionId);
      stoppingSessions.delete(sessionId);
    });
    sessionStopPromises.set(sessionId, stopping);
    return stopping;
  }

  async function stopSessionRuntimeOwned(sessionId: string, acquisition?: Promise<void>): Promise<boolean> {
    // A cancelled opening may still be inside switch_session. Its pool promise
    // settles only after the child is reset or confirmed exited.
    await acquisition;
    const binding = rt.pool.getBinding(sessionId);
    const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    const ownsBinding = (): boolean => {
      const current = rt.pool.getBinding(sessionId);
      return current?.client === binding?.client && current?.lease === binding?.lease;
    };
    const ownsStoppedTask = (): boolean => ownsBinding()
      && rt.security?.taskLifecycle.currentAdmission?.(sessionId) === undefined;
    const lostBinding = (): false => {
      memoryExtraction?.cancel(sessionId);
      return false;
    };
    cancelIdleRelease(sessionId);
    if (binding) {
      if (!ownsBinding()) return lostBinding();
      if (admission) await rt.security?.taskLifecycle.end(sessionId, 'session-ended', admission);
      else await rt.security?.taskLifecycle.end(sessionId, 'session-ended');
      if (!ownsStoppedTask()) return lostBinding();
      await getDocumentParseSupervisor().failSession(sessionId);
      if (!ownsStoppedTask()) return lostBinding();
      const open = openSessions.get(sessionId);
      if (open && open.lease === binding.lease && openSessions.get(sessionId) === open) {
        const state = await open.slot.client.send({ type: 'get_state' }).catch(() => undefined);
        if (!ownsStoppedTask()) return lostBinding();
        if (state?.success && (state.data as { sessionFile?: string } | undefined)?.sessionFile) {
          rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
        }
      }
      await unbindAndRelease(sessionId, binding.lease, admission);
      if (open && openSessions.get(sessionId) === open && !rt.pool.getBinding(sessionId)) {
        openSessions.delete(sessionId);
        appliedModelBySession.delete(sessionId);
      }
    } else {
      if (admission) await rt.security?.taskLifecycle.end(sessionId, 'session-ended', admission);
      else await rt.security?.taskLifecycle.end(sessionId, 'session-ended');
      if (!ownsStoppedTask()) return lostBinding();
      await getDocumentParseSupervisor().failSession(sessionId);
      cancelTransientWaiters(sessionId);
      completePromptTurnWithoutBinding(sessionId);
    }
    memoryExtraction?.cancel(sessionId);
    return !rt.pool.getBinding(sessionId);
  }

  ipcMain.handle('sparkii:deleteChatSession', async (_e, sessionId: string) => {
    const result = await withSessionDeletion(sessionId, async () => {
      const deletedSession = rt.chatSessions.get(sessionId);
      rt.memory?.markSourcesDeleted(sessionId, deletedSession?.workspacePath);
      rt.chatSessions.delete(sessionId);
      try {
        const found = (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
        if (found) await rm(found.path, { force: true });
      } catch { /* ignore */ }
      return { ok: true };
    });
    return result ?? { ok: true };
  });

  async function ensureSessionRecord(sessionId: string, profileId?: string) {
    if (rt.chatSessions.get(sessionId)) return;
    if (!profileId) return;
    const found = (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
    if (!found) return;
    rt.chatSessions.create({ id: sessionId, profileId, workspaceKind: 'auto', workspacePath: found.cwd });
  }

  ipcMain.handle('sparkii:setSessionPinned', async (_e, sessionId: string, pinned: boolean, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    rt.chatSessions.update(sessionId, { pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setSessionArchived', async (_e, sessionId: string, archived: boolean, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    rt.chatSessions.update(sessionId, { archived: !!archived });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setSessionOrder', async (_e, sessionId: string, sortOrder: number | null, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    if (!rt.chatSessions.get(sessionId)) return { ok: true };
    rt.chatSessions.update(sessionId, { sortOrder: sortOrder });
    return { ok: true };
  });

  ipcMain.handle('sparkii:getRuntimePool', () => rt.pool.snapshot());

  ipcMain.handle('sparkii:getDocumentParse', () => getDocumentParseSupervisor().snapshot());
  ipcMain.handle('sparkii:stopDocumentParse', () => getDocumentParseSupervisor().stopCurrent());
  ipcMain.handle('sparkii:releaseDocumentParse', () => getDocumentParseSupervisor().release());
  ipcMain.handle('sparkii:cancelDocumentParseLoad', () => getDocumentParseSupervisor().stopCurrent());
  ipcMain.handle('sparkii:saveDocumentParseSettings', async (_e, partial: { idleMinutes?: number; keepResident?: boolean } = {}) => {
    const next = await saveDocumentParseSettings(rt.dataDir, {
      idleMinutes: partial.idleMinutes,
      keepResident: partial.keepResident,
    });
    const supervisor = getDocumentParseSupervisor();
    supervisor.setIdleMinutes(next.idleMinutes);
    supervisor.setKeepResident(next.keepResident);
    supervisor.clearCircuit();
    return { ok: true };
  });
  ipcMain.handle('sparkii:retryDocumentParse', async () => {
    getDocumentParseSupervisor().clearCircuit();
    return { ok: true };
  });
  ipcMain.handle('sparkii:listDocumentParseModules', () => listDocumentParseModules());
  ipcMain.handle('sparkii:importDocumentParseModule', async (_e, path?: string) => {
    let filePath = typeof path === 'string' && path.trim() ? path : '';
    if (!filePath) {
      const win = getWindow();
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory'] })
        : { canceled: true, filePaths: [] as string[] };
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      filePath = result.filePaths[0];
    }
    try {
      await importDocumentParseModule(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('sparkii:downloadDocumentParseModule', async (_e, id: string) => {
    try {
      await downloadDocumentParseModule(String(id ?? ''));
      return { ok: true };
    } catch {
      return { ok: false, error: DOWNLOAD_UNREACHABLE };
    }
  });

  ipcMain.handle('sparkii:cancelQueuedSession', (_e, queueId: string) => {
    if (!rt.pool.cancelPending(queueId)) throw new Error('queue item not found');
    return { ok: true };
  });

  async function releaseSessionSlotInternal(sessionId: string): Promise<void> {
    const binding = rt.pool.getBinding(sessionId);
    if (!binding) {
      cancelTransientWaiters(sessionId);
      completePromptTurnWithoutBinding(sessionId);
      throw new Error('session is not occupying a runtime slot');
    }
    const ownsBinding = (): boolean => {
      const current = rt.pool.getBinding(sessionId);
      return current?.client === binding.client && current.lease === binding.lease;
    };
    const open = openSessions.get(sessionId);
    const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    const ownsTask = (): boolean => rt.security?.taskLifecycle.currentAdmission?.(sessionId) === undefined;
    cancelIdleRelease(sessionId);
    if (!ownsBinding()) throw new Error('session is not occupying a runtime slot');
    if (admission) await rt.security?.taskLifecycle.end(sessionId, 'runtime-released', admission);
    else await rt.security?.taskLifecycle.end(sessionId, 'runtime-released');
    if (!ownsBinding() || !ownsTask()) return;
    await getDocumentParseSupervisor().failSession(sessionId);
    if (!ownsBinding() || !ownsTask()) return;
    if (open && open.lease === binding.lease && openSessions.get(sessionId) === open) {
      const state = await open.slot.client.send({ type: 'get_state' }).catch(() => undefined);
      if (!ownsBinding() || !ownsTask()) return;
      if (state?.success && (state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, {
          piSessionFile: (state.data as { sessionFile: string }).sessionFile,
        });
      }
    }
    await unbindAndRelease(sessionId, binding.lease, admission);
    if (open && openSessions.get(sessionId) === open) {
      openSessions.delete(sessionId);
      appliedModelBySession.delete(sessionId);
    }
  }

  ipcMain.handle('sparkii:releaseSessionSlot', async (_e, sessionId: string) => {
    await releaseSessionSlotInternal(sessionId);
    return { ok: true };
  });

  ipcMain.handle('sparkii:getLocalSubject', () => ({
    userId: rt.subject.userId,
    roles: rt.subject.roles,
  }));
  ipcMain.handle('sparkii:listAgents', () =>
    sortAgents([...rt.profiles.values()].map((pr) => ({
      id: pr.profile.manifest.name,
      name: pr.profile.manifest.name,
      displayName: pr.profile.manifest.displayName,
      sortOrder: pr.profile.manifest.sortOrder,
      surfaceType: rt.agentOf(pr.profile.manifest.name).manifest.surface.type,
      projectScoped: rt.agentOf(pr.profile.manifest.name).manifest.surface.projectScoped,
      capabilities: pr.profile.manifest.capabilities,
      knowledge: pr.profile.manifest.knowledge,
    }))),
  );
  ipcMain.handle('sparkii:probeOntologyGraph', async () => {
    const result = await executeOntologyTool({
      toolName: 'ontology.graph_summary',
      args: {},
      profileId: '',
      settings: await loadSettings(rt.dataDir),
      credential: await rt.knowledgeToken('sparkiionto'),
    });
    if (!result.ok) {
      return { ok: false, error: result.error?.message ?? '图谱自检失败' };
    }
    const summary = (result.data ?? {}) as {
      nodeCount?: number;
      edgeCount?: number;
      nodeTypes?: Record<string, number>;
    };
    return {
      ok: true,
      nodeCount: typeof summary.nodeCount === 'number' ? summary.nodeCount : 0,
      edgeCount: typeof summary.edgeCount === 'number' ? summary.edgeCount : 0,
      nodeTypes: summary.nodeTypes,
    };
  });
  ipcMain.handle('sparkii:chooseDocument', async (_e, opts?: ChooseDocumentOptions) => {
    if (process.env.SPARKII_E2E_DOCUMENT) {
      grantDocumentPath(process.env.SPARKII_E2E_DOCUMENT);
      return { path: process.env.SPARKII_E2E_DOCUMENT };
    }
    const extensions = Array.isArray(opts?.extensions) && opts.extensions.length
      ? opts.extensions.map((ext) => ext.replace(/^\./, '').toLowerCase())
      : [...DEFAULT_CHOOSE_EXTENSIONS];
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '文档', extensions }] })
      : { canceled: true, filePaths: [] as string[] };
    if (result.canceled || !result.filePaths[0]) return {};
    grantDocumentPath(result.filePaths[0]);
    return { path: result.filePaths[0] };
  });
  ipcMain.handle('sparkii:readDocumentBytes', async (_e, path: string, sessionId?: string | null) => {
    const rec = sessionId ? rt.chatSessions.get(sessionId) : null;
    return readGrantedDocumentBytes(String(path ?? ''), {
      inputs: parseSessionInputs(rec?.inputs),
      workspacePath: rec?.workspacePath ?? null,
    });
  });
  /**
   * 渲染层预览用文档解析（OCR/结构化）：与 agent 侧 `document.read` 走同一条
   * 解析管线（扫描版 PDF → structure 引擎 → OCR）。权限与 readDocumentBytes
   * 一致（已授权路径 / 会话输入 / 会话工作区），40MB 上限同源。
   */
  ipcMain.handle('sparkii:parseDocumentPreview', async (_e, path: string, sessionId?: string | null) => {
    const rec = sessionId ? rt.chatSessions.get(sessionId) : null;
    const access = {
      inputs: parseSessionInputs(rec?.inputs),
      workspacePath: rec?.workspacePath ?? null,
    };
    const granted = await readGrantedDocumentBytes(String(path ?? ''), access);
    if ('error' in granted) return granted;
    const result = await executeDocumentRead(
      { documents: [String(path ?? '')] },
      {
        profileId: rec?.profileId ?? 'system',
        sessionId: sessionId ?? '',
        actor: rt.subject.userId,
        agentDisplayName: rec?.profileId ?? 'preview',
      },
    );
    if (!result.ok) {
      return { ok: false as const, error: result.error?.message ?? '文档解析失败' };
    }
    const data = result.data as { text?: string; engine?: string; meta?: Record<string, unknown> };
    return {
      ok: true as const,
      text: typeof data?.text === 'string' ? data.text : '',
      engine: typeof data?.engine === 'string' ? data.engine : undefined,
      meta: data?.meta ?? {},
    };
  });
  ipcMain.handle('sparkii:listPendingApprovals', () => rt.gate.listPending());
  ipcMain.handle('sparkii:getPermissionModeState', (_e, agentId: string, sessionId?: string | null) => {
    const policy = rt.security?.profilePolicies.get(agentId);
    const rec = sessionId ? rt.chatSessions.get(sessionId) : null;
    const allowedModes = policy?.allowedPermissionModes ?? ['ask', 'auto_review'];
    let mode: PlatformPermissionMode = 'ask';
    try {
      mode = resolvePermissionMode({
        sessionId: sessionId ?? '',
        profileId: agentId,
        sessionMode: rec?.permissionMode,
        profileDefaultMode: policy?.defaultPermissionMode,
        allowedModes,
      });
    } catch {
      mode = 'ask';
    }
    return {
      mode,
      allowedModes,
      taskActive: Boolean(sessionId && rt.security?.taskLifecycle.active(sessionId)),
      hostShellAvailable: rt.security?.hostShellReport.status === 'available',
      reviewerAvailable: Boolean(rt.security?.reviewer) && !reviewerUnavailable,
      limitations: rt.security?.hostShellReport.limitations ?? ['平台安全层不可用'],
      ...(sessionId ? { lastReview: lastReviewBySession.get(sessionId) } : {}),
    };
  });
  ipcMain.handle('sparkii:setChatPermissionMode', async (
    _e,
    sessionId: string,
    mode: PlatformPermissionMode,
  ) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) return { ok: false, error: 'session not found' };
    const policy = rt.security?.profilePolicies.get(rec.profileId);
    if (!policy) return { ok: false, error: 'no security policy for this profile' };
    let resolved: PlatformPermissionMode;
    try {
      resolved = resolveSessionPermissionMode(sessionId, rec.profileId, policy, mode);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const previous = rec.permissionMode;
    // A mode change never retroactively cancels executed work, but the running
    // Task and its shell grant must not carry the old privilege level.
    const activeTask = rt.security?.taskLifecycle.active(sessionId);
    const admission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
    rt.chatSessions.update(sessionId, { permissionMode: resolved });
    if (activeTask) rt.security?.shellGrants.revoke(activeTask.taskId);
    await rt.security?.taskLifecycle.end(sessionId, 'permission-mode-changed', admission);
    await rt.audit.append({
      actor: rt.subject?.userId ?? 'agent',
      action: 'permission-mode.changed',
      resource: 'permission-mode',
      payloadSummary: JSON.stringify({
        from: previous,
        to: resolved,
        policyVersion: rt.security?.reviewerPolicyVersion,
      }).slice(0, 512),
      sessionId,
      taskId: activeTask?.taskId,
      ruleId: 'permission-mode.changed',
    });
    return { ok: true, mode: resolved };
  });
  ipcMain.handle('sparkii:decideApproval', async (
    _e,
    id: string,
    approved: boolean,
    note?: string,
    approvalScope?: 'once' | 'task',
  ) => {
    const expectedTaskId = broker.ownerTaskId(id);
    let out = await rt.gate.decide(id, rt.subject, approved, note, expectedTaskId);
    const decided = rt.gate.get(out.id);
    if (!decided || decided.privacyRedacted || (decided.status !== 'approved' && decided.status !== 'denied')) {
      broker.decide(out.id, { approved: false, status: 'denied' });
      return decided;
    }
    out = decided;
    if (out.status === 'approved') {
      try {
        broker.assertOwner(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out = { ...out, execution: { ok: false, error: message } };
        broker.decide(out.id, { approved: false, status: 'denied' });
        return out;
      }
    }
    let result: unknown;
    let executionBlocked = false;
    if (
      out.status === 'approved'
      && out.executionMode !== 'caller'
      && out.toolName !== 'workflow.approval'
    ) {
      if (out.toolName === 'report.export') {
        const payload = (out.payload ?? {}) as Record<string, unknown>;
        const suggested = typeof payload.path === 'string' && payload.path.trim() ? payload.path : undefined;
        const path = suggested ?? await resolveExportPath(getWindow, process.env, (win, opts) =>
          dialog.showSaveDialog(win as BrowserWindow, opts),
        );
        broker.assertOwner(id);
        if (path) {
          const canonical = approvedProposalForExecution(rt, out.id, out);
          const updated = canonical
            ? rt.gate.updateApprovedPayload(canonical, { ...payload, path })
            : undefined;
          if (!updated) {
            executionBlocked = true;
            out = rt.gate.get(out.id) ?? out;
          } else {
            out = updated;
          }
        } else {
          await rt.audit.append({ actor: rt.subject.userId, action: 'execution.blocked', resource: out.toolName });
          out.execution = { ok: false, error: 'export path canceled' };
        }
      }
      if (!executionBlocked && out.execution?.error !== 'export path canceled') {
        broker.assertOwner(id);
        if (rt.security) {
          let grant: TaskGrant | undefined;
          let action: SecurityAction | undefined;
          try {
            if (!expectedTaskId) throw new Error('approval has no owning task');
            grant = rt.security.taskLifecycle.assertActive(out.sessionId, expectedTaskId);
            broker.assertOwner(id);
            action = {
              id: out.id,
              subjectId: rt.subject.userId,
              taskId: grant.taskId,
              sessionId: out.sessionId,
              agentId: grant.agentId,
              profileId: out.profileId,
              toolName: out.toolName,
              capability: 'connector.invoke',
              approvalClass: 'human_required',
              resources: [{
                kind: 'connector',
                value: out.toolName,
                scope: 'external',
              }],
              payload: out.payload,
              payloadHash: out.payloadHash,
              risk: out.risk,
              reason: out.summary,
              externalEffect: 'connector',
            };
            const lease = rt.security.capabilityGateway.issue(action, grant);
            await rt.audit.append({
              actor: rt.subject.userId,
              action: 'gateway.lease-issued',
              resource: out.toolName,
              payloadSummary: lease.fingerprint,
              sessionId: out.sessionId,
              taskId: action.taskId,
              actionId: action.id,
              ruleId: 'gateway.lease',
              capability: action.capability,
              payloadHash: action.payloadHash,
              platform: process.platform,
              sandboxVersion: rt.security.hostShellReport.version,
              decision: 'approved',
            });
            broker.assertOwner(id);
            rt.security.taskLifecycle.assertActive(out.sessionId, expectedTaskId);
            const canonical = approvedProposalForExecution(rt, out.id, out);
            if (!canonical || !proposalMatchesConnectorAction(canonical, action)) {
              throw new Error('approval invalidated before gateway execution');
            }
            out = canonical;
            out = await rt.security.capabilityGateway.execute(
              action,
              lease.id,
              grant,
              async () => {
                broker.assertOwner(id);
                rt.security?.taskLifecycle.assertActive(out.sessionId, expectedTaskId);
                const current = approvedProposalForExecution(rt, out.id, out);
                if (!current || !action || !proposalMatchesConnectorAction(current, action)) {
                  throw new Error('approval invalidated before connector execution');
                }
                return rt.executor.execute(current, { actor: rt.subject.userId });
              },
            );
            result = out.execution?.result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            out.execution = { ok: false, error: message };
            await rt.audit.append({
              actor: rt.subject.userId,
              action: 'gateway.execution-blocked',
              resource: out.toolName,
              payloadSummary: message,
              sessionId: out.sessionId,
              taskId: grant?.taskId,
              actionId: action?.id,
              ruleId: 'gateway.execution-blocked',
              capability: action?.capability,
              payloadHash: action?.payloadHash,
              platform: process.platform,
              sandboxVersion: rt.security.hostShellReport.version,
              decision: 'failed',
            });
          }
        } else {
          const canonical = approvedProposalForExecution(rt, out.id, out);
          if (!canonical) {
            executionBlocked = true;
            out = rt.gate.get(out.id) ?? out;
          } else {
            out = await rt.executor.execute(canonical, { actor: rt.subject.userId });
            result = out.execution?.result;
          }
        }
      }
    }
    const current = rt.gate.get(out.id);
    const executionOk = !executionBlocked && out.execution?.ok !== false
      && Boolean(current && !current.privacyRedacted && (current.status === 'approved' || current.status === 'executed'));
    broker.decide(out.id, {
      approved: executionOk,
      status: executionOk ? out.status : current?.privacyRedacted ? 'denied' : 'failed',
      result: executionOk ? result : undefined,
      ...(approvalScope ? { approvalScope } : {}),
    });
    return executionOk ? out : current;
  });
  ipcMain.handle('sparkii:queryAudit', (_e, filter: object) => rt.audit.query(filter));
  ipcMain.handle('sparkii:getSettings', async () => {
    const settings = await loadSettings(rt.dataDir);
    const { rag: _storedRag, sparkiionto: _storedOnto, documentParse: _storedDp, ...rest } = settings;
    const apiKey = settings.activeProviderId ? await rt.keyFor(settings.activeProviderId) : null;
    const ragKey = await rt.keyFor('sparkiirag');
    const ontoToken = await rt.knowledgeToken('sparkiionto');
    return {
      ...rest,
      ...(apiKey ? { apiKey } : {}),
      rag: { ...ragFromSettings(settings), hasApiKey: Boolean(ragKey) },
      // 绝不回传 token：只回 hasToken。
      sparkiionto: { ...knowledgeBackendSettings('sparkiionto', settings), hasToken: Boolean(ontoToken) },
      documentParse: documentParseFromSettings(settings),
    };
  });
  ipcMain.handle('sparkii:getApiKey', (_e, providerId: string) => {
    if (isReservedKnowledgeProviderId(providerId)) return null;
    return rt.keyFor(providerId);
  });
  ipcMain.handle('sparkii:listProviders', async () => {
    const settings = await loadSettings(rt.dataDir);
    const runtimeProviders = await withProbeSlot(async (client) => {
      const resp = await client.send({ type: 'list_providers' });
      if (!resp.success) throw new Error(resp.error ?? 'list_providers failed');
      return (resp.data ?? []) as PiProviderInfo[];
    });
    return buildProviderList(runtimeProviders, settings.providers ?? []);
  });
  ipcMain.handle('sparkii:saveSettings', async (_e, settings: unknown) => {
    const s = settings as Parameters<typeof saveSettings>[1] & {
      apiKey?: string;
      rag?: unknown;
      sparkiionto?: unknown;
      documentParse?: unknown;
    };
    // 唯一持久化自定义服务商的路径：知识后端的凭据 id 是保留名，撞名会让 keyFor 读到知识凭据。
    const conflict = findReservedProviderConflict(s.providers);
    if (conflict) {
      return {
        ok: false,
        error: `自定义服务商 id "${conflict}" 是知识后端保留名（sparkiirag / sparkiionto），请改用其它 id`,
      };
    }
    const { apiKey, rag: _dropRag, sparkiionto: _dropOnto, documentParse: _dropDp, ...rest } = s;
    const prev = await loadSettings(rt.dataDir);
    await saveSettings(rt.dataDir, {
      ...prev,
      ...rest,
      rag: prev.rag,
      sparkiionto: prev.sparkiionto,
      documentParse: prev.documentParse,
    });
    if (rest.logLevel) logger.level = rest.logLevel;
    if (s.activeProviderId) {
      await rt.setKey(s.activeProviderId, apiKey ?? '');
      await rt.pool.broadcast(
        apiKey
          ? { type: 'set_api_key', provider: s.activeProviderId, apiKey }
          : { type: 'remove_api_key', provider: s.activeProviderId },
      );
    }
    await writePiModelsConfig(rt.piAgentDir, s.providers ?? []);
    return { ok: true };
  });
  ipcMain.handle('sparkii:saveKnowledgeSettings', async (_e, backend: string, partial: KnowledgeSettingsPartial = {}) => {
    if (!isKnowledgeBackendId(backend)) return { ok: false, error: `未知知识后端：${backend || '（空）'}` };
    const next = partial ?? {};
    // 写严格：只在用户真的提供地址时校验，空地址沿用既有值。
    if (typeof next.baseUrl === 'string' && next.baseUrl.trim()) {
      const check = checkKnowledgeBaseUrl(next.baseUrl);
      if (!check.ok) return { ok: false, error: `知识库地址无效：${check.reason}` };
    }
    await patchKnowledgeSettings(rt.dataDir, backend, {
      baseUrl: next.baseUrl,
      similarityThreshold: next.similarityThreshold,
      vectorSimilarityWeight: next.vectorSimilarityWeight,
      bindings: next.bindings,
    });
    const token = typeof next.apiKey === 'string' ? next.apiKey.trim() : '';
    if (token) await rt.setKnowledgeToken(backend, token);
    return { ok: true };
  });
  ipcMain.handle('sparkii:saveRagSettings', async (_e, partial: {
    baseUrl?: string;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
    apiKey?: string;
  } = {}) => {
    await patchRagSettings(rt.dataDir, {
      baseUrl: partial.baseUrl,
      similarityThreshold: partial.similarityThreshold,
      vectorSimilarityWeight: partial.vectorSimilarityWeight,
      bindings: partial.bindings,
    });
    if (typeof partial.apiKey === 'string' && partial.apiKey.trim()) {
      await rt.setKey('sparkiirag', partial.apiKey);
    }
    return { ok: true };
  });
  ipcMain.handle('sparkii:testRagConnection', async (_e, apiKey?: string | null) => {
    return probeRag(rt, apiKey);
  });
  ipcMain.handle('sparkii:listRagDatasets', async (_e, apiKey?: string | null) => {
    return probeRag(rt, apiKey);
  });
  ipcMain.handle('sparkii:testKnowledgeConnection', async (_e, backend: string, override?: KnowledgeProbeOverride) => {
    if (!isKnowledgeBackendId(backend)) return invalidBackendProbeResult(backend);
    return probeKnowledgeConnection(rt, backend, override);
  });
  ipcMain.handle('sparkii:listKnowledgeDatasets', async (_e, backend: string, override?: KnowledgeProbeOverride) => {
    if (!isKnowledgeBackendId(backend)) return invalidBackendProbeResult(backend);
    return probeKnowledgeConnection(rt, backend, override);
  });
  ipcMain.handle('sparkii:openRagDocument', async (
    _e,
    args: { backend?: string; datasetId: string; documentId: string; fileName?: string },
  ) => {
    // `backend` 缺省 = sparkiirag（既有 renderer 行为不变），仍然只把 path 回给 renderer。
    const backend: KnowledgeBackendId = isKnowledgeBackendId(args?.backend) ? args.backend : 'sparkiirag';
    const cached = await cacheRagFile({
      datasetId: String(args?.datasetId ?? ''),
      documentId: String(args?.documentId ?? ''),
      fileName: args?.fileName,
    }, backend);
    if (!cached.ok) return { ok: false, error: cached.error.message };
    const error = await shell.openPath(cached.path);
    if (error) return { ok: false, error };
    return { ok: true, path: cached.path };
  });
  ipcMain.handle('sparkii:setSessionKnowledge', (_e, sessionId: string, selection: KnowledgeSelection) => {
    try {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, error: 'invalid session' };
      if (!selection || (selection.mode !== 'ids' && selection.mode !== 'all')) {
        return { ok: false, error: 'invalid selection' };
      }
      if (selection.mode === 'ids') {
        if (!Array.isArray(selection.datasetIds) || !selection.datasetIds.every((id) => typeof id === 'string')) {
          return { ok: false, error: 'invalid selection' };
        }
        sessionKnowledgeSelections.set(sessionId, { mode: 'ids', datasetIds: selection.datasetIds });
      } else {
        sessionKnowledgeSelections.set(sessionId, { mode: 'all' });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('sparkii:listModels', async (_e, providerId: string, apiKey?: string | null) => {
    try {
      const target = await providerProbeTarget(providerId, apiKey);
      const result = await probeProviderModels({ providerId, ...target });
      return {
        ok: result.ok,
        models: result.models ?? [],
        httpStatus: result.httpStatus,
        reason: result.reason,
        error: result.error,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('sparkii:testConnection', async (_e, providerId: string, apiKey?: string | null) => {
    try {
      const target = await providerProbeTarget(providerId, apiKey);
      const result = await probeProviderModels({ providerId, ...target });
      return {
        ok: result.ok,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        reason: result.reason,
        error: result.error,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
    const profileId = [...rt.profiles.keys()][0];
    if (!profileId) throw new Error('no profiles installed');
    const sessionId = randomUUID();
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildAgentSaddle(rt.agentOf(profileId), anchorDir(sessionId)),
      meta: profilePoolMeta(rt, profileId),
    });
    bindProposalRequests(slot, sessionId, profileId);
    bindRuntimeActions(slot, sessionId);
    bindConnectorRead(slot, profileId);
    let bindingLease: number | undefined;
    try {
      const binding = rt.pool.getBinding(sessionId);
      if (!binding) throw new Error(`unknown session ${sessionId}`);
      const lease = binding.lease;
      bindingLease = lease;
      const c = binding.client;
      const assertBinding = (): void => {
        const current = rt.pool.getBinding(sessionId);
        if (slot.getSessionId() !== sessionId || rt.pool.get(sessionId) !== c
          || current?.client !== c || current.lease !== lease) {
          throw new Error(`session ${sessionId} is no longer bound`);
        }
      };
      await selectModel(rt, 'chat', sessionId, undefined, assertBinding);
      assertBinding();
      const win = getWindow();
      await new Promise<void>((resolve, reject) => {
        let off = () => {};
        let settled = false;
        let sendSettled = false;
        let terminalEvent = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          removeTransientWaiter(sessionId, waiter);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error('prompt timeout')), 300_000);
        const waiterAdmission = rt.security?.taskLifecycle.currentAdmission?.(sessionId);
        const waiter = { lease, admission: waiterAdmission, cancel: () => finish(new Error(`session ${sessionId} is no longer bound`)) };
        const waiters = transientPromptCancels.get(sessionId) ?? [];
        waiters.push(waiter);
        transientPromptCancels.set(sessionId, waiters);
        assertBinding();
        off = c.onEvent((ev) => {
          try {
            assertBinding();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
          if (ev.type === 'agent_end') {
            terminalEvent = true;
            if (sendSettled) finish();
          }
        });
        c.send({ type: 'prompt', message: text }).then((resp) => {
          try {
            assertBinding();
            sendSettled = true;
            if (!resp.success) finish(new Error(resp.error ?? 'prompt failed'));
            else if (terminalEvent) finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      });
    } finally {
      if (bindingLease !== undefined) {
        const current = rt.pool.getBinding(sessionId);
        if (current?.lease === bindingLease) await rt.security?.taskLifecycle.end(sessionId, 'session-ended');
        await rt.pool.release(sessionId, bindingLease);
      }
    }
    return { ok: true };
  });
  ipcMain.handle('sparkii:runWorkflow', async (_e, profileId: string, input: Record<string, unknown>) => {
    const requestedWorkspace = typeof input.workspacePath === 'string' && input.workspacePath.trim()
      ? input.workspacePath
      : undefined;
    const workspacePath = requestedWorkspace
      ?? allocateAutoWorkspace(app.getPath('documents'), profileId).workspacePath;
    const sessionId = await runWorkflow(rt, getWindow, {
      ...input,
      workspacePath,
      workspaceKind: input.workspaceKind === 'user' ? 'user' : 'auto',
    }, broker, profileId, {
      async onReady(id, slot, bindingLease) {
        const current = rt.pool.getBinding(id);
        if (rt.pool.get(id) !== slot.client || current?.client !== slot.client || current.lease !== bindingLease) {
          throw new Error(`session ${id} is no longer bound`);
        }
        const entry = { slot, profileId, lease: bindingLease };
        inFlightWorkflowRuns.set(id, bindingLease);
        openSessions.set(id, entry);
        const assertBinding = (): void => {
          const live = rt.pool.getBinding(id);
          if (rt.pool.get(id) !== slot.client || live?.client !== slot.client || live.lease !== bindingLease
            || openSessions.get(id) !== entry || openSessions.get(id)?.lease !== bindingLease
            || inFlightWorkflowRuns.get(id) !== bindingLease) {
            throw new Error(`session ${id} is no longer bound`);
          }
        };
        assertBinding();
        ensureProcessPipe(slot);
        // workflow.ts already installed an admission-bound proposal dispatcher.
        // Replacing it here would dynamically attribute late requests to a new Task.
        bindRuntimeActions(slot, id);
        assertBinding();
        const startedTask = await startSessionTask(id, profileId, true, assertBinding);
        assertBinding();
        return startedTask.admission;
      },
      logger,
      async beforeRelease(id, bindingLease, workflowAdmission) {
        const open = openSessions.get(id);
        const ownsBinding = (): boolean => {
          const current = rt.pool.getBinding(id);
          return current?.lease === bindingLease && open?.lease === bindingLease
            && openSessions.get(id) === open && rt.pool.get(id) === open?.slot.client;
        };
        if (!open || !ownsBinding()) return false;
        if (workflowAdmission) {
          if (rt.security?.taskLifecycle.currentAdmission?.(id) !== workflowAdmission) return false;
          await rt.security?.taskLifecycle.end(id, 'session-ended', workflowAdmission);
        } else if (rt.security?.taskLifecycle.currentAdmission?.(id) !== undefined) {
          // An absent original admission must never fall back to a replacement.
          return false;
        }
        if (!ownsBinding() || rt.security?.taskLifecycle.currentAdmission?.(id) !== undefined) return false;
        // workflow 跑完由 workflow.ts 调 pool.release；这里先让窗口停转圈，管子留给下一条会话。
        if (inFlightWorkflowRuns.get(id) === bindingLease) inFlightWorkflowRuns.delete(id);
        getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_unbound', sessionId: id });
        if (openSessions.get(id) === open) openSessions.delete(id);
        return true;
      },
    }, app.getPath('documents'));
    return { ok: true, sessionId };
  });
  ipcMain.handle('sparkii:diagnostics', async () => ({
    logs: await logger.export(),
    audit: await rt.audit.exportJsonl(),
    runtime: await verifyRuntime(process.env),
  }));
  ipcMain.handle('sparkii:listErrors', () => rt.errors.list());
  ipcMain.handle('sparkii:appendError', (_e, rec: { id: string; message: string; source: string; createdAt: number }) => rt.errors.append(rec));
  ipcMain.handle('sparkii:clearError', (_e, id: string) => { rt.errors.clearOne(id); return { ok: true }; });
  ipcMain.handle('sparkii:clearErrors', () => { rt.errors.clear(); return { ok: true }; });
  ipcMain.handle('sparkii:markAllErrorsRead', () => { rt.errors.markAllRead(); return { ok: true }; });

  ipcMain.handle('sparkii:windowMinimize', () => {
    getWindow()?.minimize();
    return true;
  });
  ipcMain.handle('sparkii:windowToggleMaximize', () => {
    const window = getWindow();
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('sparkii:windowClose', () => {
    getWindow()?.close();
    return true;
  });
  ipcMain.handle('sparkii:windowIsMaximized', () => getWindow()?.isMaximized() ?? false);

  // ── 自动更新 IPC（G5 / A 关）────────────────────────────────────────────
  // 只经 UpdateService 门面访问；downloadUpdate / installUpdate 的验签门禁由服务层实现，
  // 此处绝不绕过、不直接调 updater；所有通道只传结构化数据，不回传 URL 给 Renderer 加载。
  const UPDATE_DISABLED: UpdateActionResult = { ok: false, reason: 'DISABLED' };
  const UPDATE_DISABLED_STATE: UpdateState = {
    phase: 'disabled',
    currentVersion: '',
    baseUrl: null,
    autoCheck: false,
    lastCheckedAt: null,
    lastSuccessAt: null,
    remote: null,
    local: null,
    progress: null,
    choiceRequired: false,
    errorCode: 'DISABLED',
    stateTampered: false,
    httpWarning: false,
    pendingApprovals: 0,
    activeSessions: 0,
  };
  const UPDATE_DISABLED_SETTINGS: UpdateSettingsPublic = {
    baseUrl: '',
    autoCheck: false,
    checkIntervalHours: 24,
    checkOnStartup: false,
    startupDelaySeconds: 90,
    checkOnNetworkResume: false,
    checkOnSystemResume: false,
    remindIntervalHours: 24,
    requestTimeoutMs: 8000,
    autoDownload: false,
    isHttp: false,
  };
  /** 只依赖 UpdateService 门面的结构形态（契约 §4），不依赖 G3 额外导出的类型名。 */
  type UpdateServiceLike = {
    getAppVersion(): Promise<string>;
    getState(): Promise<UpdateState>;
    checkForUpdate(force?: boolean): Promise<UpdateActionResult>;
    downloadUpdate(opts: { version: string }): Promise<UpdateActionResult>;
    cancelDownload(): Promise<UpdateActionResult>;
    installUpdate(opts: { version: string }): Promise<UpdateActionResult>;
    clearDownloaded(opts: { version: string }): Promise<UpdateActionResult>;
    deferUpdate(): Promise<UpdateActionResult>;
    skipUpdate(opts: { version: string }): Promise<UpdateActionResult>;
    getSettings(): Promise<UpdateSettingsPublic>;
    saveSettings(partial: UpdateSettingsPatch): Promise<UpdateActionResult>;
    resetInstallId(): Promise<UpdateActionResult>;
  };
  /** 服务未初始化时不抛错：返回结构化兜底，绝不触碰 updater。 */
  const withUpdateService = <T>(fallback: T, fn: (s: UpdateServiceLike) => Promise<T> | T) =>
    async (..._args: unknown[]): Promise<T> => hasUpdateService() ? await fn(getUpdateService()) : fallback;
  /**
   * IPC 边界形态校验：与 `update/dirs.ts` 的 choke point 用**同一条**判据。
   * 这里原先是一条独立的宽正则 `^[0-9A-Za-z.+-]+$`，它允许 `..`，
   * 于是 `clearDownloaded({version:'..'})` 会把整棵 `updates/` 树删掉（含防降级状态）。
   */
  const validVersion = (v: unknown): v is string => isSafeVersionSegment(v);
  const versionOpts = (opts: unknown): { version: string } | null => {
    const version = (opts as { version?: unknown } | null | undefined)?.version;
    return validVersion(version) ? { version } : null;
  };

  ipcMain.handle('sparkii:getAppVersion', async (..._args: unknown[]) =>
    hasUpdateService() ? await getUpdateService().getAppVersion() : (app.getVersion?.() ?? ''));
  ipcMain.handle('sparkii:getUpdateState', withUpdateService(UPDATE_DISABLED_STATE, (s) => s.getState()));
  ipcMain.handle('sparkii:checkForUpdate', (_e, force?: boolean) =>
    withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.checkForUpdate(force))());
  ipcMain.handle('sparkii:downloadUpdate', (_e, opts: unknown) => {
    const parsed = versionOpts(opts);
    if (!parsed) return { ok: false, reason: 'POINTER_INVALID' };
    return withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.downloadUpdate(parsed))();
  });
  ipcMain.handle('sparkii:cancelDownload', withUpdateService(UPDATE_DISABLED, (s) => s.cancelDownload()));
  ipcMain.handle('sparkii:installUpdate', (_e, opts: unknown) => {
    const parsed = versionOpts(opts);
    if (!parsed) return { ok: false, reason: 'POINTER_INVALID' };
    return withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.installUpdate(parsed))();
  });
  ipcMain.handle('sparkii:clearDownloaded', (_e, opts: unknown) => {
    const parsed = versionOpts(opts);
    if (!parsed) return { ok: false, reason: 'POINTER_INVALID' };
    return withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.clearDownloaded(parsed))();
  });
  ipcMain.handle('sparkii:deferUpdate', withUpdateService(UPDATE_DISABLED, (s) => s.deferUpdate()));
  ipcMain.handle('sparkii:skipUpdate', (_e, opts: unknown) => {
    const parsed = versionOpts(opts);
    if (!parsed) return { ok: false, reason: 'POINTER_INVALID' };
    return withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.skipUpdate(parsed))();
  });
  ipcMain.handle('sparkii:getUpdateSettings', withUpdateService(UPDATE_DISABLED_SETTINGS, (s) => s.getSettings()));
  // §6.6 设置页「重置 installId」：只改本地检查时间的散布，不碰版本判定、不出网。
  ipcMain.handle('sparkii:resetInstallId', withUpdateService(UPDATE_DISABLED, (s) => s.resetInstallId()));
  ipcMain.handle('sparkii:saveUpdateSettings', (_e, partial: unknown) => {
    // baseUrl 校验与二次确认由 UpdateService 负责；G5 只透传结构化数据（不回传 URL 供加载）。
    const patch: UpdateSettingsPatch = partial && typeof partial === 'object' && !Array.isArray(partial)
      ? partial as UpdateSettingsPatch
      : {};
    return withUpdateService<UpdateActionResult>(UPDATE_DISABLED, (s) => s.saveSettings(patch))();
  });
}
