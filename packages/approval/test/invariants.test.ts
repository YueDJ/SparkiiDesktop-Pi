import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { ConnectorExecutor } from '../src/executor.js';
import { AuditStore } from '../src/audit.js';
import { Rbac } from '@sparkii/identity';

const dbs: AuditStore[] = [];
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

const gate = (audit: AuditStore) => new ApprovalGate({
  policy: { requireApproval: ['report.export'], timeoutMs: 10000, highRiskDoubleConfirm: true },
  rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
  audit,
});

describe('security invariants', () => {
  it('denied write never reaches the connector executor', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(audit); ex.register('report.export', handler);
    const p = await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await g.decide(p.id, { userId: 'u1', roles: ['admin'] }, false, 'no');
    const out = await ex.execute(g.get(p.id)!, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('denied');
  });

  it('every write attempt produces exactly one proposal.created audit record', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    expect((await audit.query({ action: 'proposal.created' }))).toHaveLength(1);
  });

  it('a hallucinated "approved" text cannot execute a write (executor reads authoritative state)', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(audit); ex.register('report.export', handler);
    const p = await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    // 模拟 LLM 谎报「已批准」，但权威状态仍是 pending
    const out = await ex.execute(g.get(p.id)!, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('pending');
  });
});
