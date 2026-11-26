import {
  TaskGrantRegistry,
  type TaskGrant,
  type TaskRevokeReason,
} from '@sparkii/approval';

export type CancellationHook = () => void | Promise<void>;

export interface TaskAdmissionToken {
  readonly sessionId: string;
  readonly generation: number;
}

interface AdmissionEntry {
  token: TaskAdmissionToken;
  state: 'pending' | 'committed' | 'cancelled';
  taskId?: string;
  factorySettled: boolean;
  previous?: AdmissionEntry;
}

export interface TaskOwner {
  readonly taskId: string;
  readonly admission?: TaskAdmissionToken;
}

interface CancellationHookEntry {
  name: string;
  hook: CancellationHook;
}

export class TaskLifecycle {
  private hooks = new Map<string, CancellationHookEntry[]>();
  private pending = new Map<string, Promise<void>[]>();
  private admissions = new Map<string, AdmissionEntry>();
  private admissionGeneration = 0;
  private pendingAdmissions = 0;
  private revokedTaskIds = new Set<string>();

  constructor(
    private readonly registry: TaskGrantRegistry,
    private readonly onCancellationError?: (
      taskId: string,
      name: string,
      error: unknown,
    ) => void,
  ) {
    this.registry.onRevoke((taskId) => this.beginCancellation(taskId));
  }

