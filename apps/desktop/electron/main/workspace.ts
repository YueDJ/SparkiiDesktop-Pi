import { randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Short, speakable folder names: glow-fox-k7m. Ambiguous 0/O/1/l/I are omitted. */
const ADJECTIVES = [
  'amber', 'bright', 'calm', 'clear', 'crisp', 'eager', 'fair', 'fresh',
  'gentle', 'glad', 'golden', 'keen', 'kind', 'light', 'lucid', 'merry',
  'nimble', 'noble', 'open', 'quiet', 'silver', 'soft', 'steady', 'still',
  'sunny', 'swift', 'tidy', 'vivid', 'warm', 'wise',
] as const;

const NOUNS = [
  'brook', 'cedar', 'clover', 'crane', 'ember', 'fern', 'flint', 'fox',
  'glow', 'grove', 'harbor', 'heron', 'iris', 'lark', 'lantern', 'lotus',
  'maple', 'meadow', 'oak', 'pebble', 'pine', 'ripple', 'river', 'spark',
  'stone', 'tide', 'trail', 'willow', 'wren', 'acorn',
] as const;

const TAG_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

export const WORKSPACE_KEY_PATTERN = /^[a-z]+-[a-z]+-[a-z2-9]{3}$/;

export function allocateWorkspaceKey(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  let tag = '';
  for (let i = 0; i < 3; i++) tag += TAG_CHARS[randomInt(TAG_CHARS.length)];
  return `${adjective}-${noun}-${tag}`;
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
  const workspaceKey = allocateWorkspaceKey();
  return { workspaceKey, workspacePath: defaultWorkspacePath(documents, assertAgentId(agentId), workspaceKey) };
}

export async function ensureWorkspaceDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export { isPathInside } from '@sparkii/agent-host';
