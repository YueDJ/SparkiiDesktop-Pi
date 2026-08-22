import type { RoleConfig } from '@sparkii/config';
import type { Subject } from './types.js';

export class Rbac {
  constructor(private roles: RoleConfig[]) {}
  private rolesOf(s: Subject) { return this.roles.filter((r) => s.roles.includes(r.name)); }
  can(s: Subject, permission: string): boolean {
    return this.rolesOf(s).some((r) => r.tools.includes(permission) || r.pages.includes(permission));
  }
  canApprove(s: Subject, risk: 'write' | 'high-risk'): boolean {
    return this.rolesOf(s).some((r) => r.canApprove.includes(risk));
  }
  visiblePages(s: Subject): string[] {
    return [...new Set(this.rolesOf(s).flatMap((r) => r.pages))];
  }
  allowedTools(s: Subject): string[] {
    return [...new Set(this.rolesOf(s).flatMap((r) => r.tools))];
  }
}
