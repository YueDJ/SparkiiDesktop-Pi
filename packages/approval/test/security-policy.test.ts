import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  type PlatformProfilePolicy,
  type PolicyInput,
  type SecurityAction,
  type TaskGrant,
} from '../src/security/index.js';

const now = 1_000;

const grant: TaskGrant = {
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  actorId: 'u1',
  unattended: false,
  planMode: 'execute',
  permissionMode: 'ask',
  workspaceRoot: 'C:/ws',
  workspaceIdentity: 'dir:1',
  inputRoots: [],
  scratchRoot: 'C:/scratch/t1',
  networkDomains: [],
  externalCapabilities: [],
  createdAt: 1,
  expiresAt: 2_000,
};

const workspaceWrite: SecurityAction = {
  id: 'a1',
  subjectId: 'u1',
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'write',
  capability: 'fs.write',
  approvalClass: 'auto',
  resources: [
    {
      kind: 'path',
      value: 'C:/ws/a.txt',
      identity: 'file:1',
      scope: 'workspace',
    },
  ],
  payload: { content: 'x' },
  payloadHash: 'h',
  risk: 'write',
  reason: '工作区内文件修改',
};

const shellAction = (patch: Partial<SecurityAction> = {}): SecurityAction => ({
  ...workspaceWrite,
  toolName: 'bash',
  capability: 'process.exec',
  approvalClass: 'shell',
  resources: [{
    kind: 'process',
    value: 'bash',
    identity: 'host',
    scope: 'workspace',
  }],
  ...patch,
});

const profilePolicy: PlatformProfilePolicy = {
  defaultPermissionMode: 'ask',
  allowedPermissionModes: ['ask', 'auto_review'],
  requireApproval: ['fs.write'],
  autoApprove: [],
};

function evaluate(patch: Partial<PolicyInput> = {}) {
  return evaluatePolicy({
    action: workspaceWrite,
    grant,
    profilePolicy,
    platformReady: true,
    now,
    ...patch,
  });
}

