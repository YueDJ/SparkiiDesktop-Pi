import type { PolicyDecision, PolicyOutcome } from '@sparkii/approval';

/** Opaque provenance issued by Main for one admitted prompt turn. */
export type RuntimeOriginToken = string;

export interface RuntimeActionRequest {
  requestId: string;
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type ActionExecutionStatus =
  | 'allowed'
  | 'ask'
  | 'denied'
  | 'executed'
  | 'failed';

export interface ActionExecutionResult {
  requestId: string;
  status: ActionExecutionStatus;
  decision: PolicyOutcome;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export type RuntimeActionEnvelope = {
  direction: 'runtime-to-main';
  action: RuntimeActionRequest;
  sessionGeneration?: number;
  originToken?: RuntimeOriginToken;
};

export type ActionResultEnvelope = {
  direction: 'main-to-runtime';
  requestId: string;
  actionResult: ActionExecutionResult;
  sessionGeneration?: number;
};

export function runtimeActionEnvelope(
  action: RuntimeActionRequest,
  sessionGeneration = 0,
  originToken?: RuntimeOriginToken,
): RuntimeActionEnvelope {
  if (!action.requestId.trim()) throw new Error('requestId is required');
  if (!action.toolName.trim()) throw new Error('toolName is required');
  return { direction: 'runtime-to-main', action, sessionGeneration, ...(originToken ? { originToken } : {}) };
}

export function actionResultEnvelope(
  requestId: string,
  actionResult: ActionExecutionResult,
  sessionGeneration = 0,
): ActionResultEnvelope {
  if (!requestId.trim()) throw new Error('requestId is required');
  if (actionResult.requestId !== requestId) {
    throw new Error('action result requestId does not match correlation id');
  }
  return { direction: 'main-to-runtime', requestId, actionResult, sessionGeneration };
}

export function decisionStatus(
  decision: PolicyDecision,
  executed = false,
): ActionExecutionStatus {
  if (executed) return 'executed';
  if (decision === 'allow') return 'allowed';
  return decision === 'deny' ? 'denied' : 'ask';
}
