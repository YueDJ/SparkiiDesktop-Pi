import { randomInt, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function randomWorkspaceToken(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) out += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
  return out;
}

export function formatWorkspaceTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export function workspaceName(now: Date): string {
  return `Sparkii${randomWorkspaceToken()}${formatWorkspaceTimestamp(now)}`;
}

export function autoWorkspacePath(desktop: string, now: Date): string {
  return join(desktop, workspaceName(now));
}

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
