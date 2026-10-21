import {
  evaluatePolicy,
  type PlatformProfilePolicy,
  type SecurityAction,
  type TaskGrant,
} from '@sparkii/approval';
import type {
  ActionExecutionResult,
  RuntimeActionRequest,
} from '@sparkii/agent-host';
import type {
  ActionNormalizer,
} from './action-normalizer.js';
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
  }): Promise<unknown>;
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
  requestApproval(
    action: SecurityAction,
    grant: TaskGrant,
  ): Promise<{ approved: boolean }>;
  revalidate(
    action: SecurityAction,
    grant: TaskGrant,
  ): Promise<boolean>;
  audit: AuditSink;
  actor?: () => string;
  now?: () => number;
  platformName?: string;
  sandboxVersion?: string;
}

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

export function createRuntimeActionRouter(
  options: RuntimeActionRouterOptions,
) {
  const actor = options.actor ?? (() => 'agent');
  const auditDecision = async (
    action: SecurityAction,
    event: string,
    detail: string,
    ruleId: string,
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
    });
  };

  return {
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

      const outcome = evaluatePolicy({
        action,
        grant,
        profilePolicy: options.profilePolicyOf(grant.profileId),
        platformReady: options.platformReady(action),
        now: options.now?.() ?? Date.now(),
      });

      if (outcome.decision === 'deny') {
        await auditDecision(
          action,
          'action.denied',
          `${outcome.ruleId}: ${outcome.reason}`,
          outcome.ruleId,
        );
        return denied(
          request.requestId,
          outcome,
          'POLICY_DENIED',
          outcome.reason,
        );
      }

      if (outcome.decision === 'ask') {
        await auditDecision(
          action,
          'action.ask',
          `${outcome.ruleId}: ${outcome.reason}`,
          outcome.ruleId,
        );
        let approval: { approved: boolean };
        try {
          approval = await options.requestApproval(action, grant);
        } catch (error) {
          return denied(request.requestId, outcome, 'APPROVAL_FAILED',
            error instanceof Error ? error.message : String(error));
        }
        if (!approval.approved) {
          return denied(request.requestId, outcome, 'USER_DENIED',
            'Capability request was denied');
        }
      } else {
        await auditDecision(
          action,
          'action.allowed',
          `${outcome.ruleId}: ${outcome.reason}`,
          outcome.ruleId,
        );
      }

      try {
        options.lifecycle.assertActive(sessionId, action.taskId);
      } catch {
        return denied(request.requestId, outcome, 'TASK_REVOKED',
          'Task grant was revoked before execution');
      }
      if (!await options.revalidate(action, grant)) {
        return denied(request.requestId, outcome, 'TARGET_CHANGED',
          'Target identity or parent chain changed after normalization');
      }

      try {
        const execution = await options.execute(action, grant);
        await auditDecision(
          action,
          'action.executed',
          outcome.ruleId,
          outcome.ruleId,
        );
        return {
          requestId: request.requestId,
          status: 'executed',
          decision: outcome,
          result: execution.result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
