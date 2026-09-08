import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '@sparkii/config';
import type { AgentRuntime } from '../electron/main/agent-registry.js';
import type { ProfileRuntime } from '../electron/main/runtime.js';
import { buildAgentSaddle, buildProfileSaddle } from '../electron/main/saddle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const contractDir = join(repoRoot, 'apps', 'desktop', 'agents', 'contract-review');

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

describe('buildAgentSaddle', () => {
  it('passes through a user-library skillsDir unchanged', () => {
    const skillsDir = join('C:/data', 'agents', 'writer', 'skills');
    const agent = {
      id: 'writer',
      dir: 'C:/agents/writer',
      tools: ['read', 'bash'],
      skillsDir,
      systemPrompt: 'user library prompt',
      manifest: {
        id: 'writer',
        version: '1.0.0',
        surface: { type: 'chat' },
        capabilities: { tools: ['read', 'bash'] },
        skillLibrary: 'user',
      },
    } as AgentRuntime;

    const saddle = buildAgentSaddle(agent, 'C:/anchor/a');

    expect(saddle.skillsDir).toBe(skillsDir);
    expect(saddle.tools).toEqual(['read', 'bash']);
    expect(saddle.systemPrompt).toBe('user library prompt');
  });

  it('keeps a package agent skillsDir on the package agent/skills path', async () => {
    const profile = await loadProfile(contractDir, { allowUnsigned: true });
    const agent: AgentRuntime = {
      id: 'contract-review',
      dir: contractDir,
      tools: profile.agent.tools,
      skillsDir: join(contractDir, 'agent', 'skills'),
      systemPrompt: profile.agent.prompts.system,
      manifest: {
        id: 'contract-review',
        version: profile.manifest.version,
        surface: { type: 'workflow', entry: 'surface.tsx' },
        capabilities: { tools: profile.agent.tools },
      },
    };

    const saddle = buildAgentSaddle(agent, join(repoRoot, 'tmp-sessions', 's3'));

    expect(saddle.skillsDir).toBe(join(contractDir, 'agent', 'skills'));
    expect(saddle.skillsDir).not.toContain(join('dataDir', 'agents', 'general'));
  });

  it('does not leak a user-library skill into contract-review loadProfile', async () => {
    const before = await loadProfile(contractDir, { allowUnsigned: true });
    const beforeNames = before.agent.skills.map((s) => s.name).sort();
    const userSkill = join(repoRoot, 'tmp-user-skills', 'extra-user-skill');
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(
      join(userSkill, 'SKILL.md'),
      '---\nname: extra-user-skill\ndescription: Should not appear in contract-review.\n---\n# extra\n',
      'utf8',
    );

    const after = await loadProfile(contractDir, { allowUnsigned: true });
    expect(after.agent.skills.map((s) => s.name).sort()).toEqual(beforeNames);
    expect(after.agent.skills.map((s) => s.name)).not.toContain('extra-user-skill');
  });
});

