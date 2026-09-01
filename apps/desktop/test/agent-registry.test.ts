import { describe, expect, it } from 'vitest';
import { loadAgentRuntimes } from '../electron/main/agent-registry.js';

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
    ]);

    expect([...agents.keys()].sort()).toEqual(['contract-review', 'general']);
    expect(agents.get('general')?.tools).toEqual(['read']);
    expect(agents.get('contract-review')?.manifest.surface.entry).toBe('surface.tsx');
  });
});
