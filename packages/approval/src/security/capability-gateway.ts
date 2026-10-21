import { randomUUID } from 'node:crypto';
import { actionFingerprint } from './fingerprint.js';
import type { SecurityAction, TaskGrant } from './types.js';

export type CapabilityLeaseStatus = 'active' | 'consumed' | 'revoked';

export interface CapabilityLease {
  id: string;
  taskId: string;
  actionId: string;
  capability: SecurityAction['capability'];
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  status: CapabilityLeaseStatus;
}

export class CapabilityGatewayError extends Error {
  constructor(
    public readonly code:
      | 'LEASE_NOT_FOUND'
      | 'LEASE_CONSUMED'
      | 'LEASE_REVOKED'
      | 'LEASE_EXPIRED'
      | 'FROZEN_TARGET_CHANGED'
      | 'CRITICAL_TARGET'
      | 'TRUST_ANCHOR'
      | 'TASK_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityGatewayError';
  }
}

interface LeaseState {
  lease: CapabilityLease;
  controller: AbortController;
  inFlight: boolean;
}

export class CapabilityGateway {
  private leases = new Map<string, LeaseState>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  issue(action: SecurityAction, grant: TaskGrant): CapabilityLease {
    const now = this.now();
    if (grant.expiresAt <= now) {
      throw new CapabilityGatewayError('TASK_EXPIRED', 'task grant expired');
    }
    if (action.resources.some((resource) => resource.scope === 'critical')) {
      throw new CapabilityGatewayError('CRITICAL_TARGET', 'critical target');
    }
    if (action.resources.some((resource) => resource.trustAnchor)) {
      throw new CapabilityGatewayError('TRUST_ANCHOR', 'trust anchor target');
    }
    if (!action.externalEffect) {
      throw new CapabilityGatewayError(
        'FROZEN_TARGET_CHANGED',
        'external effect type is missing',
      );
    }
    const lease: CapabilityLease = {
      id: randomUUID(),
      taskId: action.taskId,
      actionId: action.id,
      capability: action.capability,
      fingerprint: actionFingerprint(action),
      createdAt: now,
      expiresAt: Math.min(grant.expiresAt, now + 5 * 60_000),
      status: 'active',
    };
    this.leases.set(lease.id, {
      lease,
      controller: new AbortController(),
      inFlight: false,
    });
    return { ...lease };
  }

  assertFrozen(
    action: SecurityAction,
    leaseId: string,
    grant: TaskGrant,
  ): CapabilityLease {
    const state = this.leases.get(leaseId);
    if (!state) {
      throw new CapabilityGatewayError('LEASE_NOT_FOUND', `lease not found: ${leaseId}`);
    }
    if (state.lease.status === 'revoked') {
      throw new CapabilityGatewayError('LEASE_REVOKED', `lease revoked: ${leaseId}`);
    }
    if (state.lease.status === 'consumed') {
      throw new CapabilityGatewayError('LEASE_CONSUMED', `lease consumed: ${leaseId}`);
    }
    if (state.lease.expiresAt <= this.now() || grant.expiresAt <= this.now()) {
      state.lease.status = 'revoked';
      state.controller.abort();
      throw new CapabilityGatewayError('LEASE_EXPIRED', `lease expired: ${leaseId}`);
    }
    if (
      action.taskId !== state.lease.taskId
      || action.id !== state.lease.actionId
      || action.capability !== state.lease.capability
      || actionFingerprint(action) !== state.lease.fingerprint
    ) {
      throw new CapabilityGatewayError(
        'FROZEN_TARGET_CHANGED',
        'frozen target or payload changed',
      );
    }
    return { ...state.lease };
  }

  async execute<T>(
    action: SecurityAction,
    leaseId: string,
    grant: TaskGrant,
    handler: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertFrozen(action, leaseId, grant);
    const state = this.leases.get(leaseId)!;
    state.lease.status = 'consumed';
    state.inFlight = true;
    try {
      return await handler(state.controller.signal);
    } finally {
      state.inFlight = false;
    }
  }

  revokeTask(taskId: string): number {
    let revoked = 0;
    for (const state of this.leases.values()) {
      if (
        state.lease.taskId !== taskId
        || (state.lease.status === 'consumed' && !state.inFlight)
      ) continue;
      state.lease.status = 'revoked';
      state.controller.abort();
      revoked += 1;
    }
    return revoked;
  }

  activeLeaseCount(taskId?: string): number {
    return [...this.leases.values()].filter(({ lease }) =>
      lease.status === 'active' && (taskId === undefined || lease.taskId === taskId),
    ).length;
  }
}
