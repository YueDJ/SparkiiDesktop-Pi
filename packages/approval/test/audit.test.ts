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
});
