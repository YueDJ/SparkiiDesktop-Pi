/**
 * "Allow Shell for this task" needs only a task id: the TaskGrant it belongs to
 * already binds session, actor, profile, workspace and permission mode, and it
 * expires with the task.
 */
export class ShellGrantStore {
  private grants = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  grant(taskId: string, expiresAt: number): void {
    this.grants.set(taskId, expiresAt);
  }

  allows(taskId: string): boolean {
    const expiresAt = this.grants.get(taskId);
    if (expiresAt !== undefined && expiresAt > this.now()) return true;
    this.grants.delete(taskId);
    return false;
  }

  revoke(taskId: string): void {
    this.grants.delete(taskId);
  }

  clear(): void {
    this.grants.clear();
  }
}
