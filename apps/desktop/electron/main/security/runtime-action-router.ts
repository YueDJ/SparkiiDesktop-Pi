import {
  actionFingerprint,
  evaluatePolicy,
  type PlatformProfilePolicy,
  type PolicyOutcome,
  type ReviewerDecision,
  type SecurityAction,
  type SecurityRisk,
  type ShellReviewInput,
  type TaskGrant,
} from '@sparkii/approval';
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from '@sparkii/agent-host';
import {
  REVIEWER_EVIDENCE_LIMIT,
  REVIEWER_COMMAND_INPUT_LIMIT,
  REVIEWER_LOG_EVENTS,
  REVIEWER_SUMMARY_LIMIT,
  REVIEWER_USER_TASK_LIMIT,
  redactReviewerCommand,
} from './reviewer-policy.js';
import type { ShellGrantStore } from './shell-grant-store.js';
import type { ActionNormalizer } from './action-normalizer.js';
import type { TaskLifecycle } from './task-lifecycle.js';

interface AuditSink {
  append(event: {
    actor: string;
    action: string;
    resource?: string;
    payloadSummary?: string;
    sessionId?: string;
    taskId?: string;
    actionId?: string;
    ruleId?: string;
    capability?: string;
    payloadHash?: string;
    platform?: string;
    sandboxVersion?: string;
    decision?: string;
  }): Promise<unknown>;
}

export interface ApprovalResolution {
  choice: 'once' | 'task' | 'deny';
}

export interface RuntimeActionRouterOptions {
  lifecycle: TaskLifecycle;
  normalizer: ActionNormalizer;
  profilePolicyOf(profileId: string): PlatformProfilePolicy;
  platformReady(action: SecurityAction): boolean;
  execute(
    action: SecurityAction,
    grant: TaskGrant,
  ): Promise<{ result?: unknown }>;
  /**
   * Ask mode and every Reviewer escalation end here. `riskOverride` only changes
   * what the user is shown; the Action and its payload hash stay untouched.
   */
  requestApproval(
    action: SecurityAction,
    grant: TaskGrant,
    riskOverride?: SecurityRisk,
  ): Promise<ApprovalResolution>;
  shellGrants: ShellGrantStore;
  reviewerModel: string;
  reviewerPolicyVersion: string;
  userTaskOf(sessionId: string): string;
  reviewShell(input: ShellReviewInput): Promise<ReviewerDecision>;
  revalidate(
    action: SecurityAction,
    grant: TaskGrant,
  ): Promise<boolean>;
  audit: AuditSink;
  actor?: () => string;
  now?: () => number;
  platformName?: string;
  sandboxVersion?: string;
  hardDenyPolicyVersion?: string;
}

type Evidence = ShellReviewInput['recentEvidence'][number];

function denied(
  requestId: string,
  decision: ActionExecutionResult['decision'],
  code: string,
  message: string,
): ActionExecutionResult {
  return {
    requestId,
    status: 'denied',
    decision,
    error: { code, message },
  };
}

function exitCodeOf(result: unknown): number | null | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as { exitCode?: unknown }).exitCode;
  return typeof value === 'number' || value === null ? value : undefined;
}

