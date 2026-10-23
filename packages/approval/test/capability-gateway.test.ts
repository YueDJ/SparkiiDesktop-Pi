import { describe, expect, it } from 'vitest';
import {
  CapabilityGateway,
  actionFingerprint,
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
  scratchRoot: 'C:/scratch',
  networkDomains: ['api.example.com'],
  externalCapabilities: ['report.export'],
  createdAt: 1,
  expiresAt: 10_000,
};

const action = (patch: Partial<SecurityAction> = {}): SecurityAction => ({
  id: 'a1',
  subjectId: 'u1',
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'report.export',
  capability: 'connector.invoke',
  approvalClass: 'human_required',
  resources: [{
    kind: 'connector',
    value: 'report.export',
    scope: 'external',
  }],
  payload: { title: 'report' },
  payloadHash: 'hash-1',
  risk: 'write',
  reason: 'export report',
  externalEffect: 'connector',
  ...patch,
});

function gateway(clock = () => now) {
  return new CapabilityGateway({ now: clock });
}

describe('CapabilityGateway', () => {
  it('executes one frozen external action and consumes the lease', async () => {
    const g = gateway();
    const a = action();
    const lease = g.issue(a, grant);
    expect(lease.fingerprint).toBe(actionFingerprint(a));
    await expect(g.execute(a, lease.id, grant, async () => ({ ok: true })))
      .resolves.toEqual({ ok: true });
    await expect(g.execute(a, lease.id, grant, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: 'LEASE_CONSUMED' });
  });

  it('rejects changed payload hashes or target identities', () => {
    const g = gateway();
    const a = action();
    const lease = g.issue(a, grant);
    expect(() => g.assertFrozen(a, lease.id, grant)).not.toThrow();
    expect(() => g.assertFrozen({ ...a, payloadHash: 'hash-2' }, lease.id, grant))
      .toThrow(/changed/i);
    expect(() => g.assertFrozen(action({
      resources: [{
        kind: 'connector',
        value: 'report.export',
        identity: 'different',
        scope: 'external',
      }],
    }), lease.id, grant)).toThrow(/changed/i);
  });

  it('rejects expired grants, critical targets, and trust anchors', () => {
    const g = gateway(() => 20_000);
    expect(() => g.issue(action(), grant)).toThrow(/expired/i);
    const live = gateway();
    expect(() => live.issue(action({
      resources: [{ kind: 'path', value: 'C:/', identity: 'root', scope: 'critical' }],
    }), grant)).toThrow(/critical/i);
    expect(() => live.issue(action({
      resources: [{
        kind: 'path',
        value: 'C:/ws/.env',
        identity: 'env',
        scope: 'external',
        trustAnchor: true,
      }],
    }), grant)).toThrow(/trust anchor/i);
  });

  it('revokes leases and aborts an in-flight external effect', async () => {
    const g = gateway();
    const a = action();
    const lease = g.issue(a, grant);
    let signal: AbortSignal | undefined;
    const running = g.execute(a, lease.id, grant, async (executionSignal) => {
      signal = executionSignal;
      await new Promise<void>((_, reject) => {
        executionSignal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    await Promise.resolve();
    expect(g.revokeTask('t1')).toBe(1);
    expect(signal?.aborted).toBe(true);
    await expect(running).rejects.toThrow(/aborted/);
    expect(() => g.assertFrozen(a, lease.id, grant)).toThrow(/revoked/i);
  });

  it('allows a task to have multiple scoped leases without sharing ids', () => {
    const g = gateway();
    const first = g.issue(action({ id: 'a1' }), grant);
    const second = g.issue(action({
      id: 'a2',
      payloadHash: 'hash-2',
    }), grant);
    expect(first.id).not.toBe(second.id);
    expect(g.activeLeaseCount('t1')).toBe(2);
  });
});
