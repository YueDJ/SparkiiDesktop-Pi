import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '../src/loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('repo profiles', () => {
  it('loads general profile with coding saddle tools and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'apps/desktop/agents/general'), { allowUnsigned: true });
    expect(p.manifest.displayName).toBe('通用智能体');
    expect(p.agent.tools).toEqual(['read', 'ls', 'grep', 'find', 'bash', 'edit', 'write']);
    expect(p.agent.prompts.system).toContain('通用智能体');
  });
  it('loads contract profile with read tool and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'apps/desktop/agents/contract-review'), { allowUnsigned: true });
    expect(p.agent.tools).toContain('read');
    expect(p.agent.prompts.system).toBeTruthy();
  });
  it('loads knowledge-qa with sparkiirag session picker and search-only tools', async () => {
    const p = await loadProfile(join(repoRoot, 'apps/desktop/agents/knowledge-qa'), { allowUnsigned: true });
    expect(p.manifest.displayName).toBe('企业知识问答');
    expect(p.manifest.knowledge).toEqual({ enabled: true, picker: 'session', backend: 'sparkiirag' });
    expect(p.agent.tools).toEqual(['knowledge.search', 'knowledge.fetch_document']);
    expect(p.agent.prompts.system).toContain('knowledge.search');
  });
});