export function createRuntimeActionRouter(options: RuntimeActionRouterOptions) {
  const actor = options.actor ?? (() => 'agent');
  const deniedFingerprints = new Map<string, Set<string>>();
  const reviewerDenials = new Map<string, number>();
  const evidenceByTask = new Map<string, Evidence[]>();

  const auditDecision = async (
    action: SecurityAction,
    event: string,
    detail: string,
    ruleId: string,
    decision?: string,
  ): Promise<void> => {
    await options.audit.append({
      actor: actor(),
      action: event,
      resource: action.toolName,
      payloadSummary: detail.slice(0, 512),
      sessionId: action.sessionId,
      taskId: action.taskId,
      actionId: action.id,
      ruleId,
      capability: action.capability,
      payloadHash: action.payloadHash,
      platform: options.platformName,
      sandboxVersion: options.sandboxVersion,
      ...(decision ? { decision } : {}),
    });
  };

  const auditReviewer = async (
    action: SecurityAction,
    event: string,
    summary: Record<string, unknown>,
    decision: string,
    ruleId: string,
  ): Promise<void> => {
    await options.audit.append({
      actor: `reviewer:${options.reviewerModel}`,
      action: event,
      resource: action.toolName,
      payloadSummary: JSON.stringify(summary).slice(0, 512),
      sessionId: action.sessionId,
      taskId: action.taskId,
      actionId: action.id,
      ruleId,
      capability: action.capability,
      payloadHash: action.payloadHash,
      platform: options.platformName,
      sandboxVersion: options.sandboxVersion,
      decision,
    });
  };

  const recordEvidence = (
    action: SecurityAction,
    status: Evidence['status'],
    summary: string,
    exitCode?: number | null,
  ): void => {
    const list = evidenceByTask.get(action.taskId) ?? [];
    const entry: Evidence = {
      toolName: action.toolName,
      status,
      summary: redactReviewerCommand(summary).slice(0, REVIEWER_SUMMARY_LIMIT),
    };
    if (exitCode !== undefined) entry.exitCode = exitCode;
    list.push(entry);
    while (list.length > REVIEWER_EVIDENCE_LIMIT) list.shift();
    evidenceByTask.set(action.taskId, list);
  };

  const buildReviewInput = (
    action: SecurityAction,
    grant: TaskGrant,
  ): ShellReviewInput => {
    const payload = (action.payload ?? {}) as { command?: unknown };
    const command = String(payload.command ?? '');
    if (Buffer.byteLength(command, 'utf8') > REVIEWER_COMMAND_INPUT_LIMIT) {
      throw new Error('Shell command is too large for independent review');
    }
    return {
      taskId: grant.taskId,
      sessionId: grant.sessionId,
      actionId: action.id,
      userTask: options.userTaskOf(grant.sessionId).slice(0, REVIEWER_USER_TASK_LIMIT),
      toolName: action.toolName,
      capability: action.capability,
      risk: action.risk,
      command,
      cwd: grant.workspaceRoot,
      workspaceRoot: grant.workspaceRoot,
      targets: action.resources.map((resource) => resource.value),
      recentEvidence: [...(evidenceByTask.get(grant.taskId) ?? [])],
      hardDenyPolicyVersion: options.hardDenyPolicyVersion ?? 'hard-deny-v1',
      payloadHash: action.payloadHash,
      unattended: grant.unattended,
    };
  };

  /** Only an ordinary, non-high-risk Shell command may be covered by a task grant. */
  const isOrdinaryShell = (action: SecurityAction): boolean =>
    action.capability === 'process.exec'
    && action.approvalClass === 'shell'
    && action.risk !== 'high-risk';

  const settleApproval = async (
    requestId: string,
    action: SecurityAction,
    grant: TaskGrant,
    approval: ApprovalResolution,
    fallback: PolicyOutcome,
    ruleId: string,
    reason: string,
    riskOverride?: SecurityRisk,
  ): Promise<{ deniedResult: ActionExecutionResult } | { outcome: PolicyOutcome }> => {
    if (approval.choice === 'deny') {
      await auditDecision(action, 'action.denied', 'user denied', 'user.denied', 'denied');
      return { deniedResult: denied(
        requestId,
        fallback,
        'USER_DENIED',
        'Capability request was denied',
      ) };
    }
    if (approval.choice === 'task') {
      if (!isOrdinaryShell(action) || riskOverride === 'high-risk') {
        return { deniedResult: denied(
          requestId,
          fallback,
          'INVALID_APPROVAL_SCOPE',
          'Task scope is only valid for ordinary shell',
        ) };
      }
      options.shellGrants.grant(action.taskId, grant.expiresAt);
      await auditDecision(
        action,
        'shell.task-grant',
        `task shell grant for ${action.taskId}`,
        'task-shell-grant',
        'approved',
      );
    }
    return { outcome: { decision: 'allow', ruleId, reason } };
  };

  const askUser = async (
    requestId: string,
    action: SecurityAction,
    grant: TaskGrant,
    fallback: PolicyOutcome,
    riskOverride?: SecurityRisk,
  ): Promise<{ deniedResult?: ActionExecutionResult; outcome?: PolicyOutcome }> => {
    try {
      options.lifecycle.assertActive(action.sessionId, action.taskId);
    } catch {
      await auditDecision(action, 'action.denied',
        'task grant revoked before human approval', 'task-grant.revoked', 'denied');
      return { deniedResult: denied(
        requestId,
        fallback,
        'TASK_REVOKED',
        'Task grant is no longer active',
      ) };
    }
    if (grant.unattended) {
      await auditDecision(action, 'action.denied',
        'human approval is unavailable for an unattended task',
        'human-approval.unavailable', 'denied');
      return { deniedResult: denied(
        requestId,
        fallback,
        'HUMAN_APPROVAL_UNAVAILABLE',
        'Human approval is unavailable for an unattended task',
      ) };
    }
    let approval: ApprovalResolution;
    try {
      approval = await options.requestApproval(action, grant, riskOverride);
    } catch (error) {
      return { deniedResult: denied(requestId, fallback, 'APPROVAL_FAILED',
        error instanceof Error ? error.message : String(error)) };
    }
    const settled = await settleApproval(
      requestId,
      action,
      grant,
      approval,
      fallback,
      'user.approved',
      '用户已批准',
      riskOverride,
    );
    return 'deniedResult' in settled ? settled : { outcome: settled.outcome };
  };

  const reviewShell = async (
    requestId: string,
    action: SecurityAction,
    grant: TaskGrant,
    fallback: PolicyOutcome,
  ): Promise<{ deniedResult?: ActionExecutionResult; outcome?: PolicyOutcome }> => {
    const started = Date.now();
    let reviewed: ReviewerDecision;
    try {
      reviewed = await options.reviewShell(buildReviewInput(action, grant));
    } catch (error) {
      try {
        options.lifecycle.assertActive(action.sessionId, action.taskId);
      } catch {
        await auditDecision(action, 'action.denied',
          'task grant revoked while reviewer was running',
          'task-grant.revoked', 'denied');
        return { deniedResult: denied(
          requestId,
          fallback,
          'TASK_REVOKED',
          'Task grant was revoked during review',
        ) };
      }
      const message = error instanceof Error ? error.message : String(error);
      await auditReviewer(action, REVIEWER_LOG_EVENTS.fallback, {
        policyVersion: options.reviewerPolicyVersion,
        model: options.reviewerModel,
        error: message,
        fallback: grant.unattended ? 'deny' : 'ask',
      }, grant.unattended ? 'denied' : 'ask', 'reviewer.fallback');
      if (grant.unattended) {
        return { deniedResult: denied(requestId, fallback, 'REVIEWER_UNAVAILABLE',
          'Reviewer unavailable for unattended task') };
      }
      const settled = await askUser(requestId, action, grant, fallback, 'high-risk');
      if (settled.outcome) {
        return { outcome: {
          decision: 'allow',
          ruleId: 'reviewer.fallback-ask',
          reason: 'Reviewer 不可用，已转人工审批',
        } };
      }
      return settled;
    }

    await auditReviewer(action, 'reviewer.decision', {
      policyVersion: options.reviewerPolicyVersion,
      model: options.reviewerModel,
      risk: reviewed.risk,
      durationMs: Date.now() - started,
      reason: reviewed.reason,
      fallback: false,
    }, reviewed.decision, `reviewer.${reviewed.decision}`);

    if (reviewed.decision === 'deny') {
      const fingerprints = deniedFingerprints.get(action.taskId) ?? new Set<string>();
      fingerprints.add(actionFingerprint(action));
      deniedFingerprints.set(action.taskId, fingerprints);
      const count = (reviewerDenials.get(action.taskId) ?? 0) + 1;
      reviewerDenials.set(action.taskId, count);
      recordEvidence(action, 'denied', `reviewer deny: ${reviewed.reason}`);
      if (count >= 3) {
        await auditReviewer(action, REVIEWER_LOG_EVENTS.circuitOpen, {
          policyVersion: options.reviewerPolicyVersion,
          consecutiveDenials: count,
        }, 'denied', 'reviewer.circuit-open');
        await options.lifecycle.end(action.sessionId, 'reviewer-circuit-open');
      }
      return { deniedResult: denied(
        requestId,
        { decision: 'deny', ruleId: 'reviewer.deny', reason: reviewed.reason },
        'REVIEWER_DENIED',
        reviewed.reason,
      ) };
    }

    reviewerDenials.delete(action.taskId);
    if (reviewed.decision === 'ask') {
      const settled = await askUser(requestId, action, grant, fallback, 'high-risk');
      if (settled.outcome) {
        return { outcome: {
          decision: 'allow',
          ruleId: 'reviewer.ask-approved',
          reason: reviewed.reason,
        } };
      }
      return settled;
    }
    return { outcome: {
      decision: 'allow',
      ruleId: 'reviewer.allow',
      reason: reviewed.reason,
    } };
  };

  return {
    /** Forgets every per-Task routing fact: evidence, denials and counters. */
    clearTask(taskId: string): void {
      evidenceByTask.delete(taskId);
      deniedFingerprints.delete(taskId);
      reviewerDenials.delete(taskId);
    },

    async route(
      request: RuntimeActionRequest,
      sessionId: string,
    ): Promise<ActionExecutionResult> {
      let grant: TaskGrant;
      try {
        grant = options.lifecycle.assertActive(sessionId);
      } catch {
        return denied(request.requestId, {
          decision: 'deny',
          ruleId: 'task-grant.revoked',
          reason: 'Task 已被撤销或过期',
        }, 'TASK_REVOKED', 'Task grant is no longer active');
      }

      let action: SecurityAction;
      try {
        action = await options.normalizer.normalize(request, grant);
      } catch (error) {
        return denied(request.requestId, {
          decision: 'deny',
          ruleId: 'platform.action-invalid',
          reason: error instanceof Error ? error.message : String(error),
        }, 'ACTION_NORMALIZATION_FAILED',
        error instanceof Error ? error.message : String(error));
      }

      let outcome = evaluatePolicy({
        action,
        grant,
        profilePolicy: options.profilePolicyOf(grant.profileId),
        platformReady: options.platformReady(action),
        now: options.now?.() ?? Date.now(),
      });

      if (outcome.decision === 'deny') {
        recordEvidence(action, 'denied', `${outcome.ruleId}: ${outcome.reason}`);
        await auditDecision(action, 'action.denied',
          `${outcome.ruleId}: ${outcome.reason}`, outcome.ruleId);
        return denied(request.requestId, outcome, 'POLICY_DENIED', outcome.reason);
      }

      if (outcome.decision === 'ask') {
        await auditDecision(action, 'action.ask',
          `${outcome.ruleId}: ${outcome.reason}`, outcome.ruleId);

        const fingerprint = actionFingerprint(action);
        if (deniedFingerprints.get(action.taskId)?.has(fingerprint)) {
          recordEvidence(action, 'denied', 'reviewer replay denied');
          return denied(request.requestId, {
            decision: 'deny',
            ruleId: 'reviewer.replay-denied',
            reason: 'Reviewer 已拒绝相同动作',
          }, 'REVIEWER_DENIED', 'denied action replay');
        }

        if (isOrdinaryShell(action) && options.shellGrants.allows(action.taskId)) {
          outcome = {
            decision: 'allow',
            ruleId: 'task-shell-grant',
            reason: '当前任务已允许普通 Shell',
          };
        } else if (grant.permissionMode === 'auto_review' && action.approvalClass === 'shell') {
          const settled = await reviewShell(request.requestId, action, grant, outcome);
          if (settled.deniedResult) return settled.deniedResult;
          outcome = settled.outcome!;
        } else {
          const settled = await askUser(request.requestId, action, grant, outcome);
          if (settled.deniedResult) return settled.deniedResult;
          outcome = settled.outcome!;
        }
      }

      try {
        options.lifecycle.assertActive(sessionId, action.taskId);
      } catch {
        await auditDecision(action, 'action.denied',
          'task grant revoked before execution', 'task-grant.revoked', 'denied');
        return denied(request.requestId, outcome, 'TASK_REVOKED',
          'Task grant was revoked before execution');
      }
      if (!await options.revalidate(action, grant)) {
        await auditDecision(action, 'action.denied',
          'target identity or parent chain changed after normalization',
          'target.changed', 'denied');
        return denied(request.requestId, outcome, 'TARGET_CHANGED',
          'Target identity or parent chain changed after normalization');
      }

      await auditDecision(action, 'action.allowed',
        `${outcome.ruleId}: ${outcome.reason}`, outcome.ruleId);
      try {
        const execution = await options.execute(action, grant);
        recordEvidence(
          action,
          'executed',
          `${action.toolName}: ${outcome.ruleId}`,
          exitCodeOf(execution.result),
        );
        await auditDecision(action, 'action.executed', outcome.ruleId, outcome.ruleId);
        return {
          requestId: request.requestId,
          status: 'executed',
          decision: outcome,
          result: execution.result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordEvidence(action, 'failed', `${action.toolName} failed: ${message}`);
        await auditDecision(action, 'action.failed', message, 'action.execution-failed');
        return {
          requestId: request.requestId,
          status: 'failed',
          decision: outcome,
          error: { code: 'ACTION_EXECUTION_FAILED', message },
        };
      }
    },
  };
}
