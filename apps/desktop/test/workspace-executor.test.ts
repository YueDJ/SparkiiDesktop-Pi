import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashPayload,
  type ResourceRef,
  type SecurityAction,
  type TaskGrant,
  type WorkspacePathProbe,
} from '@sparkii/approval';
import {
  WorkspaceExecutionError,
  createWorkspaceExecutor,
} from '../electron/main/security/workspace-executor.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function probe(reparse = new Set<string>()): WorkspacePathProbe {
  return {
    inspect: async (target) => ({
      displayPath: target,
      canonicalPath: target,
      identity: `mock:${key(target)}`,
      nearestExistingAncestor: target,
      isDirectory: existsSync(target) ? statSync(target).isDirectory() : false,
      isReparsePoint: reparse.has(key(target)),
      exists: existsSync(target),
    }),
    isSameOrDescendant: async (root, target) => {
      const r = key(root);
      const t = key(target);
      return t === r || t.startsWith(`${r}/`);
    },
    isSameObject: async (left, right) => key(left) === key(right),
  };
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'sparkii-executor-'));
  const workspace = join(base, 'workspace');
  const scratch = join(base, 'scratch', 't1');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const grant: TaskGrant = {
    taskId: 't1',
    sessionId: 's1',
    agentId: 'general',
    profileId: 'general',
    actorId: 'u1',
    unattended: false,
    planMode: 'execute',
    permissionMode: 'ask',
    workspaceRoot: workspace,
    workspaceIdentity: `mock:${key(workspace)}`,
    inputRoots: [],
    scratchRoot: scratch,
    networkDomains: [],
    externalCapabilities: [],
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  return { base, workspace, scratch, grant };
}

function resource(path: string, scope: ResourceRef['scope'] = 'workspace'): ResourceRef {
  return {
    kind: 'path',
    value: path,
    identity: `mock:${key(path)}`,
    parentIdentity: `mock:${key(dirname(path))}`,
    scope,
  };
}

function action(
  toolName: string,
  args: Record<string, unknown>,
  resources: ResourceRef[],
): SecurityAction {
  return {
    id: `a-${toolName}`,
    taskId: 't1',
    sessionId: 's1',
    agentId: 'general',
    profileId: 'general',
    toolName,
    capability: 'fs.write',
    resources,
    payload: args,
    payloadHash: hashPayload(args),
    risk: 'write',
    reason: 'workspace',
  };
}

