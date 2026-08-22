import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PiProcessSupervisor } from '../src/process.js';
import { ControlServer } from '../src/control-server.js';
import { ApprovalGate } from '@sparkii/approval';
import { ConnectorExecutor } from '@sparkii/approval';
import { AuditStore } from '@sparkii/approval';
import { Rbac } from '@sparkii/identity';

const skip = !process.env.PI_BIN && process.env.RUN_PI_INTEGRATION !== '1';

describe.skipIf(skip)('Pi integration', () => {
  let sup: PiProcessSupervisor, gate: ApprovalGate, ex: ConnectorExecutor, audit: AuditStore;
  beforeAll(async () => {
    sup = new PiProcessSupervisor();
    audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'pi-it-')), 'a.db'));
    gate = new ApprovalGate({ policy: { requireApproval: ['report.export'], timeoutMs: 60000, highRiskDoubleConfirm: true }, rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write'] }]), audit });
    ex = new ConnectorExecutor(audit); ex.register('report.export', async () => ({ ok: true, data: { bytes: 'e30=' } }));
    const control = new ControlServer({ onProposal: async (req) => {
      const p = await gate.submit(req, { profileId: 'p', sessionId: 's', actor: 'agent' });
      return { approved: false, proposalId: p.id, status: p.status };
    }});
    const { url, token } = await control.start();
    process.env.SPARKII_CONTROL_URL = url; process.env.SPARKII_CONTROL_TOKEN = token;
  });
  afterAll(async () => { await sup.stop(); audit.close(); });

  it('starts RPC mode and answers get_state', async () => {
    const c = await sup.start();
    const r = await c.send({ type: 'get_state' });
    expect(r.success).toBe(true);
  });
});
