import { describe, expect, it, vi } from 'vitest';
import {
  TaskGrantRegistry,
  type TaskGrant,
} from '@sparkii/approval';
import { TaskLifecycle } from '../electron/main/security/task-lifecycle.js';

function grant(patch: Partial<TaskGrant> = {}): TaskGrant {
  return {
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
    expiresAt: Date.now() + 60_000,
    ...patch,
  };
}

describe('TaskLifecycle', () => {
  it('starts a live grant and rejects actions after end', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await expect(lifecycle.start(async () => grant())).resolves.toMatchObject({
      taskId: 't1',
    });
    expect(lifecycle.assertActive('s1', 't1').workspaceRoot).toBe('C:/ws');
    await lifecycle.end('s1', 'session-ended');
    expect(() => lifecycle.assertActive('s1', 't1')).toThrow(/revoked/);
  });

  it('runs process, network, and gateway cancellation hooks once and waits for them', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant());
    let complete!: () => void;
    const slow = new Promise<void>((resolve) => { complete = resolve; });
    const processCancel = vi.fn(() => slow);
    const networkCancel = vi.fn(async () => {});
    const gatewayCancel = vi.fn(async () => {});
    lifecycle.registerCancellation('t1', 'process', processCancel);
    lifecycle.registerCancellation('t1', 'network', networkCancel);
    lifecycle.registerCancellation('t1', 'gateway', gatewayCancel);

    const ending = lifecycle.end('s1', 'user');
    await Promise.resolve();
    expect(processCancel).toHaveBeenCalledTimes(1);
    expect(networkCancel).toHaveBeenCalledTimes(1);
    expect(gatewayCancel).toHaveBeenCalledTimes(1);
    complete();
    await ending;
    await lifecycle.end('s1', 'duplicate');
    expect(processCancel).toHaveBeenCalledTimes(1);
  });

  it('revokes the previous task when a replacement grant starts', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant());
    const cancel = vi.fn(async () => {});
    lifecycle.registerCancellation('t1', 'old', cancel);
    await lifecycle.start(async () => grant({ taskId: 't2' }));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lifecycle.active('s1')?.taskId).toBe('t2');
  });

  it('keeps one task isolated from another session', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant());
    await lifecycle.start(async () => grant({ taskId: 't2', sessionId: 's2' }));
    expect(() => lifecycle.assertActive('s1', 't2')).toThrow();
  });
});
