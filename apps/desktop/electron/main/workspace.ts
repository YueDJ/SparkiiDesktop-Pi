import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function defaultWorkspacePath(documents: string, agentId: string, sessionId: string): string {
  return join(documents, 'Sparkii', 'workspaces', agentId, sessionId);
}

export function assertAgentId(agentId: string): string {
  const id = String(agentId ?? '').trim();
  if (!id || id.includes('..') || /[\\/]/.test(id)) throw new Error('invalid agentId');
  return id;
}

export function allocateAutoWorkspace(documents: string, agentId: string): { workspaceKey: string; workspacePath: string } {
  const workspaceKey = randomUUID();
  return { workspaceKey, workspacePath: defaultWorkspacePath(documents, assertAgentId(agentId), workspaceKey) };
}

export async function ensureWorkspaceDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export { isPathInside } from '@sparkii/agent-host';
