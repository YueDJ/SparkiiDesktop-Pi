import { describe, expect, it } from 'vitest';
import { parseAgentManifest } from '../src/agent.js';

describe('parseAgentManifest', () => {
  it('parses a standard chat agent manifest', () => {
    const manifest = parseAgentManifest({
      id: 'general',
      displayName: '通用智能体',
      version: '1.0.0',
      surface: { type: 'chat' },
      capabilities: { tools: ['read', 'bash'] },
      modelRequirements: { requires: ['chat', 'toolCall'] },
    });

    expect(manifest.id).toBe('general');
    expect(manifest.surface.type).toBe('chat');
    expect(manifest.capabilities.tools).toEqual(['read', 'bash']);
  });

  it('accepts a custom surface entry', () => {
    const manifest = parseAgentManifest({
      id: 'contract-review',
      displayName: '合同审核智能体',
      version: '1.0.0',
      surface: { type: 'workflow', entry: 'surface.tsx' },
      capabilities: { tools: ['document.read'] },
      modelRequirements: { requires: ['reasoning'] },
    });

    expect(manifest.surface.entry).toBe('surface.tsx');
  });
});
