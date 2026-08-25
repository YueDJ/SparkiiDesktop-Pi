import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '../src/loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('repo profiles', () => {
  it('loads general profile with coding saddle tools and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'profiles/general'), { allowUnsigned: true });
    expect(p.manifest.displayName).toBe('通用智能体');
    expect(p.agent.tools).toEqual(['read', 'ls', 'grep', 'find', 'bash', 'edit', 'write']);
    expect(p.agent.prompts.system).toContain('通用智能体');
  });
  it('loads contract profile with read tool and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'profiles/contract-review'), { allowUnsigned: true });
    expect(p.agent.tools).toContain('read');
    expect(p.agent.prompts.system).toBeTruthy();
  });
});
