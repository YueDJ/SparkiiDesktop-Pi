import { describe, expect, it } from 'vitest';
import {
  type TaskGrant,
  type WorkspacePathProbe,
} from '@sparkii/approval';
import {
  createActionNormalizer,
  DEFAULT_TOOL_DESCRIPTORS,
} from '../electron/main/security/action-normalizer.js';
import { authorizeDocumentReadPaths } from '../electron/main/security/document-access.js';

const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const probe: WorkspacePathProbe = {
  inspect: async (target) => ({
    displayPath: target,
    canonicalPath: target,
    identity: `object:${key(target)}`,
    nearestExistingAncestor: target,
    isDirectory: false,
    isReparsePoint: false,
    exists: true,
  }),
  isSameOrDescendant: async (root, target) => {
    const left = key(root);
    const right = key(target);
    return right === left || right.startsWith(`${left}/`);
  },
  isSameObject: async (left, right) => key(left) === key(right),
};

const grant: TaskGrant = {
  taskId: 't1',
  sessionId: 's1',
  agentId: 'contract-review',
  profileId: 'contract-review',
  actorId: 'u1',
  unattended: false,
  planMode: 'execute',
  permissionMode: 'ask',
  workspaceRoot: 'C:/ws',
  workspaceIdentity: 'object:c:/ws',
  inputRoots: [{ path: 'C:/inputs', identity: 'object:c:/inputs' }],
  scratchRoot: 'C:/scratch/t1',
  networkDomains: [],
  externalCapabilities: [],
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
};

const normalizer = createActionNormalizer({
  descriptors: DEFAULT_TOOL_DESCRIPTORS,
  protectedRoots: [{ path: 'C:/Windows', policy: 'closure' }],
  probe,
});

describe('authorizeDocumentReadPaths', () => {
  it('allows workspace files and bound inputs', async () => {
    await expect(authorizeDocumentReadPaths(
      ['C:/ws/contract.docx', 'C:/inputs/source.pdf'],
      grant,
      normalizer,
    )).resolves.toMatchObject({ ok: true });
  });

  it('denies outside, protected, and trust-anchor documents', async () => {
    for (const target of [
      'C:/Users/me/secret.docx',
      'C:/Windows/win.ini',
      'C:/ws/.env',
    ]) {
      await expect(authorizeDocumentReadPaths([target], grant, normalizer))
        .resolves.toMatchObject({ ok: false });
    }
  });
});
