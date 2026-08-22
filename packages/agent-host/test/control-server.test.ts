import { describe, it, expect } from 'vitest';
import { ControlServer } from '../src/control-server.js';

describe('ControlServer', () => {
  it('proxies a proposal and enforces bearer token', async () => {
    const s = new ControlServer({ onProposal: async (req) => ({ approved: false, proposalId: 'p1', status: 'denied' }) });
    const { url, token } = await s.start();
    const r = await fetch(`${url}/propose`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r1', toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('denied');
    const bad = await fetch(`${url}/propose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    await s.stop();
  });
});
