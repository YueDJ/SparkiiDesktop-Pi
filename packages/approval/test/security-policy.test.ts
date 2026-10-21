import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
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
  mode: 'standard',
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
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'write',
  capability: 'fs.write',
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

function evaluate(patch: Partial<PolicyInput> = {}) {
  return evaluatePolicy({
    action: workspaceWrite,
    grant,
    profilePolicy: { mode: 'standard' },
    platformReady: true,
    now,
    ...patch,
  });
}

describe('evaluatePolicy', () => {
  it('allows ordinary workspace writes in standard mode', () => {
    expect(evaluate()).toMatchObject({
      decision: 'allow',
      ruleId: 'workspace.write',
    });
  });

  it('allows workspace reads, scratch, and sandboxed process execution', () => {
    expect(evaluate({
      action: { ...workspaceWrite, capability: 'fs.read', risk: 'read' },
    }).decision).toBe('allow');
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
    }).decision).toBe('allow');
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'process.exec',
        resources: [{
          kind: 'process',
          value: 'bash',
          identity: 'bash:1',
          scope: 'workspace',
        }],
      },
    }).decision).toBe('allow');
  });

  it('hard-denies a critical target before profile auto approval', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        resources: [{ kind: 'path', value: 'C:/', identity: 'dir:root', scope: 'critical' }],
      },
      profilePolicy: { autoApprove: ['fs.write'] },
    })).toMatchObject({
      decision: 'deny',
      ruleId: 'platform.critical-target',
    });
  });

  it('hard-denies a trust anchor even when the target is inside the workspace', () => {
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
      profilePolicy: { autoApprove: ['fs.write'] },
    })).toMatchObject({
      decision: 'deny',
      ruleId: 'platform.trust-anchor',
    });
  });

  it('denies a grant for another task or principal', () => {
    expect(evaluate({
      action: { ...workspaceWrite, taskId: 'other' },
    })).toMatchObject({ decision: 'deny', ruleId: 'task-grant.identity' });
    expect(evaluate({
      action: { ...workspaceWrite, agentId: 'other' },
    })).toMatchObject({ decision: 'deny', ruleId: 'task-grant.identity' });
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

  it('blocks writes and processes in plan mode but allows workspace reads', () => {
    expect(evaluate({
      grant: { ...grant, mode: 'plan' },
      profilePolicy: { mode: 'plan' },
    })).toMatchObject({ decision: 'deny', ruleId: 'plan-mode.read-only' });
    expect(evaluate({
      action: { ...workspaceWrite, capability: 'fs.read', risk: 'read' },
      grant: { ...grant, mode: 'plan' },
      profilePolicy: { mode: 'plan' },
    }).decision).toBe('allow');
  });

  it('asks for workspace writes and processes in strict mode', () => {
    expect(evaluate({
      grant: { ...grant, mode: 'strict' },
      profilePolicy: { mode: 'strict' },
    })).toMatchObject({ decision: 'ask', ruleId: 'strict-mode.confirmation' });
  });

  it('uses requireApproval to elevate a grant-native action', () => {
    expect(evaluate({
      profilePolicy: { mode: 'standard', requireApproval: ['fs.write'] },
    })).toMatchObject({ decision: 'ask', ruleId: 'profile.require-approval' });
  });

  it('uses autoApprove only after hard checks and an ask-worthy capability', () => {
    const network: SecurityAction = {
      ...workspaceWrite,
      capability: 'net.connect',
      resources: [{
        kind: 'domain',
        value: 'registry.npmjs.org',
        scope: 'external',
      }],
      risk: 'write',
      externalEffect: 'network',
    };
    expect(evaluate({
      action: network,
      profilePolicy: { autoApprove: ['net.connect'] },
    })).toMatchObject({
      decision: 'allow',
      ruleId: 'profile.auto-approve',
      autoApproved: true,
    });
  });

  it('asks when a supported capability is outside the task grant', () => {
    expect(evaluate({
      action: {
        ...workspaceWrite,
        capability: 'fs.read',
        resources: [{
          kind: 'path',
          value: 'C:/outside/secret.txt',
          identity: 'file:2',
          scope: 'external',
        }],
      },
    })).toMatchObject({
      decision: 'ask',
      ruleId: 'platform.capability-expansion',
    });
  });
});
