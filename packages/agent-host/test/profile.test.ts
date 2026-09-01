import { describe, it, expect } from 'vitest';
import { loadProfile } from '@sparkii/config';
import { resolve } from 'node:path';

describe('contract-review profile', () => {
  it('loads without signature in dev mode', async () => {
    const p = await loadProfile(resolve(__dirname, '../../../apps/desktop/agents/contract-review'), { allowUnsigned: true });
    expect(p.agent.tools).toContain('report.export');
    expect(p.security.approval.requireApproval).toContain('report.export');
  });
});
