import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  hashPayload,
  isTrustAnchorPath,
  type ResourceRef,
  type SecurityAction,
  type TaskGrant,
  type WorkspacePathInfo,
  type WorkspacePathProbe,
} from '@sparkii/approval';

export type WorkspaceExecutionCode =
  | 'UNSUPPORTED_TOOL'
  | 'SCOPE_DENIED'
  | 'CRITICAL_TARGET'
  | 'TRUST_ANCHOR'
  | 'TARGET_CHANGED'
  | 'PAYLOAD_CHANGED'
  | 'PARENT_CHANGED'
  | 'REPARSE_POINT'
  | 'HARDLINK_ALIAS'
  | 'TARGET_INVALID'
  | 'WORKSPACE_CHANGED'
  | 'IO_FAILED';

export class WorkspaceExecutionError extends Error {
  constructor(
    public readonly code: WorkspaceExecutionCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceExecutionError';
  }
}

export interface WorkspaceChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'moved';
  to?: string;
}

export interface WorkspaceExecutionResult {
  path: string;
  changes: WorkspaceChange[];
}

export interface WorkspaceExecutor {
  execute(
    action: SecurityAction,
    grant: TaskGrant,
  ): Promise<WorkspaceExecutionResult>;
  ensureWorkspace(grant: TaskGrant): Promise<WorkspacePathInfo>;
  liveWorkspaceIdentity(taskId: string): string | undefined;
}

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function equalPath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === ''
    || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function resourceFor(action: SecurityAction, index: number): ResourceRef {
  const resource = action.resources[index];
  if (!resource || resource.kind !== 'path') {
    throw new WorkspaceExecutionError(
      'TARGET_INVALID',
      `missing trusted path resource ${index}`,
    );
  }
  return resource;
}

