import { describe, expect, it, vi } from 'vitest';
import {
  TaskGrantRegistry,
  type TaskGrant,
} from '../src/security/index.js';

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
    expiresAt: 2_000,
    ...patch,
  };
}

describe('TaskGrantRegistry', () => {
  it('isolates grants by session and invokes revoke listeners once', () => {
    const registry = new TaskGrantRegistry({ now: () => 1_000 });
    const revoked: Array<[string, string]> = [];
    registry.start(grant());
    registry.onRevoke((taskId, reason) => revoked.push([taskId, reason]));

    expect(registry.get('s1')?.taskId).toBe('t1');
    expect(registry.get('s2')).toBeUndefined();

    registry.revoke('s1', 'user');
    registry.revoke('s1', 'duplicate');
    expect(registry.get('s1')).toBeUndefined();
    expect(revoked).toEqual([['t1', 'user']]);
  });

  it('expires a grant on access and rejects actions after expiry', () => {
    let now = 1_000;
    const registry = new TaskGrantRegistry({ now: () => now });
    const revoked = vi.fn();
    registry.start(grant());
    registry.onRevoke(revoked);

    now = 2_000;
    expect(registry.get('s1')).toBeUndefined();
    expect(() => registry.assertActive('t1', 's1')).toThrow(/expired/);
    expect(revoked).toHaveBeenCalledWith('t1', 'expired');
  });

  it('revokes a replaced grant for the same session', () => {
    const registry = new TaskGrantRegistry({ now: () => 1_000 });
    const reasons: string[] = [];
    registry.onRevoke((_, reason) => reasons.push(reason));
    registry.start(grant());
    registry.start(grant({ taskId: 't2' }));

    expect(registry.get('s1')?.taskId).toBe('t2');
    expect(reasons).toEqual(['replaced']);
  });

  it('does not allow one task id to be reused by another session', () => {
    const registry = new TaskGrantRegistry({ now: () => 1_000 });
    registry.start(grant());
    expect(() => registry.start(grant({ sessionId: 's2' }))).toThrow(/already exists/);
  });

  it('returns immutable snapshots so callers cannot widen a live grant', () => {
    const registry = new TaskGrantRegistry({ now: () => 1_000 });
    registry.start(grant());
    const snapshot = registry.get('s1')!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.inputRoots)).toBe(true);
  });

  it('revokes by task id and supports listener unsubscribe', () => {
    const registry = new TaskGrantRegistry({ now: () => 1_000 });
    const listener = vi.fn();
    const off = registry.onRevoke(listener);
    registry.start(grant());
    off();
    registry.revokeTask('t1', 'parent-cancelled');
    expect(listener).not.toHaveBeenCalled();
    expect(registry.get('s1')).toBeUndefined();
  });
});
