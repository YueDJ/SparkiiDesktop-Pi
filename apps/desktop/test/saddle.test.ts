import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '@sparkii/config';
import type { ProfileRuntime } from '../electron/main/runtime.js';
import { buildProfileSaddle } from '../electron/main/saddle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const contractDir = join(repoRoot, 'profiles', 'contract-review');

describe('buildProfileSaddle', () => {
  it('assembles the contract-review saddle with tools, skills dir, prompt, and anchor cwd', async () => {
    const profile = await loadProfile(contractDir, { allowUnsigned: true });
    const pr = { profile, dir: contractDir } as ProfileRuntime;
    const anchor = join(repoRoot, 'tmp-sessions', 's1');

    const saddle = buildProfileSaddle(pr, anchor);

    expect(saddle.tools).toEqual(['document.read', 'knowledge.search', 'report.export', 'read']);
    expect(saddle.skillsDir).toBe(join(contractDir, 'agent', 'skills'));
    expect(saddle.skillsDir?.split(/[\\/]/).slice(-2).join('/')).toBe('agent/skills');
    expect(saddle.systemPrompt).toBeTruthy();
    expect(saddle.systemPrompt).toContain('合同审核智能体');
    expect(saddle.cwd).toBe(anchor);
    expect(saddle.workspaceRoot).toBeUndefined();
  });

  it('passes the workspace root through when provided', async () => {
    const profile = await loadProfile(contractDir, { allowUnsigned: true });
    const pr = { profile, dir: contractDir } as ProfileRuntime;
    const ws = join(repoRoot, 'tmp-workspaces', 'ws-1');

    const saddle = buildProfileSaddle(pr, join(repoRoot, 'tmp-sessions', 's2'), ws);

    expect(saddle.workspaceRoot).toBe(ws);
  });

  it('derives the saddle purely from the given profile and paths', () => {
    const pr = {
      dir: 'C:/profiles/minimal',
      profile: {
        agent: {
          tools: ['read'],
          prompts: { system: 'minimal system prompt' },
        },
      },
    } as unknown as ProfileRuntime;

    const saddle = buildProfileSaddle(pr, 'C:/anchor/a');

    expect(saddle.tools).toEqual(['read']);
    expect(saddle.skillsDir).toBe(join('C:/profiles/minimal', 'agent', 'skills'));
    expect(saddle.systemPrompt).toBe('minimal system prompt');
    expect(saddle.cwd).toBe('C:/anchor/a');
    expect(saddle.workspaceRoot).toBeUndefined();
  });

  it('keeps bash when no shell override is provided', () => {
    const pr = {
      dir: 'C:/profiles/general',
      profile: {
        agent: {
          tools: ['read', 'bash'],
          prompts: { system: 'general system prompt' },
        },
      },
    } as unknown as ProfileRuntime;

    const saddle = buildProfileSaddle(pr, 'C:/anchor/a');

    expect(saddle.tools).toEqual(['read', 'bash']);
  });
});