export function createWorkspaceExecutor(opts: {
  probe: WorkspacePathProbe;
  trustAnchors?: string[];
}): WorkspaceExecutor {
  const liveWorkspaceIdentity = new Map<string, string>();

  const inspect = async (path: string): Promise<WorkspacePathInfo> => {
    try {
      return await opts.probe.inspect(path);
    } catch (error) {
      throw new WorkspaceExecutionError(
        'TARGET_INVALID',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const verifyResource = async (
    action: SecurityAction,
    grant: TaskGrant,
    resource: ResourceRef,
  ): Promise<WorkspacePathInfo> => {
    if (
      resource.scope === 'critical'
      || resource.scope === 'external'
      || resource.scope === 'input'
    ) {
      throw new WorkspaceExecutionError(
        resource.scope === 'critical' ? 'CRITICAL_TARGET' : 'SCOPE_DENIED',
        `workspace mutation is not allowed for ${resource.scope} resources`,
      );
    }
    const inspected = await inspect(resource.value);
    if (inspected.exists) {
      const current = await lstat(inspected.canonicalPath, { bigint: true });
      if (!current.isDirectory() && current.nlink > 1n) {
        throw new WorkspaceExecutionError(
          'HARDLINK_ALIAS',
          'workspace file has multiple hard links and cannot be mutated safely',
        );
      }
    }
    if (inspected.isReparsePoint) {
      throw new WorkspaceExecutionError(
        'REPARSE_POINT',
        'workspace mutation target is a reparse point',
      );
    }
    if (resource.trustAnchor || isTrustAnchorPath(inspected.canonicalPath, opts.trustAnchors)) {
      throw new WorkspaceExecutionError(
        'TRUST_ANCHOR',
        'workspace mutation target is a protected trust anchor',
      );
    }
    if (
      resource.scope === 'workspace'
      && !isInside(grant.workspaceRoot, inspected.canonicalPath)
    ) {
      throw new WorkspaceExecutionError(
        'SCOPE_DENIED',
        'target escaped the current workspace',
      );
    }
    if (
      resource.scope === 'scratch'
      && !isInside(grant.scratchRoot, inspected.canonicalPath)
    ) {
      throw new WorkspaceExecutionError(
        'SCOPE_DENIED',
        'target escaped the task scratch root',
      );
    }
    if (resource.identity && resource.identity !== inspected.identity) {
      throw new WorkspaceExecutionError(
        'TARGET_CHANGED',
        'target identity changed after normalization',
      );
    }
    const parent = await inspect(dirname(inspected.canonicalPath));
    if (
      resource.parentIdentity
      && resource.parentIdentity !== parent.identity
    ) {
      throw new WorkspaceExecutionError(
        'PARENT_CHANGED',
        'target parent identity changed after normalization',
      );
    }
    if (
      equalPath(inspected.canonicalPath, grant.workspaceRoot)
      || equalPath(inspected.canonicalPath, dirname(grant.workspaceRoot))
    ) {
      throw new WorkspaceExecutionError(
        'CRITICAL_TARGET',
        'the workspace root or its parent cannot be replaced',
      );
    }
    return inspected;
  };

  const verifyWorkspaceRoot = async (grant: TaskGrant): Promise<WorkspacePathInfo> => {
    const root = await inspect(grant.workspaceRoot);
    const expected = liveWorkspaceIdentity.get(grant.taskId)
      ?? grant.workspaceIdentity;
    if (root.identity !== expected) {
      throw new WorkspaceExecutionError(
        'WORKSPACE_CHANGED',
        'workspace root identity changed after Task Grant creation',
      );
    }
    if (root.isReparsePoint) {
      throw new WorkspaceExecutionError(
        'REPARSE_POINT',
        'workspace root became a reparse point',
      );
    }
    return root;
  };

  const ensureRoot = async (
    grant: TaskGrant,
    scope: ResourceRef['scope'],
  ): Promise<string> => {
    const root = scope === 'scratch' ? grant.scratchRoot : grant.workspaceRoot;
    const inspected = await inspect(root);
    if (inspected.isReparsePoint) {
      throw new WorkspaceExecutionError(
        'REPARSE_POINT',
        `${scope} root is a reparse point`,
      );
    }
    if (!inspected.exists) {
      if (scope === 'workspace') await verifyWorkspaceRoot(grant);
      await mkdir(root, { recursive: true });
      const created = await inspect(root);
      if (scope === 'workspace') {
        liveWorkspaceIdentity.set(grant.taskId, created.identity);
      }
    }
    return root;
  };

  const ensureDirectoryChain = async (
    root: string,
    targetDirectory: string,
  ): Promise<void> => {
    if (!isInside(root, targetDirectory)) {
      throw new WorkspaceExecutionError('SCOPE_DENIED', 'directory escaped its root');
    }
    const rel = relative(resolve(root), resolve(targetDirectory));
    let current = resolve(root);
    for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current);
        info = await lstat(current, { bigint: true });
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new WorkspaceExecutionError(
          info.isSymbolicLink() ? 'REPARSE_POINT' : 'TARGET_INVALID',
          `workspace path component is not a real directory: ${current}`,
        );
      }
    }
  };

  const atomicWrite = async (
    target: string,
    content: string,
    mustExist: boolean,
  ): Promise<'created' | 'modified'> => {
    const targetExists = await exists(target);
    if (mustExist && !targetExists) {
      throw new WorkspaceExecutionError('TARGET_INVALID', 'edit target does not exist');
    }
    if (targetExists) {
      const current = await lstat(target);
      if (current.isSymbolicLink()) {
        throw new WorkspaceExecutionError(
          'REPARSE_POINT',
          'write target is a symbolic link',
        );
      }
      if (!current.isFile()) {
        throw new WorkspaceExecutionError('TARGET_INVALID', 'write target is not a file');
      }
    }
    const temp = join(
      dirname(target),
      `.${basename(target)}.sparkii-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temp, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, target);
      return targetExists ? 'modified' : 'created';
    } catch (error) {
      try { await handle?.close(); } catch { /* already closed */ }
      try { await rm(temp, { force: true }); } catch { /* cleanup best effort */ }
      if (error instanceof WorkspaceExecutionError) throw error;
      throw new WorkspaceExecutionError(
        'IO_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const collectTree = async (target: string): Promise<string[]> => {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new WorkspaceExecutionError(
        'REPARSE_POINT',
        'recursive delete encountered a reparse point',
      );
    }
    if (!info.isDirectory()) return [target];
    const out: string[] = [];
    for (const name of await readdir(target)) {
      out.push(...await collectTree(join(target, name)));
    }
    out.push(target);
    return out;
  };

  return {
    liveWorkspaceIdentity: (taskId) => liveWorkspaceIdentity.get(taskId),
    async ensureWorkspace(grant) {
      await ensureRoot(grant, 'workspace');
      return inspect(grant.workspaceRoot);
    },
    async execute(action, grant) {
      if (action.capability !== 'fs.write') {
        throw new WorkspaceExecutionError(
          'UNSUPPORTED_TOOL',
          `workspace executor cannot perform ${action.capability}`,
        );
      }
      if (hashPayload(action.payload) !== action.payloadHash) {
        throw new WorkspaceExecutionError(
          'PAYLOAD_CHANGED',
          'action payload changed after normalization',
        );
      }
      await verifyWorkspaceRoot(grant);

      if (action.toolName === 'write' || action.toolName === 'edit') {
        const resource = resourceFor(action, 0);
        const target = await verifyResource(action, grant, resource);
        if (target.exists && !target.isDirectory && resource.scope === 'workspace') {
          // Existing file identities were already checked above.
        }
        const baseRoot = await ensureRoot(grant, resource.scope);
        await ensureDirectoryChain(baseRoot, dirname(target.canonicalPath));
        const content = String((action.payload as Record<string, unknown>)?.content ?? '');
        const kind = await atomicWrite(
          target.canonicalPath,
          content,
          action.toolName === 'edit',
        );
        return {
          path: target.canonicalPath,
          changes: [{ path: target.canonicalPath, kind }],
        };
      }

      if (action.toolName === 'delete') {
        const resource = resourceFor(action, 0);
        const target = await verifyResource(action, grant, resource);
        if (!target.exists) {
          throw new WorkspaceExecutionError('TARGET_INVALID', 'delete target does not exist');
        }
        const deleted = await collectTree(target.canonicalPath);
        const current = await inspect(target.canonicalPath);
        if (current.identity !== target.identity) {
          throw new WorkspaceExecutionError(
            'TARGET_CHANGED',
            'delete target changed immediately before removal',
          );
        }
        try {
          await rm(target.canonicalPath, { recursive: true, force: false });
        } catch (error) {
          throw new WorkspaceExecutionError(
            'IO_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
        return {
          path: target.canonicalPath,
          changes: deleted.map((path) => ({ path, kind: 'deleted' as const })),
        };
      }

      if (action.toolName === 'move') {
        const sourceResource = resourceFor(action, 0);
        const destinationResource = resourceFor(action, 1);
        const source = await verifyResource(action, grant, sourceResource);
        const destination = await verifyResource(action, grant, destinationResource);
        if (!source.exists) {
          throw new WorkspaceExecutionError('TARGET_INVALID', 'move source does not exist');
        }
        if (destination.exists) {
          throw new WorkspaceExecutionError(
            'TARGET_INVALID',
            'move destination already exists',
          );
        }
        const baseRoot = await ensureRoot(grant, destinationResource.scope);
        await ensureDirectoryChain(baseRoot, dirname(destination.canonicalPath));
        try {
          await rename(source.canonicalPath, destination.canonicalPath);
        } catch (error) {
          throw new WorkspaceExecutionError(
            'IO_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
        return {
          path: destination.canonicalPath,
          changes: [{
            path: source.canonicalPath,
            to: destination.canonicalPath,
            kind: 'moved',
          }],
        };
      }

      throw new WorkspaceExecutionError(
        'UNSUPPORTED_TOOL',
        `unsupported workspace tool: ${action.toolName}`,
      );
    },
  };
}
