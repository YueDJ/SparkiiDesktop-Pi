import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { hashPayload, type Proposal } from '../src/proposal.js';
import { ConnectorExecutor } from '../src/executor.js';
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
    const p = await gate.submit({ requestId: 'r1', toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const out = await gate.decide(p.id, { userId: 'u1', roles: ['admin'] }, true, 'ok');
    expect(out.status).toBe('approved');
    expect((await audit.query({})).map((e) => e.action)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.approved']));
  });
  it('denies unauthorized approver', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac: new Rbac([{ name: 'viewer', pages: [], tools: [], canApprove: [] }]), audit });
    const p = await gate.submit({ requestId: 'r1', toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await expect(gate.decide(p.id, { userId: 'u2', roles: ['viewer'] }, true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses to decide or execute a privacy-redacted proposal', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const executor = new ConnectorExecutor(audit);
    let executions = 0;
    executor.register('report.export', async () => { executions += 1; return { ok: true }; });
    const pending = await gate.submit({
      requestId: 'redact-pending', toolName: 'report.export', targetSystem: 'report',
      summary: 'private summary', payload: { text: 'private body' }, risk: 'write', executionMode: 'caller',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const approved = await gate.submit({
      requestId: 'redact-approved', toolName: 'report.export', targetSystem: 'report',
      summary: 'private summary', payload: { text: 'private body' }, risk: 'write', executionMode: 'caller',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await gate.decide(approved.id, { userId: 'u1', roles: ['admin'] }, true);
    expect(gate.redactTexts(['private body'])).toBe(2);
    await expect(gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });
    const blocked = await executor.execute(gate.get(approved.id)!, { actor: 'u1' });
    expect(blocked.status).toBe('approved');
    expect(blocked.privacyRedacted).toBe(true);
    expect(executions).toBe(0);
  });

  it('R8 review privacy B4 fails the gate closed when audit registry persistence fails', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gate-registry-failure-')), 'a.db');
    const audit = new AuditStore(path);
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_REGISTRY_SECRET_71C';
    const pending = await gate.submit({
      requestId: 'registry-failure', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { text: secret }, risk: 'write', executionMode: 'caller',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    mkdirSync(`${path}.privacy-redactions.json`);

    expect(() => gate.redactTexts([secret])).toThrow();
    expect(() => gate.listPending()).toThrow(/approval privacy cleanup incomplete/);
    expect(() => gate.get(pending.id)).toThrow(/approval privacy cleanup incomplete/);
    await expect(gate.submit({
      requestId: 'after-failure', toolName: 'report.export', targetSystem: 'report',
      summary: 'safe', payload: {}, risk: 'write',
    }, { profileId: 'p', sessionId: 's2', actor: 'agent' })).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    await expect(gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
  });

  it('R8 round6 B1 replays a failed invalidation listener before clearing the privacy block', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-round6-listener-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_ROUND6_LISTENER_SECRET_71C';
    const pending = await gate.submit({
      requestId: 'listener-retry', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const notifications: Proposal[] = [];
    let attempts = 0;
    const listener = vi.fn((proposal: Proposal) => {
      notifications.push(proposal);
      attempts += 1;
      if (attempts === 1) throw new Error('injected listener failure');
    });
    const unsubscribe = gate.onProposalInvalidated(listener);
    const auditRedactions = vi.spyOn(audit, 'redactTexts');

    expect(() => gate.redactTexts([secret])).toThrow(/approval invalidation listeners failed/);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auditRedactions).toHaveBeenCalledTimes(1);
    const invalidated = notifications[0];
    expect(invalidated).not.toBe(pending);
    expect(invalidated).toMatchObject({ id: pending.id, status: 'pending', privacyRedacted: true });
    expect(invalidated.payloadHash).toBe(hashPayload(invalidated.payload));
    expect(JSON.stringify(invalidated)).not.toContain(secret);
    expect(() => gate.get(pending.id)).toThrow(/approval privacy cleanup incomplete/);
    expect(() => gate.redactTexts([])).toThrow(/approval privacy cleanup incomplete/);
    expect(() => gate.updateApprovedPayload(pending, { body: 'safe' })).toThrow(/approval privacy cleanup incomplete/);

    expect(gate.redactTexts([secret])).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(auditRedactions).toHaveBeenCalledTimes(2);
    expect(listener.mock.invocationCallOrder[1]).toBeLessThan(auditRedactions.mock.invocationCallOrder[1]);
    expect(notifications[1]).toBe(invalidated);
    expect(gate.get(pending.id)).toBe(invalidated);
    expect(gate.get(pending.id)).toMatchObject({ status: 'pending', privacyRedacted: true });
    await expect(gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect((await audit.query({ action: 'proposal.created' }))).toHaveLength(1);
    unsubscribe();
  });

  it('R8 round6 B1 stays blocked on persistent listener failure without blocking audit registration', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-round6-listener-persistent-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_ROUND6_PERSISTENT_SECRET_71C';
    const laterSecret = 'R8_GATE_ROUND6_LATER_SECRET_92D';
    const pending = await gate.submit({
      requestId: 'listener-persistent', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const listener = vi.fn(() => { throw new Error('persistent listener failure'); });
    gate.onProposalInvalidated(listener);
    const auditRedactions = vi.spyOn(audit, 'redactTexts');

    expect(() => gate.redactTexts([secret])).toThrow(/approval invalidation listeners failed/);
    expect(() => gate.redactTexts([secret, laterSecret])).toThrow(/approval invalidation listeners failed/);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(auditRedactions).toHaveBeenCalledTimes(2);
    expect(audit.contains(laterSecret)).toBe(true);
    expect(() => gate.get(pending.id)).toThrow(/approval privacy cleanup incomplete/);
    expect(() => gate.redactTexts([])).toThrow(/approval privacy cleanup incomplete/);
    expect(listener.mock.calls[1][0]).toMatchObject({ id: pending.id, status: 'pending', privacyRedacted: true });
  });

  it('R8 round6 B1 retries only unfinished listeners and includes listeners added while queued', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-round6-listener-set-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_ROUND6_LISTENER_SET_SECRET_71C';
    const pending = await gate.submit({
      requestId: 'listener-set', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const successful = vi.fn();
    let failures = 1;
    const retried = vi.fn(() => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('first listener failure');
      }
    });
    gate.onProposalInvalidated(successful);
    gate.onProposalInvalidated(retried);

    expect(() => gate.redactTexts([secret])).toThrow(/approval invalidation listeners failed/);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(retried).toHaveBeenCalledTimes(1);
    const added = vi.fn();
    gate.onProposalInvalidated(added);

    expect(gate.redactTexts([secret])).toBe(0);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(retried).toHaveBeenCalledTimes(2);
    expect(added).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledWith(gate.get(pending.id));
    expect(gate.get(pending.id)).toMatchObject({ status: 'pending', privacyRedacted: true });
  });

  it('R8 round6 B1 models MemoryService retaining its journal until listener replay succeeds', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-round6-listener-journal-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_ROUND6_JOURNAL_SECRET_71C';
    const pending = await gate.submit({
      requestId: 'listener-journal', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const journal = new Map<string, string[]>();
    let completed = false;
    let attempts = 0;
    gate.onProposalInvalidated(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('injected listener failure');
    });
    const privacyDelete = (): void => {
      journal.set('s', [secret]);
      try {
        gate.redactTexts([secret]);
      } catch {
        throw new Error('隐私清理失败，请重试');
      }
      journal.delete('s');
      completed = true;
    };

    expect(() => privacyDelete()).toThrow('隐私清理失败，请重试');
    expect(journal.get('s')).toEqual([secret]);
    expect(completed).toBe(false);
    expect(() => gate.get(pending.id)).toThrow(/approval privacy cleanup incomplete/);
    privacyDelete();
    expect(journal.size).toBe(0);
    expect(completed).toBe(true);
    expect(attempts).toBe(2);
    expect(gate.get(pending.id)).toMatchObject({ status: 'pending', privacyRedacted: true });
  });

  it('atomically updates only the current approved payload and rejects stale or redacted objects', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const proposal = await gate.submit({
      requestId: 'export-path-cas',
      toolName: 'report.export',
      targetSystem: 'report',
      summary: 'export secret',
      payload: { body: 'secret', path: 'C:/ws/suggested.txt' },
      risk: 'write',
      executionMode: 'proposal',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const approved = await gate.decide(proposal.id, { userId: 'u1', roles: ['admin'] }, true);
    const chosen = { body: 'secret', path: 'C:/ws/chosen.txt' };

    const updated = gate.updateApprovedPayload(approved, chosen);
    expect(updated).toMatchObject({
      id: approved.id,
      status: 'approved',
      payload: chosen,
      payloadHash: hashPayload(chosen),
    });
    expect(updated?.privacyRedacted).not.toBe(true);
    expect(updated).not.toBe(approved);
    expect(gate.get(proposal.id)).toBe(updated);
    expect(approved.payload).toEqual({ body: 'secret', path: 'C:/ws/suggested.txt' });
    expect(gate.updateApprovedPayload(approved, chosen)).toBeUndefined();

    expect(gate.redactTexts(['secret'])).toBe(1);
    expect(gate.get(proposal.id)).toMatchObject({
      privacyRedacted: true,
      payload: { body: '[已删除]', path: 'C:/ws/chosen.txt' },
    });
    expect(gate.updateApprovedPayload(updated!, chosen)).toBeUndefined();
  });

  it.each([false, true])('persistently fences submit, note and approved payload ingress (restart=%s)', async (restart) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-future-privacy-'));
    const path = join(dir, 'a.db');
    const secret = 'R8_GATE_FUTURE_SECRET_71C';
    const escaped = 'R8_GATE_"\\\n_SECRET_92D';
    let audit = new AuditStore(path);
    stores.push(audit);
    audit.redactTexts([secret, escaped]);
    if (restart) {
      audit.close();
      stores.splice(stores.indexOf(audit), 1);
      audit = new AuditStore(path);
      stores.push(audit);
    }
    const gate = new ApprovalGate({ policy, rbac, audit });
    const pending = await gate.submit({
      requestId: `request-${secret}`,
      toolName: 'report.export',
      targetSystem: `target-${escaped}`,
      summary: `summary-${secret}`,
      preview: { kind: 'text', lines: [`preview-${escaped}`] },
      payload: { nested: [{ [`key-${secret}`]: `value-${escaped}` }] },
      risk: 'write',
    }, { profileId: 'p', sessionId: `session-${secret}`, actor: `actor-${escaped}` });
    expect(pending.privacyRedacted).toBe(true);
    expect(pending.payloadHash).toBe(hashPayload(pending.payload));
    expect(JSON.stringify(pending)).not.toContain(secret);
    expect(JSON.stringify(pending)).not.toContain(JSON.stringify(escaped).slice(1, -1));
    await expect(gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });

    const noted = await gate.submit({
      requestId: 'note', toolName: 'report.export', targetSystem: 'report', summary: 'safe', payload: {}, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const decided = await gate.decide(noted.id, { userId: 'u1', roles: ['admin'] }, true, `note-${secret}-${escaped}`);
    expect(decided.privacyRedacted).toBe(true);
    expect(decided.decisionNote).not.toContain(secret);
    expect(decided.decisionNote).not.toContain(JSON.stringify(escaped).slice(1, -1));

    const approved = await gate.submit({
      requestId: 'payload', toolName: 'report.export', targetSystem: 'report', summary: 'safe', payload: {}, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const decision = await gate.decide(approved.id, { userId: 'u1', roles: ['admin'] }, true, 'ok');
    const updated = gate.updateApprovedPayload(decision, { nested: [{ [`key-${secret}`]: `value-${escaped}` }] });
    expect(updated?.privacyRedacted).toBe(true);
    expect(updated?.payloadHash).toBe(hashPayload(updated?.payload));
    expect(JSON.stringify(updated)).not.toContain(secret);
    expect(JSON.stringify(updated)).not.toContain(JSON.stringify(escaped).slice(1, -1));
    expect(gate.updateApprovedPayload(decision, {})).toBeUndefined();

    const output = JSON.stringify(await audit.query({})) + await audit.exportJsonl();
    expect(output).not.toContain(secret);
    expect(output).not.toContain(JSON.stringify(escaped).slice(1, -1));
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(JSON.stringify(escaped).slice(1, -1));
  });

  it.each(['已删除', '[已删除]', 'marker'])('invalidates proposals by registered pattern hits for %s', async (kind) => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-marker-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    let secret = kind;
    if (kind === 'marker') {
      audit.redactTexts(['已删除']);
      secret = audit.marker();
    }
    const pending = await gate.submit({
      requestId: 'marker-boundary', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { text: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    expect(gate.redactTexts([secret])).toBe(1);
    const redacted = gate.get(pending.id)!;
    expect(redacted.privacyRedacted).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(audit.containsValue(redacted)).toBe(false);
    await expect(gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it.each([false, true])('R8 round3 fences physical-newline fragments in existing and future proposals (restart=%s)', async (restart) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-r8-round3-lines-'));
    const path = join(dir, 'a.db');
    const alpha = 'R8_GATE_FRAGMENT_ALPHA_71C';
    const beta = 'R8_GATE_FRAGMENT_"\\BETA_92D';
    const gamma = 'R8_GATE_FRAGMENT_GAMMA_33E';
    const secret = `${alpha}\r\n${beta}\r${gamma}\n`;
    const fragments = [alpha, beta, gamma];
    const forbidden = [secret, JSON.stringify(secret).slice(1, -1), ...fragments.flatMap((fragment) => [
      fragment, JSON.stringify(fragment).slice(1, -1),
    ])];
    let audit = new AuditStore(path);
    stores.push(audit);
    if (restart) {
      audit.redactTexts([secret]);
      audit.close();
      stores.splice(stores.indexOf(audit), 1);
      audit = new AuditStore(path);
      stores.push(audit);
    }
    const gate = new ApprovalGate({ policy, rbac, audit });
    const existing = await gate.submit({
      requestId: 'existing-lines', toolName: 'report.export', targetSystem: 'report',
      summary: fragments.join(' '), payload: { nested: [{ text: fragments.join('|') }] }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    if (restart) {
      expect(existing.privacyRedacted).toBe(true);
    } else {
      expect(gate.redactTexts([secret])).toBe(1);
    }
    const canonical = gate.get(existing.id)!;
    expect(canonical.privacyRedacted).toBe(true);
    expect(canonical.payloadHash).toBe(hashPayload(canonical.payload));
    for (const value of forbidden) expect(JSON.stringify(canonical)).not.toContain(value);
    await expect(gate.decide(canonical.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });

    const future = await gate.submit({
      requestId: 'future-lines', toolName: 'report.export', targetSystem: 'report',
      summary: JSON.stringify(beta).slice(1, -1), payload: { text: `${gamma} ${alpha}` }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    expect(future.privacyRedacted).toBe(true);
    for (const value of forbidden) expect(JSON.stringify(future)).not.toContain(value);
    await expect(gate.decide(future.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });

    const output = JSON.stringify(await audit.query({})) + await audit.exportJsonl();
    const bytes = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
      .filter(existsSync).map((file) => readFileSync(file).toString('utf8')).join('\n');
    for (const value of forbidden) {
      expect(output).not.toContain(value);
      expect(bytes).not.toContain(value);
    }
  });

  it('R8 round3 submit returns the canonical proposal after invalidation during a pending audit append', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-round3-race-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_AUDIT_RACE_SECRET_71C';
    const originalAppend = audit.append.bind(audit);
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendBlocked = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    const appendSpy = vi.spyOn(audit, 'append').mockImplementation(async (event) => {
      markAppendStarted();
      await appendBlocked;
      return originalAppend(event);
    });
    const submission = gate.submit({
      requestId: 'audit-race', toolName: 'report.export', targetSystem: 'report',
      summary: `summary ${secret}`, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await appendStarted;
    const stale = gate.listPending()[0];
    expect(stale.payload).toEqual({ body: secret });
    const changed = gate.redactTexts([secret]);
    const canonical = gate.get(stale.id)!;
    releaseAppend();
    const returned = await submission;
    appendSpy.mockRestore();

    expect(changed).toBe(1);
    expect(canonical.privacyRedacted).toBe(true);
    expect(JSON.stringify(canonical)).not.toContain(secret);
    expect(returned).toBe(canonical);
    expect(returned).not.toBe(stale);
    expect(JSON.stringify(returned)).not.toContain(secret);
    await expect(gate.decide(returned.id, { userId: 'u1', roles: ['admin'] }, true))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it.each(['expire', 'cancelSession'] as const)('R8 final review %s returns the canonical proposal after privacy invalidation during audit', async (operation) => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-final-race-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy: { ...policy, timeoutMs: 0 }, rbac, audit });
    const secret = 'R8_GATE_FINAL_RACE_SECRET_71C';
    const pending = await gate.submit({
      requestId: operation, toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const originalAppend = audit.append.bind(audit);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const spy = vi.spyOn(audit, 'append').mockImplementation(async (event) => {
      if (event.action !== 'proposal.created') {
        started();
        await blocked;
      }
      return originalAppend(event);
    });
    const result = operation === 'expire' ? gate.expire(pending.id) : gate.cancelSession('s', 'revoked');
    await entered;
    gate.redactTexts([secret]);
    release();
    const returned = operation === 'expire' ? await result : (await result)[0];
    spy.mockRestore();

    expect(returned).toBe(gate.get(pending.id));
    expect(returned.privacyRedacted).toBe(true);
    expect(JSON.stringify(returned)).not.toContain(secret);
  });

  it('R8 final review fences pending reads when audit cleanup fails after registry persistence', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'gate-r8-final-compact-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const secret = 'R8_GATE_FINAL_COMPACT_SECRET_71C';
    const pending = await gate.submit({
      requestId: 'compact', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const approved = await gate.decide(pending.id, { userId: 'u1', roles: ['admin'] }, true);
    const otherPending = await gate.submit({
      requestId: 'compact-pending', toolName: 'report.export', targetSystem: 'report',
      summary: secret, payload: { body: secret }, risk: 'write',
    }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const original = audit.redactTexts.bind(audit);
    vi.spyOn(audit, 'redactTexts').mockImplementation((texts) => {
      original(texts);
      throw new Error('injected compact failure');
    });

    expect(() => gate.redactTexts([secret])).toThrow('injected compact failure');
    expect(() => gate.listPending()).toThrow(/privacy cleanup incomplete/);
    expect(() => gate.get(otherPending.id)).toThrow(/privacy cleanup incomplete/);
    expect(() => gate.redactTexts([])).toThrow(/privacy cleanup incomplete/);
    expect(() => gate.redactTexts(['   '])).toThrow('injected compact failure');
    expect(() => gate.updateApprovedPayload(approved, { body: secret })).toThrow(/privacy cleanup incomplete/);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
  });

  it('cancels only the pending proposals for one session', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const first = await gate.submit(
      { requestId: 'r1', toolName: 'report.export', targetSystem: 'report', summary: 'one', payload: {}, risk: 'write' },
      { profileId: 'p', sessionId: 's1', actor: 'agent' },
    );
    const second = await gate.submit(
      { requestId: 'r2', toolName: 'report.export', targetSystem: 'report', summary: 'two', payload: {}, risk: 'write' },
      { profileId: 'p', sessionId: 's2', actor: 'agent' },
    );

    const cancelled = await gate.cancelSession('s1', 'task-revoked');
    expect(cancelled).toEqual([
      expect.objectContaining({ id: first.id, sessionId: 's1', status: 'denied' }),
    ]);
    expect(gate.get(second.id)?.status).toBe('pending');
    expect((await audit.query({ sessionId: 's1' })).map((e) => e.action))
      .toContain('proposal.cancelled');
  });
});
