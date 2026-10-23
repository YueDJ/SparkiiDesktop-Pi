import {
  TaskGrantRegistry,
  type TaskGrant,
  type TaskRevokeReason,
} from '@sparkii/approval';

export type CancellationHook = () => void | Promise<void>;

interface CancellationHookEntry {
  name: string;
  hook: CancellationHook;
}

export class TaskLifecycle {
  private hooks = new Map<string, CancellationHookEntry[]>();
  private pending = new Map<string, Promise<void>[]>();

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

  async start(factory: () => Promise<TaskGrant>): Promise<TaskGrant> {
    const grant = await factory();
    this.registry.start(grant);
    return grant;
  }

  active(sessionId: string): TaskGrant | undefined {
    return this.registry.get(sessionId);
  }

  assertActive(sessionId: string, taskId?: string): TaskGrant {
    const grant = this.registry.get(sessionId);
    if (!grant || (taskId !== undefined && grant.taskId !== taskId)) {
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
  ): Promise<void> {
    const taskId = this.registry.get(sessionId)?.taskId;
    this.registry.revoke(sessionId, reason);
    if (!taskId) return;
    await this.flush(taskId);
  }

  async revokeTask(
    taskId: string,
    reason: TaskRevokeReason,
  ): Promise<void> {
    this.registry.revokeTask(taskId, reason);
    await this.flush(taskId);
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
