import { describe, it, expect } from 'vitest';
import { Rbac } from '../src/rbac.js';

describe('Rbac', () => {
  const rbac = new Rbac([
    { name: 'reviewer', pages: ['home'], tools: ['document.read'], canApprove: ['write'] },
    { name: 'admin', pages: ['home', 'audit'], tools: ['document.read', 'report.export'], canApprove: ['write', 'high-risk'] },
  ]);
  it('grants only listed tools and pages', () => {
    const s = { userId: 'u1', roles: ['reviewer'] };
    expect(rbac.can(s, 'report.export')).toBe(false);
    expect(rbac.allowedTools(s)).toEqual(['document.read']);
    expect(rbac.visiblePages(s)).toEqual(['home']);
  });
  it('approval follows the union of roles', () => {
    expect(rbac.canApprove({ userId: 'u1', roles: ['reviewer'] }, 'write')).toBe(true);
    expect(rbac.canApprove({ userId: 'u1', roles: ['reviewer'] }, 'high-risk')).toBe(false);
  });
});
