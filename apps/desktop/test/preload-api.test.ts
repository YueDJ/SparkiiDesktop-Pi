import { describe, it, expect } from 'vitest';
import { buildApi } from '../electron/preload/api.js';

describe('sparkii api shape', () => {
  it('exposes the expected method names', () => {
    const names = ['login', 'getProfile', 'chooseDocument', 'runWorkflow', 'exportReport', 'prompt', 'listPendingApprovals', 'decideApproval', 'queryAudit', 'on'];
    const api = buildApi({ invoke: () => Promise.resolve(null), on: () => () => {}, removeListener: () => {} } as any);
    for (const n of names) expect(typeof (api as any)[n]).toBe('function');
  });
});
