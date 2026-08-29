import { describe, it, expect } from 'vitest';
import { parseProfileManifest } from '../src/schema.js';

describe('manifest displayName', () => {
  it('parses optional displayName', () => {
    const m = parseProfileManifest({
      name: 'general', version: '1.0.0', displayName: '通用智能体', sortOrder: 10,
      modelRouting: { tasks: { default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] } },
    });
    expect(m.displayName).toBe('通用智能体');
    expect(m.sortOrder).toBe(10);
  });
  it('is absent when not declared', () => {
    const m = parseProfileManifest({ name: 'x', version: '1.0.0', modelRouting: { tasks: {} } });
    expect(m.displayName).toBeUndefined();
    expect(m.sortOrder).toBeUndefined();
  });
});
