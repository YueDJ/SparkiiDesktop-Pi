import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAgentRuntimes, resolveAgentSkillsDir } from '../electron/main/agent-registry.js';

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'main');

describe('resolveAgentSkillsDir', () => {
  it('places a user library under dataDir/agents/<id>/skills', () => {
    expect(resolveAgentSkillsDir({
      id: 'general',
      dir: 'C:/agents/general',
      dataDir: 'C:/data',
      skillLibrary: 'user',
    })).toBe(join('C:/data', 'agents', 'general', 'skills'));
  });

  it('keeps package and omitted skillLibrary on the agent package path', () => {
    expect(resolveAgentSkillsDir({
      id: 'finance',
      dir: 'C:/agents/finance',
      dataDir: 'C:/data',
      skillLibrary: 'package',
    })).toBe(join('C:/agents/finance', 'agent', 'skills'));
    expect(resolveAgentSkillsDir({
      id: 'finance',
      dir: 'C:/agents/finance',
      dataDir: 'C:/data',
    })).toBe(join('C:/agents/finance', 'agent', 'skills'));
  });
});

describe('loadAgentRuntimes', () => {
  it('loads general and contract-review as agents', async () => {
    const agents = await loadAgentRuntimes([
      {
        id: 'general',
        dir: 'C:/agents/general',
        manifest: {
          id: 'general',
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools: ['read'] },
        },
      },
      {
        id: 'contract-review',
        dir: 'C:/agents/contract-review',
        manifest: {
          id: 'contract-review',
          version: '1.0.0',
          surface: { type: 'workflow', entry: 'surface.tsx' },
          capabilities: { tools: ['document.read'] },
        },
      },
    ], { dataDir: 'C:/data' });

    expect([...agents.keys()].sort()).toEqual(['contract-review', 'general']);
    expect(agents.get('general')?.tools).toEqual(['read']);
    expect(agents.get('contract-review')?.manifest.surface.entry).toBe('surface.tsx');
    expect(agents.get('general')?.skillsDir).toBe(join('C:/agents/general', 'agent', 'skills'));
    expect(agents.get('contract-review')?.skillsDir).toBe(join('C:/agents/contract-review', 'agent', 'skills'));
  });

  it('splits user and package skillsDir from skillLibrary, not agent id', async () => {
    const agents = await loadAgentRuntimes([
      {
        id: 'writer',
        dir: 'C:/agents/writer',
        manifest: {
          id: 'writer',
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools: ['read'] },
          skillLibrary: 'user',
        },
      },
      {
        id: 'finance',
        dir: 'C:/agents/finance',
        manifest: {
          id: 'finance',
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools: ['read'] },
        },
      },
    ], { dataDir: 'C:/data' });

    expect(agents.get('writer')?.skillsDir).toBe(join('C:/data', 'agents', 'writer', 'skills'));
    expect(agents.get('finance')?.skillsDir).toBe(join('C:/agents/finance', 'agent', 'skills'));
    expect(agents.get('writer')?.skillsDir).not.toBe(agents.get('finance')?.skillsDir);
  });

  it('does not branch skill assembly on agent id in production sources', () => {
    const repoRoot = join(mainDir, '..', '..', '..', '..');
    const files = [
      ...readdirSync(mainDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(mainDir, name)),
      join(repoRoot, 'packages', 'config', 'src', 'schema.ts'),
      join(repoRoot, 'packages', 'config', 'src', 'agent.ts'),
      join(repoRoot, 'packages', 'config', 'src', 'loader.ts'),
      join(repoRoot, 'packages', 'agent-host', 'src', 'tool-registry.ts'),
      join(repoRoot, 'packages', 'agent-host', 'src', 'pi-sdk-runtime.ts'),
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/id\s*===\s*['"]general['"]/);
      expect(src, file).not.toMatch(/id\s*===\s*['"]contract-review['"]/);
    }
  });
});
