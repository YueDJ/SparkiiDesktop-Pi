import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlatformReservedPath } from '@sparkii/agent-host';

export type WorkspaceTreeFenceCode = 'DENIED' | 'REPARSE_POINT';

export class WorkspaceTreeFenceError extends Error {
  constructor(
    public readonly code: WorkspaceTreeFenceCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceTreeFenceError';
  }
}

/**
 * Collect a tree in child-before-parent order without following links.
 * Callers must finish this fence before deleting or moving the source tree.
 */
export async function collectWorkspaceTree(
  target: string,
  isReparsePoint: (path: string, info: Stats) => Promise<boolean>,
): Promise<string[]> {
  if (isPlatformReservedPath(target)) {
    throw new WorkspaceTreeFenceError('DENIED', '.sparkii 是平台保留目录');
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || await isReparsePoint(target, info)) {
    throw new WorkspaceTreeFenceError(
      'REPARSE_POINT',
      'recursive workspace operation encountered a reparse point',
    );
  }
  if (!info.isDirectory()) return [target];

  const out: string[] = [];
  for (const name of await readdir(target)) {
    out.push(...await collectWorkspaceTree(join(target, name), isReparsePoint));
  }
  out.push(target);
  return out;
}