  async start(
    factory: () => Promise<TaskGrant>,
    beforeCommit?: (admission: TaskAdmissionToken) => void,
    onStarted?: (grant: TaskGrant) => void,
    sessionId?: string,
  ): Promise<TaskGrant> {
    const previous = sessionId ? this.admissions.get(sessionId) : undefined;
    const token = sessionId
      ? Object.freeze({ sessionId, generation: ++this.admissionGeneration })
      : undefined;
    const entry: AdmissionEntry | undefined = token
      ? { token, state: 'pending', factorySettled: false, previous }
      : undefined;
    if (sessionId && entry) {
      this.admissions.set(sessionId, entry);
      this.pendingAdmissions += 1;
    }

    let grant: TaskGrant;
    try {
      grant = await factory();
    } catch (error) {
      this.failAdmission(entry);
      throw error;
    }
    try {
      try {
        beforeCommit?.(token!);
      } catch (error) {
        throw new Error(`session ${grant.sessionId} admission cancelled: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.assertAdmission(entry, grant, 'cancelled');
      if (entry) entry.taskId = grant.taskId;
      this.registry.start(grant);
    } catch (error) {
      this.failAdmission(entry);
      throw error;
    }
    if (entry) {
      entry.state = 'committed';
      if (entry.previous) entry.previous.state = 'cancelled';
    }
    this.finishAdmission(entry);
    try {
      onStarted?.(grant);
    } catch (error) {
      this.revokeAdmissionGrant(entry, grant, 'runtime-released');
      throw error;
    }

    try {
      this.assertCommittedAdmission(entry);
    } catch (error) {
      this.revokeAdmissionGrant(entry, grant, 'runtime-released');
      throw error;
    }
    return grant;
  }

  currentAdmission(sessionId: string): TaskAdmissionToken | undefined {
    const entry = this.admissions.get(sessionId);
    return entry && entry.state !== 'cancelled' ? entry.token : undefined;
  }

  isCurrentAdmission(sessionId: string, token: TaskAdmissionToken): boolean {
    const entry = this.admissions.get(sessionId);
    return entry?.token === token && entry.state !== 'cancelled';
  }

  assertCurrentAdmission(sessionId: string, token: TaskAdmissionToken): void {
    if (!this.isCurrentAdmission(sessionId, token)) {
      throw new Error(`session ${sessionId} admission is no longer current`);
    }
  }

  /** Atomic task/admission ownership snapshot for request routing. */
  owner(sessionId: string): TaskOwner | undefined {
    const entry = this.admissions.get(sessionId);
    if (entry && entry.state !== 'committed') return undefined;
    const grant = this.registry.get(sessionId);
    if (!grant) return undefined;
    if (entry && entry.taskId !== grant.taskId) return undefined;
    return Object.freeze(entry
      ? { taskId: grant.taskId, admission: entry.token }
      : { taskId: grant.taskId });
  }

  /** Resolve only the exact committed admission supplied by Main's origin registry. */
  ownerForAdmission(sessionId: string, admission: TaskAdmissionToken): TaskOwner | undefined {
    const entry = this.admissions.get(sessionId);
    if (!entry || entry.token !== admission || entry.state !== 'committed' || !entry.taskId) return undefined;
    const grant = this.registry.get(sessionId);
    if (!grant || grant.taskId !== entry.taskId) return undefined;
    return Object.freeze({ taskId: grant.taskId, admission: entry.token });
  }

  assertOwner(sessionId: string, expected?: TaskOwner): TaskOwner {
    const current = this.owner(sessionId);
    if (!current
      || (expected !== undefined && (
        current.taskId !== expected.taskId
        || current.admission !== expected.admission
      ))) {
      throw new Error('task grant revoked, expired, replaced, or belongs to another task');
    }
    return current;
  }

  active(sessionId: string): TaskGrant | undefined {
    return this.owner(sessionId) === undefined ? undefined : this.registry.get(sessionId);
  }

  assertActive(sessionId: string, taskId?: string): TaskGrant {
    const owner = this.owner(sessionId);
    const grant = owner ? this.registry.get(sessionId) : undefined;
    if (!owner || !grant || (taskId !== undefined && grant.taskId !== taskId)) {
      throw new Error('task grant revoked, expired, or belongs to another task');
    }
    return grant;
  }

  registerCancellation(
    taskId: string,
    name: string,
    hook: CancellationHook,
  ): () => void {
    const entries = this.hooks.get(taskId) ?? [];
    const entry = { name, hook };
    entries.push(entry);
    this.hooks.set(taskId, entries);
    return () => {
      const current = this.hooks.get(taskId);
      if (!current) return;
      const next = current.filter((candidate) => candidate !== entry);
      if (next.length) this.hooks.set(taskId, next);
      else this.hooks.delete(taskId);
    };
  }

  async end(
    sessionId: string,
    reason: TaskRevokeReason,
    admission?: TaskAdmissionToken,
  ): Promise<void> {
    if (admission && !this.isCurrentAdmission(sessionId, admission)) return;
    const entry = this.admissions.get(sessionId);
    if (entry) entry.state = 'cancelled';
    this.admissions.delete(sessionId);
    const taskId = this.registry.get(sessionId)?.taskId;
    this.registry.revoke(sessionId, reason);
    if (!taskId) return;
    await this.flush(taskId);
  }

  async revokeTask(
    taskId: string,
    reason: TaskRevokeReason,
    admission?: TaskAdmissionToken,
  ): Promise<void> {
    if (admission) {
      const entry = this.admissions.get(admission.sessionId);
      if (entry?.token !== admission || entry.taskId !== taskId || entry.state === 'cancelled') return;
      entry.state = 'cancelled';
      this.admissions.delete(admission.sessionId);
    } else {
      for (const [sessionId, entry] of this.admissions) {
        if (entry.taskId === taskId) {
          entry.state = 'cancelled';
          this.admissions.delete(sessionId);
        }
      }
      // A factory has not revealed its task ID yet. Keep a bounded barrier so
      // revokeTask can also cancel that future grant without touching peers.
      if (this.pendingAdmissions > 0) this.revokedTaskIds.add(taskId);
    }
    this.registry.revokeTask(taskId, reason);
    await this.flush(taskId);
  }

  private assertAdmission(
    entry: AdmissionEntry | undefined,
    grant: TaskGrant,
    reason: 'cancelled' | 'revoked',
  ): void {
    if (!entry) return;
    const current = this.admissions.get(entry.token.sessionId);
    if (current?.token !== entry.token || entry.state !== 'pending'
      || grant.sessionId !== entry.token.sessionId) {
      throw new Error(`session ${entry.token.sessionId} admission ${reason}`);
    }
    if (this.revokedTaskIds.has(grant.taskId)) {
      throw new Error(`session ${entry.token.sessionId} admission revoked`);
    }
  }

  private assertCommittedAdmission(entry: AdmissionEntry | undefined): void {
    if (!entry) return;
    const current = this.admissions.get(entry.token.sessionId);
    if (current?.token !== entry.token || entry.state === 'cancelled') {
      throw new Error(`session ${entry.token.sessionId} admission cancelled after commit`);
    }
  }

  private failAdmission(entry: AdmissionEntry | undefined): void {
    if (!entry) return;
    entry.state = 'cancelled';
    if (this.admissions.get(entry.token.sessionId) === entry) {
      const previous = entry.previous;
      if (previous?.state === 'committed'
        && this.registry.get(entry.token.sessionId)?.taskId === previous.taskId) {
        this.admissions.set(entry.token.sessionId, previous);
      } else {
        // A newer pending admission may still own this slot. Keep a cancelled
        // barrier so the old registry grant cannot become executable again.
        this.registry.revoke(entry.token.sessionId, 'replaced');
      }
    }
    this.finishAdmission(entry);
  }

  private finishAdmission(entry: AdmissionEntry | undefined): void {
    if (!entry || entry.factorySettled) return;
    entry.factorySettled = true;
    this.pendingAdmissions -= 1;
    if (this.pendingAdmissions === 0) this.revokedTaskIds.clear();
  }

  private revokeAdmissionGrant(
    entry: AdmissionEntry | undefined,
    grant: TaskGrant,
    reason: TaskRevokeReason,
  ): void {
    if (!entry) {
      this.registry.revokeTask(grant.taskId, reason);
      return;
    }
    entry.state = 'cancelled';
    if (this.admissions.get(entry.token.sessionId) === entry) {
      this.admissions.delete(entry.token.sessionId);
    }
    const replacement = this.admissions.get(entry.token.sessionId);
    // A newer committed admission already replaced this grant in the registry,
    // even when a forced task ID is reused. Never revoke that replacement.
    if (replacement?.state === 'committed') return;
    this.registry.revokeTask(grant.taskId, reason);
  }

  private beginCancellation(taskId: string): void {
    const entries = this.hooks.get(taskId) ?? [];
    this.hooks.delete(taskId);
    const pending = entries.map(async ({ name, hook }) => {
      try {
        await hook();
      } catch (error) {
        this.onCancellationError?.(taskId, name, error);
      }
    });
    this.pending.set(taskId, pending);
  }

  private async flush(taskId: string): Promise<void> {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    await Promise.allSettled(pending);
    this.pending.delete(taskId);
  }
}