describe('evaluatePolicy', () => {
  it('allows workspace CRUD in both modes before requireApproval', () => {
    expect(evaluate()).toMatchObject({ decision: 'allow', ruleId: 'workspace.crud' });
    expect(evaluate({
      grant: { ...grant, permissionMode: 'auto_review' },
    })).toMatchObject({ decision: 'allow', ruleId: 'workspace.crud' });
  });

  it('allows scratch CRUD and bound input reads', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        resources: [{
          kind: 'path',
          value: 'C:/scratch/t1/tmp.txt',
          identity: 'file:tmp',
          scope: 'scratch',
        }],
      },
    })).toMatchObject({ decision: 'allow', ruleId: 'workspace.crud' });
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'fs.read',
        risk: 'read',
        resources: [{
          kind: 'path',
          value: 'C:/input/a.pdf',
          identity: 'file:input',
          scope: 'input',
        }],
      },
    }).decision).toBe('allow');
  });

  it('denies a structured write outside the workspace instead of asking', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        resources: [{
          kind: 'path',
          value: 'C:/outside/a.txt',
          identity: 'file:2',
          scope: 'external',
        }],
      },
    })).toMatchObject({
      decision: 'deny',
      ruleId: 'workspace.write-outside',
    });
  });

  it('keeps shell as base ask and never uses autoApprove as allow', () => {
    expect(evaluate({
      action: shellAction(),
      grant: { ...grant, permissionMode: 'auto_review' },
      profilePolicy: { ...profilePolicy, autoApprove: ['process.exec'] },
    })).toMatchObject({ decision: 'ask', ruleId: 'platform.base-ask' });
    expect(evaluate({
      action: shellAction(),
      profilePolicy: { ...profilePolicy, autoApprove: ['process.exec'] },
    })).toMatchObject({ decision: 'ask', ruleId: 'platform.base-ask' });
  });

  it('keeps external writes on the human approval path in both modes', () => {
    const exportAction: SecurityAction = {
      ...workspaceWrite,
      toolName: 'report.export',
      approvalClass: 'human_required',
      resources: [{ kind: 'connector', value: 'report.export', scope: 'external' }],
      externalEffect: 'connector',
    };
    expect(evaluate({
      action: exportAction,
      grant: { ...grant, permissionMode: 'auto_review' },
    })).toMatchObject({ decision: 'ask', ruleId: 'platform.human-required' });
  });

  it('hard-denies critical targets, trust anchors and derived hard deny rules', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        resources: [{ kind: 'path', value: 'C:/', identity: 'dir:root', scope: 'critical' }],
      },
    })).toMatchObject({ decision: 'deny', ruleId: 'platform.critical-target' });
    expect(evaluate({
      action: {
        ...workspaceWrite,
        resources: [{
          kind: 'path',
          value: 'C:/ws/.env',
          identity: 'file:env',
          scope: 'workspace',
          trustAnchor: true,
        }],
      },
    })).toMatchObject({ decision: 'deny', ruleId: 'platform.trust-anchor' });
    expect(evaluate({
      action: shellAction({ hardDenyRule: 'platform.catastrophic-target' }),
      grant: { ...grant, permissionMode: 'auto_review' },
    })).toMatchObject({
      decision: 'deny',
      ruleId: 'platform.catastrophic-target',
    });
  });

  it('denies an action that does not belong to the granted principal or task', () => {
    expect(evaluate({ action: { ...workspaceWrite, taskId: 'other' } }))
      .toMatchObject({ decision: 'deny', ruleId: 'task-grant.identity' });
    expect(evaluate({ action: { ...workspaceWrite, agentId: 'other' } }))
      .toMatchObject({ decision: 'deny', ruleId: 'task-grant.identity' });
    expect(evaluate({ action: { ...workspaceWrite, subjectId: 'attacker' } }))
      .toMatchObject({ decision: 'deny', ruleId: 'task-grant.identity' });
  });

  it('denies expired grants and an unavailable platform', () => {
    expect(evaluate({ now: 2_001 })).toMatchObject({
      decision: 'deny',
      ruleId: 'task-grant.expired',
    });
    expect(evaluate({ platformReady: false })).toMatchObject({
      decision: 'deny',
      ruleId: 'platform.not-ready',
    });
  });

  it('restricts plan mode to reads without touching permission mode', () => {
    expect(evaluate({
      grant: { ...grant, planMode: 'plan', permissionMode: 'auto_review' },
    })).toMatchObject({ decision: 'deny', ruleId: 'plan-mode.read-only' });
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'fs.read',
        approvalClass: 'auto',
        risk: 'read',
      },
      grant: { ...grant, planMode: 'plan' },
    }).decision).toBe('allow');
  });

  it('asks for profile-required capabilities and for unbound expansion', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'fs.read',
        approvalClass: 'auto',
        risk: 'read',
        resources: [{ kind: 'path', value: 'C:/outside/x.txt', identity: 'f', scope: 'external' }],
      },
      profilePolicy: { ...profilePolicy, requireApproval: ['fs.read'] },
    })).toMatchObject({ decision: 'ask', ruleId: 'profile.require-approval' });
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'fs.read',
        approvalClass: 'auto',
        risk: 'read',
        resources: [{ kind: 'path', value: 'C:/outside/x.txt', identity: 'f', scope: 'external' }],
      },
      profilePolicy: { ...profilePolicy, requireApproval: [] },
    })).toMatchObject({ decision: 'ask', ruleId: 'platform.capability-expansion' });
  });

  it('allows a connector call that the task grant already binds', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'connector.invoke',
        approvalClass: 'auto',
        resources: [{ kind: 'connector', value: 'report.export', scope: 'external' }],
        externalEffect: 'connector',
      },
      grant: { ...grant, externalCapabilities: ['report.export'] },
      profilePolicy: { ...profilePolicy, requireApproval: [] },
    })).toMatchObject({ decision: 'allow', ruleId: 'task-grant' });
  });
});
