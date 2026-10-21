import { describe, expect, it, vi } from 'vitest';
import {
  TaskGrantRegistry,
  type SecurityAction,
  type TaskGrant,
  type WorkspacePathProbe,
} from '@sparkii/approval';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createActionNormalizer,
} from '../electron/main/security/action-normalizer.js';
import { TaskLifecycle } from '../electron/main/security/task-lifecycle.js';
import { createRuntimeActionRouter } from '../electron/main/security/runtime-action-router.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const probe: WorkspacePathProbe = {
  inspect: async (target) => ({
    displayPath: target,
    canonicalPath: target,
    identity: `object:${key(target)}`,
    nearestExistingAncestor: target,
    isDirectory: true,
    isReparsePoint: false,
    exists: true,
  }),
  isSameOrDescendant: async (root, target) => {
    const r = key(root);
    const t = key(target);
    return t === r || t.startsWith(`${r}/`);
  },
  isSameObject: async (left, right) => key(left) === key(right),
};

function grant(patch: Partial<TaskGrant> = {}): TaskGrant {
  return {
    taskId: 't1',
    sessionId: 's1',
    agentId: 'general',
    profileId: 'general',
    mode: 'standard',
    workspaceRoot: 'C:/ws',
    workspaceIdentity: 'object:c:/ws',
    inputRoots: [],
    scratchRoot: 'C:/scratch/t1',
    networkDomains: [],
    externalCapabilities: [],
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    ...patch,
  };
}

async function harness() {
  const registry = new TaskGrantRegistry();
  const lifecycle = new TaskLifecycle(registry);
  await lifecycle.start(async () => grant());
  const auditEvents: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (_action: SecurityAction, _grant: TaskGrant) => ({
    result: { ok: true },
  }));
  const requestApproval = vi.fn(async () => ({ approved: true }));
  const revalidate = vi.fn(async () => true);
  const router = createRuntimeActionRouter({
    lifecycle,
    normalizer: createActionNormalizer({
      descriptors: DEFAULT_TOOL_DESCRIPTORS,
      protectedRoots: [
        { path: 'C:/Users/me', policy: 'boundary' },
        { path: 'C:/Windows', policy: 'closure' },
      ],
      probe,
    }),
    profilePolicyOf: () => ({ mode: 'standard' }),
    platformReady: () => true,
    execute,
    requestApproval,
    revalidate,
    audit: {
      append: async (event) => {
        auditEvents.push(event as Record<string, unknown>);
      },
    },
  });
  return { registry, lifecycle, router, execute, requestApproval, revalidate, auditEvents };
}

const write = (args: Record<string, unknown>) => ({
  requestId: 'r1',
  toolCallId: 'call-1',
  toolName: 'write',
  args,
});

describe('createRuntimeActionRouter', () => {
  it('executes an ordinary workspace write without requesting approval', async () => {
    const h = await harness();
    const result = await h.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x', risk: 'read', summary: 'safe' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'workspace.write' },
      result: { ok: true },
    });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'fs.write',
      risk: 'write',
      resources: [expect.objectContaining({ scope: 'workspace' })],
    }), expect.objectContaining({ taskId: 't1' }));
    expect(h.auditEvents.map((event) => event.action)).toEqual([
      'action.allowed',
      'action.executed',
    ]);
  });

  it('requests one capability approval for an out-of-workspace target', async () => {
    const h = await harness();
    const result = await h.router.route(
      write({ path: 'C:/outside/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'executed',
      decision: { decision: 'ask', ruleId: 'platform.capability-expansion' },
    });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('hard-denies critical targets before approval or execution', async () => {
    const h = await harness();
    const result = await h.router.route(
      write({ path: 'C:/Windows/System32/drivers/etc/hosts', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'platform.critical-target' },
    });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects execution when the task is revoked while approval is pending', async () => {
    const h = await harness();
    h.requestApproval.mockImplementationOnce(async () => {
      await h.lifecycle.end('s1', 'user');
      return { approved: true };
    });
    const result = await h.router.route(
      write({ path: 'C:/outside/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'TASK_REVOKED' },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects execution when the target identity changes after approval', async () => {
    const h = await harness();
    h.revalidate.mockResolvedValueOnce(false);
    const result = await h.router.route(
      write({ path: 'C:/outside/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'TARGET_CHANGED' },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('returns a failed result when the execution plane throws', async () => {
    const h = await harness();
    h.execute.mockRejectedValueOnce(new Error('disk unavailable'));
    const result = await h.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'ACTION_EXECUTION_FAILED', message: 'disk unavailable' },
    });
  });
});
