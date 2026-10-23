import { describe, expect, it, vi } from 'vitest';
import {
  admitWorkspace,
  type ProtectedRoot,
  type WorkspacePathProbe,
} from '../src/security/index.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function fakeProbe(
  aliases: Record<string, string> = {},
  overrides: Partial<Awaited<ReturnType<WorkspacePathProbe['inspect']>>> = {},
): WorkspacePathProbe {
  const aliasMap = new Map(
    Object.entries(aliases).map(([alias, target]) => [key(alias), target]),
  );
  const canonical = (value: string) => aliasMap.get(key(value)) ?? value;
  return {
    inspect: async (target) => ({
      displayPath: target,
      canonicalPath: canonical(target),
      identity: `object:${key(canonical(target))}`,
      nearestExistingAncestor: canonical(target),
      isDirectory: true,
      isReparsePoint: false,
      exists: true,
      ...overrides,
    }),
    isSameOrDescendant: async (root, target) => {
      const r = key(canonical(root));
      const t = key(canonical(target));
      return t === r || t.startsWith(`${r}/`);
    },
    isSameObject: async (left, right) => key(canonical(left)) === key(canonical(right)),
  };
}

async function admit(
  target: string,
  protectedRoots: ProtectedRoot[],
  probe: WorkspacePathProbe = fakeProbe(),
) {
  return admitWorkspace({ target, protectedRoots, probe });
}

describe('admitWorkspace', () => {
  it('rejects a workspace below a closure root', async () => {
    await expect(admit('C:/Windows/Temp/project', [
      { path: 'C:/Windows', policy: 'closure' },
    ])).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.closure-root',
    });
  });

  it('rejects a closure root itself and any protected descendant', async () => {
    await expect(admit('C:/Windows', [
      { path: 'C:/Windows', policy: 'closure' },
    ])).resolves.toMatchObject({ ok: false, ruleId: 'workspace.closure-root' });
  });

  it('allows a normal project below a home boundary root', async () => {
    await expect(admit('C:/Users/me/Desktop/project', [
      { path: 'C:/Users/me', policy: 'boundary' },
      { path: 'C:/Users/me/AppData', policy: 'closure' },
    ])).resolves.toMatchObject({
      ok: true,
      canonicalPath: 'C:/Users/me/Desktop/project',
      identity: 'object:c:/users/me/desktop/project',
    });
  });

  it('rejects the boundary root object itself', async () => {
    await expect(admit('C:/Users/me', [
      { path: 'C:/Users/me', policy: 'boundary' },
    ])).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.boundary-root',
    });
  });

  it('rejects a workspace that contains another protected root', async () => {
    await expect(admit('C:/Projects', [
      { path: 'C:/Projects/Sparkii', policy: 'closure' },
    ])).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.contains-protected-root',
    });
  });

  it('resolves aliases before checking protected roots', async () => {
    const probe = fakeProbe({
      'C:/Users/me/Link': 'C:/Windows/System32',
    }, { isReparsePoint: true });
    await expect(probe.inspect('C:/Users/me/Link')).resolves.toMatchObject({
      canonicalPath: 'C:/Windows/System32',
    });
    await expect(probe.isSameOrDescendant(
      'C:/Windows',
      'C:/Windows/System32',
    )).resolves.toBe(true);
    await expect(admit('C:/Users/me/Link', [
      { path: 'C:/Windows', policy: 'closure' },
      { path: 'C:/Users/me', policy: 'boundary' },
    ], probe)).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.closure-root',
    });
  });

  it('rejects a missing workspace whose nearest existing ancestor is protected', async () => {
    const probe = fakeProbe({}, {
      canonicalPath: 'C:/Users/me/AppData/Local/Sparkii/new-workspace',
      nearestExistingAncestor: 'C:/Users/me/AppData/Local/Sparkii',
      identity: 'missing-ancestor:sparkii',
      isDirectory: false,
      exists: false,
    });
    await expect(admit('C:/Users/me/AppData/Local/Sparkii/new-workspace', [
      { path: 'C:/Users/me/AppData/Local/Sparkii', policy: 'closure' },
    ], probe)).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.closure-root',
    });
  });

  it('allows a missing workspace below an ordinary existing ancestor', async () => {
    const probe = fakeProbe({}, {
      canonicalPath: 'C:/Users/me/Desktop/NewProject',
      nearestExistingAncestor: 'C:/Users/me/Desktop',
      identity: 'missing:new-project',
      isDirectory: false,
      exists: false,
    });
    await expect(admit('C:/Users/me/Desktop/NewProject', [
      { path: 'C:/Users/me', policy: 'boundary' },
    ], probe)).resolves.toMatchObject({
      ok: true,
      nearestExistingAncestor: 'C:/Users/me/Desktop',
    });
  });

  it('rejects an existing non-directory target', async () => {
    await expect(admit('C:/Users/me/file.txt', [
      { path: 'C:/Users/me', policy: 'boundary' },
    ], fakeProbe({}, { isDirectory: false, exists: true }))).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.not-directory',
    });
  });

  it('fails closed when the platform probe throws', async () => {
    const probe = fakeProbe();
    probe.inspect = vi.fn(async () => {
      throw new Error('access denied');
    });
    await expect(admit('C:/Users/me/project', [
      { path: 'C:/Users/me', policy: 'boundary' },
    ], probe)).resolves.toMatchObject({
      ok: false,
      ruleId: 'workspace.probe-failed',
    });
  });
});
