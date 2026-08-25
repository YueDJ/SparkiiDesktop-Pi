import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { AuditStore } from '../src/audit.js';
import { Rbac, type Subject } from '@sparkii/identity';

const admin: Subject = { userId: 'u1', roles: ['admin'] };
const reviewer: Subject = { userId: 'u2', roles: ['reviewer'] };

function makeGate() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const audit = new AuditStore(join(dir, 'audit.db'));
  const gate = new ApprovalGate({ audit });
  gate.configureProfile('general', {
    policy: { requireApproval: [], timeoutMs: 0, highRiskDoubleConfirm: false },
    rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
  });
  gate.configureProfile('contract', {
    policy: { requireApproval: [], timeoutMs: 60_000, highRiskDoubleConfirm: true },
    rbac: new Rbac([{ name: 'reviewer', pages: [], tools: [], canApprove: ['write'] }]),
  });
  return gate;
}

describe('ApprovalGate multi-profile', () => {
  it('applies per-profile rbac for approval', async () => {
    const gate = makeGate();
    const p = await gate.submit({ toolName: 'edit', targetSystem: 'general', summary: 'x', payload: { path: '/tmp/x' }, risk: 'write' }, { profileId: 'general', sessionId: 's1', actor: 'agent' });
    await expect(gate.decide(p.id, reviewer, true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const ok = await gate.decide(p.id, admin, true);
    expect(ok.status).toBe('approved');
  });

  it('applies per-profile timeout for expiry', async () => {
    const gate = makeGate();
    const p = await gate.submit({ toolName: 'bash', targetSystem: 'general', summary: 'x', payload: { command: 'rm -rf x' }, risk: 'high-risk' }, { profileId: 'general', sessionId: 's1', actor: 'agent' });
    const expired = await gate.expire(p.id);
    expect(expired?.status).toBe('expired');
  });

  it('keeps legacy constructor working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const audit = new AuditStore(join(dir, 'audit.db'));
    const gate = new ApprovalGate({
      audit,
      policy: { requireApproval: [], timeoutMs: 60_000, highRiskDoubleConfirm: true },
      rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
    });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'default', sessionId: 's1', actor: 'agent' });
    const ok = await gate.decide(p.id, admin, true);
    expect(ok.status).toBe('approved');
  });
});