describe('WorkspaceExecutor', () => {
  it('creates nested files atomically inside the workspace', async () => {
    const s = setup();
    const executor = createWorkspaceExecutor({ probe: probe() });
    const target = join(s.workspace, 'src', 'nested', 'a.txt');
    const result = await executor.execute(
      action('write', { path: target, content: 'hello' }, [resource(target)]),
      s.grant,
    );
    expect(readFileSync(target, 'utf8')).toBe('hello');
    expect(result).toMatchObject({
      path: target,
      changes: [{ path: target, kind: 'created' }],
    });
  });

  it('lazily creates a missing admitted workspace on the first write', async () => {
    const s = setup();
    const missingWorkspace = join(s.base, 'lazy-workspace');
    const target = join(missingWorkspace, 'a.txt');
    const grant = {
      ...s.grant,
      workspaceRoot: missingWorkspace,
      workspaceIdentity: `mock:${key(missingWorkspace)}`,
    };
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute(
      action('write', { path: target, content: 'x' }, [{
        ...resource(target),
        parentIdentity: `mock:${key(missingWorkspace)}`,
      }]),
      grant,
    )).resolves.toMatchObject({ path: target });
    expect(readFileSync(target, 'utf8')).toBe('x');
  });

  it('can create and register a missing workspace before shell execution', async () => {
    const s = setup();
    const missingWorkspace = join(s.base, 'shell-workspace');
    const grant = {
      ...s.grant,
      workspaceRoot: missingWorkspace,
      workspaceIdentity: `mock:${key(missingWorkspace)}`,
    };
    const executor = createWorkspaceExecutor({ probe: probe() });
    const created = await executor.ensureWorkspace(grant);
    expect(created.canonicalPath).toBe(missingWorkspace);
    expect(existsSync(missingWorkspace)).toBe(true);
    expect(executor.liveWorkspaceIdentity(grant.taskId))
      .toBe(`mock:${key(missingWorkspace)}`);
  });

  it('replaces existing content without writing a partial file', async () => {
    const s = setup();
    const target = join(s.workspace, 'a.txt');
    writeFileSync(target, 'old');
    const executor = createWorkspaceExecutor({ probe: probe() });
    await executor.execute(
      action('write', { path: target, content: 'new' }, [resource(target)]),
      s.grant,
    );
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('writes task scratch but rejects input-resource writes', async () => {
    const s = setup();
    const executor = createWorkspaceExecutor({ probe: probe() });
    const scratchPath = join(s.scratch, 'temp.txt');
    await expect(executor.execute(
      action('write', { path: scratchPath, content: 'x' }, [resource(scratchPath, 'scratch')]),
      s.grant,
    )).resolves.toMatchObject({ path: scratchPath });

    const inputPath = join(s.base, 'input.txt');
    await expect(executor.execute(
      action('write', { path: inputPath, content: 'x' }, [resource(inputPath, 'input')]),
      s.grant,
    )).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('rejects a target identity or parent identity change before mutation', async () => {
    const s = setup();
    const target = join(s.workspace, 'a.txt');
    writeFileSync(target, 'old');
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute(
      action('write', { path: target, content: 'new' }, [{
        ...resource(target),
        identity: 'mock:replaced',
      }]),
      s.grant,
    )).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(readFileSync(target, 'utf8')).toBe('old');

    await expect(executor.execute(
      action('write', { path: target, content: 'new' }, [{
        ...resource(target),
        parentIdentity: 'mock:other-parent',
      }]),
      s.grant,
    )).rejects.toMatchObject({ code: 'PARENT_CHANGED' });
  });

  it('rejects a payload whose hash no longer matches the normalized action', async () => {
    const s = setup();
    const target = join(s.workspace, 'a.txt');
    writeFileSync(target, 'old');
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute({
      ...action('write', { path: target, content: 'new' }, [resource(target)]),
      payloadHash: 'not-the-payload-hash',
    }, s.grant)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('rejects reparse targets and trust-anchor paths', async () => {
    const s = setup();
    const target = join(s.workspace, 'link.txt');
    const executor = createWorkspaceExecutor({
      probe: probe(new Set([key(target)])),
    });
    await expect(executor.execute(
      action('write', { path: target, content: 'x' }, [resource(target)]),
      s.grant,
    )).rejects.toBeInstanceOf(WorkspaceExecutionError);

    const env = join(s.workspace, '.env');
    await expect(executor.execute(
      action('write', { path: env, content: 'SECRET=x' }, [resource(env)]),
      { ...s.grant },
    )).rejects.toMatchObject({ code: 'TRUST_ANCHOR' });
  });

  it('rejects files with hardlink aliases instead of modifying the shared object', async () => {
    const s = setup();
    const outside = join(s.base, 'outside.txt');
    const inside = join(s.workspace, 'hardlink.txt');
    writeFileSync(outside, 'original');
    linkSync(outside, inside);
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute(
      action('write', { path: inside, content: 'changed' }, [resource(inside)]),
      s.grant,
    )).rejects.toMatchObject({ code: 'HARDLINK_ALIAS' });
    expect(readFileSync(outside, 'utf8')).toBe('original');
  });

  it('deletes ordinary files and subdirectories but never the workspace root', async () => {
    const s = setup();
    const directory = join(s.workspace, 'generated');
    const file = join(directory, 'a.txt');
    mkdirSync(directory);
    writeFileSync(file, 'x');
    const executor = createWorkspaceExecutor({ probe: probe() });
    const result = await executor.execute(
      action('delete', { path: directory }, [resource(directory)]),
      s.grant,
    );
    expect(existsSync(directory)).toBe(false);
    expect(result.changes).toEqual([
      { path: file, kind: 'deleted' },
      { path: directory, kind: 'deleted' },
    ]);

    await expect(executor.execute(
      action('delete', { path: s.workspace }, [resource(s.workspace)]),
      s.grant,
    )).rejects.toMatchObject({ code: 'CRITICAL_TARGET' });
    expect(existsSync(s.workspace)).toBe(true);
  });

  it('moves files inside the workspace and rejects external destinations', async () => {
    const s = setup();
    const from = join(s.workspace, 'a.txt');
    const to = join(s.workspace, 'renamed.txt');
    writeFileSync(from, 'x');
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute(
      action('move', { from, to }, [resource(from), resource(to)]),
      s.grant,
    )).resolves.toMatchObject({
      path: to,
      changes: [{ path: from, to, kind: 'moved' }],
    });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, 'utf8')).toBe('x');

    const outside = join(s.base, 'outside.txt');
    await expect(executor.execute(
      action('move', { from: to, to: outside }, [resource(to), resource(outside, 'external')]),
      s.grant,
    )).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });
});
