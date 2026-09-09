import { describe, it, expect } from 'vitest';
import { parseProfileManifest } from '../src/schema.js';

describe('parseProfileManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseProfileManifest({
      name: 'contract-review',
      version: '1.0.0',
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    });
    expect(m.name).toBe('contract-review');
  });
  it('rejects missing modelRouting', () => {
    expect(() => parseProfileManifest({ name: 'x', version: '1.0.0' })).toThrow();
  });
  it('accepts optional skillLibrary package or user', () => {
    const user = parseProfileManifest({
      name: 'writer',
      version: '1.0.0',
      skillLibrary: 'user',
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    });
    expect(user.skillLibrary).toBe('user');
    const pack = parseProfileManifest({
      name: 'finance',
      version: '1.0.0',
      skillLibrary: 'package',
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    });
    expect(pack.skillLibrary).toBe('package');
  });
  it('rejects unknown skillLibrary values', () => {
    expect(() => parseProfileManifest({
      name: 'x',
      version: '1.0.0',
      skillLibrary: 'mixed',
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    })).toThrow();
  });
  it('keeps optional knowledge on the parsed manifest', () => {
    const m = parseProfileManifest({
      name: 'knowledge-qa',
      version: '1.0.0',
      knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' },
      modelRouting: { tasks: { default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] } },
    });
    expect(m.knowledge).toEqual({ enabled: true, picker: 'session', backend: 'sparkiirag' });
  });
  it('strips invalid knowledge.backend', () => {
    expect(() => parseProfileManifest({
      name: 'x',
      version: '1.0.0',
      knowledge: { enabled: true, picker: 'session', backend: 'pinecone' },
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    })).toThrow();
  });
});
