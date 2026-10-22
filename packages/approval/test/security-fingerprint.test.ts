import { describe, expect, it } from 'vitest';
import { actionFingerprint, type SecurityAction } from '../src/security/index.js';

const action = (patch: Partial<SecurityAction> = {}): SecurityAction => ({
  id: 'a1',
  subjectId: 'u1',
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'write',
  capability: 'fs.write',
  approvalClass: 'auto',
  resources: [{ kind: 'path', value: 'C:/ws/a.txt', identity: 'file:1', scope: 'workspace' }],
  payload: { content: 'x' },
  payloadHash: 'h',
  risk: 'write',
  reason: '工作区内文件修改',
  ...patch,
});

describe('actionFingerprint', () => {
  it('is stable for object key order changes', () => {
    expect(actionFingerprint(action())).toBe(actionFingerprint(action()));
  });

  it('changes when target identity changes', () => {
    expect(actionFingerprint(action())).not.toBe(actionFingerprint(action({
      resources: [{ kind: 'path', value: 'C:/ws/a.txt', identity: 'file:2', scope: 'workspace' }],
    })));
  });

  it('ignores non-authoritative fields such as id, payload and reason', () => {
    const base = actionFingerprint(action());
    expect(actionFingerprint(action({ id: 'a2', payload: { content: 'changed' }, reason: '别的理由' }))).toBe(base);
  });
});
