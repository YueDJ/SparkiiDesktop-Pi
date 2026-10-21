import { describe, expect, it } from 'vitest';
import type {
  TaskGrant,
  WorkspacePathProbe,
} from '@sparkii/approval';
import {
  ActionNormalizationError,
  DEFAULT_TOOL_DESCRIPTORS,
  createActionNormalizer,
} from '../electron/main/security/action-normalizer.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function probe(): WorkspacePathProbe {
  return {
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
}

const grant: TaskGrant = {
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  mode: 'standard',
  workspaceRoot: 'C:/ws',
  workspaceIdentity: 'object:c:/ws',
  inputRoots: [{ path: 'C:/input', identity: 'object:c:/input' }],
  scratchRoot: 'C:/scratch/t1',
  networkDomains: [],
  externalCapabilities: [],
  createdAt: 1,
  expiresAt: 10_000,
};

function normalizer() {
  return createActionNormalizer({
    descriptors: DEFAULT_TOOL_DESCRIPTORS,
    protectedRoots: [
      { path: 'C:/Users/me', policy: 'boundary' },
      { path: 'C:/Windows', policy: 'closure' },
      { path: 'C:/Users/me/AppData', policy: 'closure' },
    ],
    probe: probe(),
    now: () => 1_000,
  });
}

const write = (args: Record<string, unknown>, toolName = 'write') => ({
  requestId: 'r1',
  toolCallId: 'call-1',
  toolName,
  args,
});

describe('ActionNormalizer', () => {
  it('recomputes an ordinary workspace write from the trusted tool definition', async () => {
    const action = await normalizer().normalize(
      write({
        path: 'C:/ws/src/a.ts',
        content: 'x',
        risk: 'read',
        summary: 'harmless',
        capability: 'fs.read',
      }),
      grant,
    );
    expect(action).toMatchObject({
      taskId: 't1',
      sessionId: 's1',
      agentId: 'general',
      profileId: 'general',
      toolName: 'write',
      capability: 'fs.write',
      risk: 'write',
      payloadHash: expect.any(String),
      resources: [{
        kind: 'path',
        value: 'C:/ws/src/a.ts',
        identity: 'object:c:/ws/src/a.ts',
        scope: 'workspace',
      }],
    });
    expect(action.reason).not.toBe('harmless');
  });

  it('marks out-of-workspace and scratch scopes without trusting Runtime scope', async () => {
    const target = await normalizer().normalize(
      write({
        path: 'C:/outside/a.txt',
        content: 'x',
        scope: 'workspace',
      }),
      grant,
    );
    expect(target.resources[0].scope).toBe('external');

    const scratch = await normalizer().normalize(
      write({ path: 'C:/scratch/t1/a.txt', content: 'x' }),
      grant,
    );
    expect(scratch.resources[0].scope).toBe('scratch');
  });

  it('marks workspace root and protected descendants as critical', async () => {
    await expect(normalizer().normalize(
      write({ path: 'C:/ws', content: 'replace-root' }, 'delete'),
      grant,
    )).resolves.toMatchObject({
      resources: [{ scope: 'critical' }],
    });
    await expect(normalizer().normalize(
      write({ path: 'C:/Windows/System32/drivers/etc/hosts', content: 'x' }),
      grant,
    )).resolves.toMatchObject({
      resources: [{ scope: 'critical' }],
    });
  });

  it('marks credential, environment and executable-control files as trust anchors', async () => {
    for (const path of [
      'C:/ws/.env',
      'C:/ws/.git/hooks/pre-commit',
      'C:/ws/.mcp.json',
      'C:/ws/.codex/config.toml',
    ]) {
      const action = await normalizer().normalize(
        write({ path, content: 'x' }),
        grant,
      );
      expect(action.resources[0].trustAnchor).toBe(true);
    }
  });

  it('uses the trusted tool casing while rejecting unknown tools', async () => {
    const action = await normalizer().normalize(
      write({ path: 'C:/ws/a.txt', content: 'x' }, 'WRITE'),
      grant,
    );
    expect(action.toolName).toBe('write');
    await expect(normalizer().normalize(
      write({ path: 'C:/ws/a.txt', content: 'x' }, 'shell-magic'),
      grant,
    )).rejects.toBeInstanceOf(ActionNormalizationError);
  });

  it('normalizes move source and destination independently', async () => {
    const action = await normalizer().normalize({
      requestId: 'r2',
      toolName: 'move',
      args: { from: 'C:/ws/a.txt', to: 'C:/Users/me/AppData/a.txt' },
    }, grant);
    expect(action.resources).toEqual([
      expect.objectContaining({ value: 'C:/ws/a.txt', scope: 'workspace' }),
      expect.objectContaining({ value: 'C:/Users/me/AppData/a.txt', scope: 'critical' }),
    ]);
  });

  it('normalizes process execution as a workspace process without parsing shell text', async () => {
    const action = await normalizer().normalize({
      requestId: 'r3',
      toolName: 'bash',
      args: { command: 'rm -rf C:/Windows', risk: 'read' },
    }, grant);
    expect(action).toMatchObject({
      capability: 'process.exec',
      risk: 'high-risk',
      resources: [{
        kind: 'process',
        value: 'bash',
        scope: 'workspace',
      }],
    });
  });
});
