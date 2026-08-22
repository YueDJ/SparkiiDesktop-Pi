import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { AuditStore } from '../src/audit.js';
import { Rbac } from '@sparkii/identity';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

const policy = { requireApproval: ['report.export'], timeoutMs: 1000, highRiskDoubleConfirm: true };
const rbac = new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]);

describe('ApprovalGate', () => {
  it('approves by an authorized actor and audits both events', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const out = await gate.decide(p.id, { userId: 'u1', roles: ['admin'] }, true, 'ok');
    expect(out.status).toBe('approved');
    expect((await audit.query({})).map((e) => e.action)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.approved']));
  });
  it('denies unauthorized approver', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac: new Rbac([{ name: 'viewer', pages: [], tools: [], canApprove: [] }]), audit });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await expect(gate.decide(p.id, { userId: 'u2', roles: ['viewer'] }, true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
