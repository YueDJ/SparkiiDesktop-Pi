import { describe, expect, it } from 'vitest';
import type { WorkspacePathProbe } from '@sparkii/approval';
import {
  TaskGrantAdmissionError,
  createTaskGrant,
} from '../electron/main/security/task-grant-factory.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const probe: WorkspacePathProbe = {
  inspect: async (target) => ({
    displayPath: target,
    canonicalPath: target,
    identity: `object:${key(target)}`,
    nearestExistingAncestor: target,
    isDirectory: true,
    isReparsePoint: false,
    exists: true,
  }),
  isSameOrDescendant: async (root, target) => {
    const r = key(root);
    const t = key(target);
    return t === r || t.startsWith(`${r}/`);
  },
  isSameObject: async (left, right) => key(left) === key(right),
};

const base = {
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  mode: 'standard' as const,
  workspacePath: 'C:/Users/me/Desktop/project',
  scratchParent: 'C:/Users/me/AppData/Local/Sparkii/tasks',
  inputRoots: [],
  protectedRoots: [
    { path: 'C:/Users/me', policy: 'boundary' as const },
    { path: 'C:/Users/me/AppData', policy: 'closure' as const },
  ],
  probe,
  now: () => 1_000,
  ttlMs: 60_000,
};

describe('createTaskGrant', () => {
  it('admits the workspace and creates a separate private scratch root', async () => {
    const grant = await createTaskGrant(base);
    expect(grant).toMatchObject({
      sessionId: 's1',
      agentId: 'general',
      profileId: 'general',
      mode: 'standard',
      workspaceRoot: 'C:/Users/me/Desktop/project',
      workspaceIdentity: 'object:c:/users/me/desktop/project',
      createdAt: 1_000,
      expiresAt: 61_000,
      networkDomains: [],
      externalCapabilities: [],
    });
    expect(grant.taskId).toMatch(/^task-/);
    expect(grant.scratchRoot).toContain(grant.taskId);
    expect(key(grant.scratchRoot).startsWith(
      key('C:/Users/me/AppData/Local/Sparkii/tasks'),
    )).toBe(true);
    expect(key(grant.scratchRoot).startsWith(key(grant.workspaceRoot))).toBe(false);
  });

  it('generates a unique task id for every grant', async () => {
    const a = await createTaskGrant(base);
    const b = await createTaskGrant(base);
    expect(a.taskId).not.toBe(b.taskId);
  });

  it('does not create a grant when Workspace Admission fails', async () => {
    await expect(createTaskGrant({
      ...base,
      workspacePath: 'C:/Users/me/AppData/Local/Sparkii/project',
    })).rejects.toBeInstanceOf(TaskGrantAdmissionError);
  });

  it('snapshots bound input object identities as read-only resources', async () => {
    const grant = await createTaskGrant({
      ...base,
      inputRoots: ['C:/Users/me/Documents/contract.pdf'],
    });
    expect(grant.inputRoots).toEqual([{
      path: 'C:/Users/me/Documents/contract.pdf',
      identity: 'object:c:/users/me/documents/contract.pdf',
    }]);
  });

  it('rejects scratch inside the workspace while allowing platform-owned task data', async () => {
    await expect(createTaskGrant({
      ...base,
      scratchParent: 'C:/Users/me/Desktop/project/.scratch',
    })).rejects.toBeInstanceOf(TaskGrantAdmissionError);
    await expect(createTaskGrant({
      ...base,
      scratchParent: 'C:/Users/me/AppData/Local/Sparkii/tasks',
    })).resolves.toBeTruthy();
  });
});
