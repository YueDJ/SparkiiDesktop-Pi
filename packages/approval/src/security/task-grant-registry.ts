import type { TaskGrant } from './types.js';

export type TaskRevokeReason =
  | 'user'
  | 'parent-cancelled'
  | 'expired'
  | 'replaced'
  | 'session-ended'
  | 'workspace-changed'
  | 'runtime-released'
  | string;

type RevokeListener = (taskId: string, reason: TaskRevokeReason) => void;

function freezeGrant(grant: TaskGrant): TaskGrant {
  const copy = structuredClone(grant);
  for (const root of copy.inputRoots) Object.freeze(root);
  Object.freeze(copy.inputRoots);
  Object.freeze(copy.networkDomains);
  Object.freeze(copy.externalCapabilities);
  return Object.freeze(copy);
}

/**
 * Live Task Grants are process-local control-plane state. They are deliberately
 * not persisted: after an application restart the workspace and policy must be
 * admitted again.
 */
export class TaskGrantRegistry {
  private grants = new Map<string, TaskGrant>();
  private listeners = new Set<RevokeListener>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(grant: TaskGrant): void {
    for (const existing of this.grants.values()) {
      if (existing.taskId === grant.taskId && existing.sessionId !== grant.sessionId) {
        throw new Error(`task grant already exists: ${grant.taskId}`);
      }
    }
    if (this.grants.has(grant.sessionId)) {
      this.revoke(grant.sessionId, 'replaced');
    }
    this.grants.set(grant.sessionId, freezeGrant(grant));
  }

  get(sessionId: string): TaskGrant | undefined {
    const grant = this.grants.get(sessionId);
    if (!grant) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.revoke(sessionId, 'expired');
      return undefined;
    }
    return freezeGrant(grant);
  }

  assertActive(taskId: string, sessionId: string): TaskGrant {
    const grant = this.get(sessionId);
    if (!grant || grant.taskId !== taskId) {
      throw new Error(`task grant expired or revoked: ${taskId}`);
    }
    return grant;
  }

  revoke(sessionId: string, reason: TaskRevokeReason): void {
    const grant = this.grants.get(sessionId);
    if (!grant) return;
    this.grants.delete(sessionId);
    this.emit(grant.taskId, reason);
  }

  revokeTask(taskId: string, reason: TaskRevokeReason): void {
    const entry = [...this.grants.entries()]
      .find(([, grant]) => grant.taskId === taskId);
    if (!entry) return;
    this.grants.delete(entry[0]);
    this.emit(entry[1].taskId, reason);
  }

  onRevoke(listener: RevokeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(taskId: string, reason: TaskRevokeReason): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(taskId, reason);
      } catch {
        // Revocation must continue for every interested subsystem.
      }
    }
  }
}
