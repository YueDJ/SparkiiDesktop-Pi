import { describe, it, expect } from 'vitest';
import { isPathInside } from '../src/workspace-guard.js';

describe('isPathInside', () => {
  it('accepts exact root and nested paths', () => {
    expect(isPathInside('C:/ws', 'C:/ws')).toBe(true);
    expect(isPathInside('C:/ws', 'C:/ws/a/b.txt')).toBe(true);
    expect(isPathInside('C:/ws', 'C:/ws/../ws/c.txt')).toBe(true);
  });
  it('rejects parent escape and sibling prefixes', () => {
    expect(isPathInside('C:/ws', 'C:/ws/../evil.txt')).toBe(false);
    expect(isPathInside('C:/ws', 'C:/ws2/x.txt')).toBe(false);
    expect(isPathInside('C:/ws', 'C:/')).toBe(false);
  });
});
