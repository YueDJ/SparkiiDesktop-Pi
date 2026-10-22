import type {
  PolicyInput,
  PolicyOutcome,
  SecurityAction,
  TaskGrant,
} from './types.js';

function matchesPolicyEntry(
  entries: string[] | undefined,
  action: SecurityAction,
): boolean {
  return entries?.some((entry) =>
    entry === action.capability || entry === action.toolName,
  ) ?? false;
}

/**
 * Structural containment only. Process execution is never "inside" a grant: a
 * Shell action always needs a human decision or an independent review.
 */
function withinGrant(grant: TaskGrant, action: SecurityAction): boolean {
  if (action.resources.length === 0) return false;
  return action.resources.every((resource) => {
    if (resource.scope === 'critical' || resource.trustAnchor) return false;
    switch (action.capability) {
      case 'fs.read':
        return resource.kind === 'path'
          && ['workspace', 'input', 'scratch'].includes(resource.scope);
      case 'fs.write':
        return resource.kind === 'path'
          && ['workspace', 'scratch'].includes(resource.scope);
      case 'process.exec':
        return false;
      case 'net.connect':
        return resource.kind === 'domain'
          && resource.scope === 'external'
          && grant.networkDomains.includes(resource.value);
      case 'connector.invoke':
        return resource.kind === 'connector'
          && resource.scope === 'external'
          && grant.externalCapabilities.includes(resource.value);
      case 'task.delegate':
        return resource.kind === 'task'
          && resource.value === grant.taskId
          && resource.scope === 'workspace';
    }
  });
}

function grantNativeRule(action: SecurityAction): PolicyOutcome {
  if (action.capability === 'fs.read') {
    return {
      decision: 'allow',
      ruleId: 'workspace.read',
      reason: '目标属于当前任务的只读范围',
    };
  }
  return {
    decision: 'allow',
    ruleId: 'task-grant',
    reason: '目标属于当前任务的既有能力授权',
  };
}

/**
 * Deterministic policy evaluation. This function is platform-neutral and only
 * consumes Main-normalized actions; it does not inspect Runtime metadata and it
 * never delegates a decision to a model.
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { action, grant, profilePolicy, platformReady } = input;
  const now = input.now ?? Date.now();

  if (
    action.subjectId !== grant.actorId
    || action.taskId !== grant.taskId
    || action.sessionId !== grant.sessionId
    || action.agentId !== grant.agentId
    || action.profileId !== grant.profileId
  ) {
    return {
      decision: 'deny',
      ruleId: 'task-grant.identity',
      reason: '动作与当前任务授权身份不匹配',
    };
  }
  if (grant.expiresAt <= now) {
    return {
      decision: 'deny',
      ruleId: 'task-grant.expired',
      reason: '任务授权已过期',
    };
  }
  if (action.resources.some((resource) => resource.scope === 'critical')) {
    return {
      decision: 'deny',
      ruleId: 'platform.critical-target',
      reason: '目标属于不可覆盖的灾难范围',
    };
  }
  if (action.resources.some((resource) => resource.trustAnchor)) {
    return {
      decision: 'deny',
      ruleId: 'platform.trust-anchor',
      reason: '目标属于不可由普通任务修改的信任锚',
    };
  }
  if (action.hardDenyRule) {
    return {
      decision: 'deny',
      ruleId: action.hardDenyRule,
      reason: '命中确定性硬拒绝规则',
    };
  }
  if (grant.planMode === 'plan' && action.capability !== 'fs.read') {
    return {
      decision: 'deny',
      ruleId: 'plan-mode.read-only',
      reason: '计划模式只允许读取',
    };
  }
  if (!platformReady) {
    return {
      decision: 'deny',
      ruleId: 'platform.not-ready',
      reason: '平台无法证明所需的执行边界',
    };
  }

  if (action.approvalClass === 'auto') {
    if (withinGrant(grant, action)) {
      return action.capability === 'fs.write'
        ? {
            decision: 'allow',
            ruleId: 'workspace.crud',
            reason: 'Workspace 内普通文件操作无需审批',
          }
        : grantNativeRule(action);
    }
    if (action.capability === 'fs.write') {
      return {
        decision: 'deny',
        ruleId: 'workspace.write-outside',
        reason: '结构化写工具不能扩大 Workspace 边界',
      };
    }
  }
  if (action.approvalClass === 'human_required') {
    return {
      decision: 'ask',
      ruleId: 'platform.human-required',
      reason: '该动作只能人工审批',
    };
  }
  if (action.capability === 'process.exec') {
    return {
      decision: 'ask',
      ruleId: 'platform.base-ask',
      reason: 'Shell 需要审批或独立审查',
    };
  }
  if (matchesPolicyEntry(profilePolicy.requireApproval, action)) {
    return {
      decision: 'ask',
      ruleId: 'profile.require-approval',
      reason: '当前 Profile 要求人工确认此能力',
    };
  }
  if (withinGrant(grant, action)) return grantNativeRule(action);

  return {
    decision: 'ask',
    ruleId: 'platform.capability-expansion',
    reason: '动作需要扩大当前任务能力',
  };
}
