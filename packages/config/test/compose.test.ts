import { describe, it, expect } from 'vitest';
import { applyDelta, resolveInheritance } from '../src/compose.js';
import type { ResolvedProfile } from '../src/types.js';

const base = (): ResolvedProfile => ({
  manifest: { name: 'base', version: '1.0.0', modelRouting: { tasks: {} } },
  agent: { skills: [], tools: ['document.read'], prompts: {}, workflow: {}, knowledge: [] },
  ui: { pages: { home: { a: 1 } }, theme: { file: 'theme/tokens.json' } },
  security: { roles: [], approval: { requireApproval: ['report.export'], timeoutMs: 60000, highRiskDoubleConfirm: true } },
});

describe('profile composition', () => {
  it('delta overrides tools and deep-merges approval', () => {
    const out = applyDelta(base(), {
      agent: { tools: ['document.read', 'report.export'] },
      security: { approval: { timeoutMs: 120000 } },
    } as any);
    expect(out.agent.tools).toEqual(['document.read', 'report.export']);
    expect(out.security.approval.timeoutMs).toBe(120000);
    expect(out.security.approval.requireApproval).toEqual(['report.export']);
  });

  it('child inherits and overrides locally', () => {
    const child = base();
    child.manifest = { ...child.manifest, name: 'customerA', extends: 'base' };
    child.ui.pages = { home: { a: 2, b: 3 } };
    const out = resolveInheritance(base(), child);
    expect(out.ui.pages).toEqual({ home: { a: 2, b: 3 } });
    expect(out.manifest.name).toBe('customerA');
  });
});
