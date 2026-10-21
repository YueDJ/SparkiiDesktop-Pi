import type {
  CapabilityKind,
  PolicyInput,
  PolicyOutcome,
  SecurityAction,
  TaskGrant,
} from './types.js';

const WORKSPACE_WRITE_CAPABILITIES = new Set<CapabilityKind>([
  'fs.write',
  'process.exec',
]);

function matchesPolicyEntry(
  entries: string[] | undefined,
  action: SecurityAction,
): boolean {
  return entries?.some((entry) =>
    entry === action.capability || entry === action.toolName,
  ) ?? false;
}

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
        return ['workspace', 'scratch', 'input'].includes(resource.scope);
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

function allowRule(action: SecurityAction): PolicyOutcome {
  if (action.capability === 'fs.read') {
    return {
      decision: 'allow',
      ruleId: 'workspace.read',
      reason: '目标属于当前任务的只读范围',
    };
  }
  if (action.capability === 'fs.write') {
    return {
      decision: 'allow',
      ruleId: 'workspace.write',
      reason: '目标属于当前任务的可写工作区或私有 scratch',
    };
  }
  if (action.capability === 'process.exec') {
    return {
      decision: 'allow',
      ruleId: 'workspace.process',
      reason: '工作区进程属于当前任务授权',
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
 * consumes Main-normalized actions; it does not inspect Runtime metadata.
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { action, grant, profilePolicy, platformReady } = input;
  const now = input.now ?? Date.now();

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
  if (
    action.taskId !== grant.taskId
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
  if (!platformReady) {
    return {
      decision: 'deny',
      ruleId: 'platform.not-ready',
      reason: '平台无法证明所需的沙箱与执行边界',
    };
  }
  if (
    grant.mode === 'plan'
    && WORKSPACE_WRITE_CAPABILITIES.has(action.capability)
  ) {
    return {
      decision: 'deny',
      ruleId: 'plan-mode.read-only',
      reason: '计划模式不允许修改工作区或执行进程',
    };
  }

  const native = withinGrant(grant, action);
  if (
    native
    && grant.mode === 'strict'
    && WORKSPACE_WRITE_CAPABILITIES.has(action.capability)
  ) {
    return {
      decision: 'ask',
      ruleId: 'strict-mode.confirmation',
      reason: '严格模式要求人工确认写操作或进程执行',
    };
  }
  if (matchesPolicyEntry(profilePolicy.requireApproval, action)) {
    return {
      decision: 'ask',
      ruleId: 'profile.require-approval',
      reason: '当前 Profile 要求人工确认此能力',
    };
  }
  if (native) return allowRule(action);

  if (
    action.risk !== 'high-risk'
    && matchesPolicyEntry(profilePolicy.autoApprove, action)
  ) {
    return {
      decision: 'allow',
      ruleId: 'profile.auto-approve',
      reason: '命中受控 Profile 自动通过规则',
      autoApproved: true,
    };
  }

  return {
    decision: 'ask',
    ruleId: 'platform.capability-expansion',
    reason: '动作需要扩大当前任务能力',
  };
}
