import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { hashPayload, type ResourceRef, type SecurityAction, type TaskGrant, type WorkspacePathProbe } from '@sparkii/approval';
import { createWorkspaceFileService } from '../electron/main/security/workspace-file-service.js';
import { createWorkspaceExecutor } from '../electron/main/security/workspace-executor.js';
import { createActionNormalizer, DEFAULT_TOOL_DESCRIPTORS } from '../electron/main/security/action-normalizer.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function key(value: string) { return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function canonical(value: string): string {
  let current = resolve(value);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    suffix.unshift(relative(parent, current));
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}
function probe(): WorkspacePathProbe {
  return {
    inspect: async (target) => {
      const abs = resolve(target);
      const exists = existsSync(abs);
      const canonicalPath = canonical(abs);
      let info: ReturnType<typeof lstatSync> | undefined;
      try { info = lstatSync(abs); } catch { /* missing */ }
      return {
        displayPath: target, canonicalPath, identity: `real:${key(canonicalPath)}`,
        nearestExistingAncestor: canonical(dirname(abs)), isDirectory: info?.isDirectory() ?? false,
        isReparsePoint: info?.isSymbolicLink() ?? false, exists,
      };
    },
    isSameOrDescendant: async (root, target) => {
      const rel = relative(key(root), key(target));
      return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
    },
    isSameObject: async (left, right) => key(canonical(left)) === key(canonical(right)),
  };
}

function setup(withLink = true) {
  const root = mkdtempSync(join(tmpdir(), 'sparkii-fence-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.sparkii'), { recursive: true });
  writeFileSync(join(workspace, '.sparkii', 'memory.json'), '{"secret":"memory"}');
  writeFileSync(join(workspace, 'ordinary.txt'), 'ordinary');
  if (withLink) symlinkSync(join(workspace, '.sparkii'), join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const rec = { id: 's1', profileId: 'general', workspacePath: workspace };
  const audits: Array<Record<string, unknown>> = [];
  const service = createWorkspaceFileService({
    chatSessions: { get: (id: string) => id === 's1' ? rec : undefined } as never,
    audit: { append: async (event: Record<string, unknown>) => { audits.push(event); return event; } } as never,
    security: { pathProbe: probe(), protectedRoots: [] } as never,
    subjectUserId: 'u1',
  });
  return { root, workspace, service, audits };
}

function executorAction(toolName: string, args: Record<string, unknown>, path: string, grant: TaskGrant): SecurityAction {
  const resource: ResourceRef = {
    kind: 'path', value: path, identity: `real:${key(canonical(path))}`,
    parentIdentity: `real:${key(canonical(dirname(path)))}`, scope: 'workspace',
  };
  return {
    id: `a-${toolName}`, taskId: grant.taskId, sessionId: grant.sessionId, agentId: grant.agentId,
    profileId: grant.profileId, toolName, capability: 'fs.write', resources: [resource], payload: args,
    payloadHash: hashPayload(args), risk: 'write', reason: 'workspace',
  };
}

describe('P0 .sparkii canonical fence', () => {
  it.each(['read', 'readBytes', 'write', 'writeBytes', 'delete', 'rename', 'move'] as const)(
    'generic IPC denies %s through a real junction alias', async (op) => {
      const { workspace, service } = setup();
      const request = {
        sessionId: 's1', path: 'alias/memory.json',
        ...(op === 'write' ? { content: 'changed' } : {}),
        ...(op === 'writeBytes' ? { bytesBase64: Buffer.from('changed').toString('base64') } : {}),
        ...(op === 'rename' || op === 'move' ? { to: 'ordinary.txt' } : {}),
      };
      const result = await service.execute(op, request);
      expect(result.ok).toBe(false);
      expect(readFileSync(join(workspace, '.sparkii', 'memory.json'), 'utf8')).toBe('{"secret":"memory"}');
    },
  );

  it('generic IPC denies direct canonical and hardlink aliases but keeps ordinary files usable', async () => {
    const { workspace, service } = setup(false);
    expect((await service.execute('read', { sessionId: 's1', path: '.sparkii/memory.json' })).ok).toBe(false);
    linkSync(join(workspace, '.sparkii', 'memory.json'), join(workspace, 'linked.json'));
    expect((await service.execute('read', { sessionId: 's1', path: 'linked.json' })).ok).toBe(false);
    expect((await service.execute('write', { sessionId: 's1', path: 'ordinary.txt', content: 'ok' })).ok).toBe(true);
    expect((await service.execute('read', { sessionId: 's1', path: 'ordinary.txt' })).ok).toBe(true);
  });

  it.each(['target', 'parent'] as const)('Main read normalization rejects a generic reparse %s', async (where) => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-reparse-read-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'alias', 'ordinary.txt');
    const parent = dirname(target);
    const reparseProbe: WorkspacePathProbe = {
      inspect: async (value) => ({
        displayPath: value,
        canonicalPath: value,
        identity: `object:${key(value)}`,
        nearestExistingAncestor: value,
        isDirectory: value !== target,
        isReparsePoint: where === 'target' ? value === target : value === parent,
        exists: true,
      }),
      isSameOrDescendant: async (left, right) => key(right).startsWith(`${key(left)}/`),
      isSameObject: async (left, right) => key(left) === key(right),
    };
    const normalizer = createActionNormalizer({ descriptors: DEFAULT_TOOL_DESCRIPTORS, protectedRoots: [], probe: reparseProbe });
    const grant: TaskGrant = {
      taskId: 't1', sessionId: 's1', agentId: 'general', profileId: 'general', actorId: 'u1',
      unattended: false, planMode: 'execute', permissionMode: 'ask', workspaceRoot: workspace,
      workspaceIdentity: `object:${key(workspace)}`, inputRoots: [], scratchRoot: join(root, 'scratch'),
      networkDomains: [], externalCapabilities: [], createdAt: 1, expiresAt: Date.now() + 60_000,
    };
    await expect(normalizer.authorizeRead(target, grant)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('production WorkspaceExecutor rejects direct canonical .sparkii resources', async () => {
    const { root, workspace } = setup(false);
    const target = join(workspace, '.sparkii', 'memory.json');
    const grant: TaskGrant = {
      taskId: 't1', sessionId: 's1', agentId: 'general', profileId: 'general', actorId: 'u1',
      unattended: false, planMode: 'execute', permissionMode: 'ask', workspaceRoot: workspace,
      workspaceIdentity: `real:${key(canonical(workspace))}`, inputRoots: [], scratchRoot: join(root, 'scratch'),
      networkDomains: [], externalCapabilities: [], createdAt: 1, expiresAt: Date.now() + 60_000,
    };
    const executor = createWorkspaceExecutor({ probe: probe() });
    await expect(executor.execute(executorAction('write', { path: target, content: 'changed' }, target, grant), grant))
      .rejects.toMatchObject({ code: 'DENIED' });
    expect(readFileSync(target, 'utf8')).toBe('{"secret":"memory"}');
  });
});
