import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { AuditStore } from '../src/audit.js';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('AuditStore', () => {
  it('appends and queries an audit event', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    const ev = await s.append({ actor: 'u1', action: 'proposal.created', resource: 'report.export', payloadSummary: 'x' });
    expect(ev.id).toBeTruthy();
    expect(await s.query({ actor: 'u1' })).toHaveLength(1);
  });
  it('exports jsonl', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    await s.append({ actor: 'u1', action: 'proposal.denied', decision: 'denied' });
    const line = (await s.exportJsonl()).trim().split('\n')[0];
    expect(JSON.parse(line).action).toBe('proposal.denied');
  });
  it("persists and queries sessionId", async () => {
    const store = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
    stores.push(store);
    await store.append({ actor: "admin", action: "proposal.created", resource: "report.export", sessionId: "s-1" });
    const rows = await store.query({ sessionId: "s-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s-1");
  });
  it("exports jsonl with camelCase fields", async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
    stores.push(s);
    await s.append({ actor: "u1", action: "proposal.created", resource: "report.export", payloadSummary: "x", sessionId: "s-1" });
    const line = (await s.exportJsonl()).trim().split("\n")[0];
    const parsed = JSON.parse(line);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.session_id).toBeUndefined();
    expect(parsed.payloadSummary).toBe("x");
    expect(parsed.payload_summary).toBeUndefined();
  });
});
