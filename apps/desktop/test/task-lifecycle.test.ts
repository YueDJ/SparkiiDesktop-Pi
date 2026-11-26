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

  it('checks ownership and admission generation at the grant commit point before replacing a live task', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldStart = lifecycle.start(async () => {
      await oldGate;
      return grant({ taskId: 'old-task' });
    }, () => {
      throw new Error('stale binding');
    }, undefined, 's1');
    await Promise.resolve();
    await lifecycle.start(async () => grant({ taskId: 'replacement-task' }), undefined, undefined, 's1');
    const rejected = expect(oldStart).rejects.toThrow(/admission.*cancelled/i);
    releaseOld();

    await rejected;
    expect(lifecycle.active('s1')?.taskId).toBe('replacement-task');
  });

  it.each(['session-ended', 'workspace-changed', 'runtime-released'] as const)(
    'cancels an uncommitted admission synchronously when the session ends with %s',
    async (reason) => {
      const registry = new TaskGrantRegistry();
      const lifecycle = new TaskLifecycle(registry);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const starting = lifecycle.start(async () => {
        await gate;
        return grant({ taskId: `task-${reason}` });
      }, undefined, undefined, 's1');
      const rejected = expect(starting).rejects.toThrow(/admission.*cancelled/i);

      await lifecycle.end('s1', reason);
      release();

      await rejected;
      expect(lifecycle.active('s1')).toBeUndefined();
      expect(registry.get('s1')).toBeUndefined();
    },
  );

  it('cancels a future grant revoked by task id while its factory is awaiting', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const starting = lifecycle.start(async () => {
      await gate;
      return grant({ taskId: 'revoked-future-task' });
    }, undefined, undefined, 's1');
    const rejected = expect(starting).rejects.toThrow(/admission.*revoked/i);

    await lifecycle.revokeTask('revoked-future-task', 'user');
    release();

    await rejected;
    expect(lifecycle.active('s1')).toBeUndefined();
    expect(registry.get('s1')).toBeUndefined();
  });

  it('allows only the latest concurrent admission to commit when factories resolve out of order', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = lifecycle.start(async () => {
      await firstGate;
      return grant({ taskId: 'first-task' });
    }, undefined, undefined, 's1');
    const second = lifecycle.start(async () => {
      await secondGate;
      return grant({ taskId: 'second-task' });
    }, undefined, undefined, 's1');
    const firstRejected = expect(first).rejects.toThrow(/admission.*cancelled/i);

    releaseSecond();
    await expect(second).resolves.toMatchObject({ taskId: 'second-task' });
    releaseFirst();
    await firstRejected;

    expect(lifecycle.active('s1')?.taskId).toBe('second-task');
    expect(registry.get('s1')?.taskId).toBe('second-task');
  });

  it('rechecks admission after commit and revokes the grant invalidated by onStarted', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    const cancel = vi.fn(async () => {});
    const starting = lifecycle.start(async () => grant(), undefined, (started) => {
      lifecycle.registerCancellation(started.taskId, 'process', cancel);
      void lifecycle.end('s1', 'user');
    }, 's1');

    await expect(starting).rejects.toThrow(/admission.*cancelled/i);
    await lifecycle.revokeTask('t1', 'duplicate');
    expect(lifecycle.active('s1')).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('registers cancellation hooks at grant commit before revocation can overtake startup', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    const cancel = vi.fn(async () => {});
    let registered = false;

    const starting = lifecycle.start(async () => grant(), undefined, (started) => {
      lifecycle.registerCancellation(started.taskId, 'process', cancel);
      registered = true;
      queueMicrotask(() => registry.revoke('s1', 'session-ended'));
    });
    await starting;
    await lifecycle.revokeTask('t1', 'session-ended');

    expect(registered).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('R8 round5 blocker3 makes the old grant non-executable while a replacement is pending', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant({ taskId: 'task-a' }), undefined, undefined, 's1');
    const oldAdmission = lifecycle.currentAdmission('s1')!;
    const oldOwner = lifecycle.owner('s1');
    expect(oldOwner).toEqual({ taskId: 'task-a', admission: oldAdmission });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replacing = lifecycle.start(async () => {
      await gate;
      return grant({ taskId: 'task-b' });
    }, undefined, undefined, 's1');

    expect(lifecycle.active('s1')).toBeUndefined();
    expect(lifecycle.owner('s1')).toBeUndefined();
    expect(() => lifecycle.assertActive('s1', 'task-a')).toThrow(/revoked|replacement|not executable/i);
    expect(() => lifecycle.assertOwner('s1', oldOwner)).toThrow(/revoked|replaced/i);
    expect(lifecycle.currentAdmission('s1')).not.toBe(oldAdmission);
    release();
    await expect(replacing).resolves.toMatchObject({ taskId: 'task-b' });
  });

  it('R8 round5 blocker4 rejects same-session task id reuse before replacement commit', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant({ taskId: 'shared-task' }), undefined, undefined, 's1');
    const cancel = vi.fn(async () => {});
    lifecycle.registerCancellation('shared-task', 'process', cancel);

    await expect(lifecycle.start(async () => grant({ taskId: 'shared-task' }), undefined, undefined, 's1'))
      .rejects.toThrow(/task.*already exists|task id.*reuse/i);
    expect(cancel).not.toHaveBeenCalled();
    expect(lifecycle.active('s1')?.taskId).toBe('shared-task');
    await lifecycle.end('s1', 'user');
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(lifecycle.start(async () => grant({ taskId: 'shared-task' }), undefined, undefined, 's1'))
      .rejects.toThrow(/task.*already exists|task id.*reuse/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('R8 B1 resolves only the exact admission object, never matching session/generation fields', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant({ taskId: 'task-a' }), undefined, undefined, 's1');
    const admission = lifecycle.currentAdmission('s1')!;
    expect(lifecycle.ownerForAdmission('s1', admission)).toEqual({ taskId: 'task-a', admission });
    expect(lifecycle.ownerForAdmission('s1', { ...admission })).toBeUndefined();
    expect(lifecycle.ownerForAdmission('other-session', admission)).toBeUndefined();

    await lifecycle.start(async () => grant({ taskId: 'task-b' }), undefined, undefined, 's1');
    expect(lifecycle.ownerForAdmission('s1', admission)).toBeUndefined();
    const replacement = lifecycle.currentAdmission('s1')!;
    expect(lifecycle.ownerForAdmission('s1', replacement)).toEqual({ taskId: 'task-b', admission: replacement });
  });

  it('keeps one task isolated from another session', async () => {
    const registry = new TaskGrantRegistry();
    const lifecycle = new TaskLifecycle(registry);
    await lifecycle.start(async () => grant());
    await lifecycle.start(async () => grant({ taskId: 't2', sessionId: 's2' }));
    expect(() => lifecycle.assertActive('s1', 't2')).toThrow();
  });
});
