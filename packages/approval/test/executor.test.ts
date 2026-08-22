import { describe, it, expect, vi } from 'vitest';
import { ConnectorExecutor } from '../src/executor.js';
import { AuditStore } from '../src/audit.js';
import { createProposal, transition } from '../src/proposal.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ConnectorExecutor', () => {
  it('never calls the write handler for a denied proposal', async () => {
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(new AuditStore(join(mkdtempSync(join(tmpdir(), 'ex-')), 'a.db')));
    ex.register('report.export', handler);
    const p = transition(createProposal({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'denied');
    const out = await ex.execute(p, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('denied');
  });

  it('executes an approved proposal with the frozen payload', async () => {
    const handler = vi.fn(async (args) => ({ ok: true, data: { got: args } }));
    const ex = new ConnectorExecutor(new AuditStore(join(mkdtempSync(join(tmpdir(), 'ex-')), 'a.db')));
    ex.register('report.export', handler);
    const p = transition(createProposal({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: { title: 'r' }, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'approved');
    const out = await ex.execute(p, { actor: 'system' });
    expect(handler).toHaveBeenCalledWith({ title: 'r' }, expect.objectContaining({ actor: 'system' }));
    expect(out.status).toBe('executed');
  });
});
