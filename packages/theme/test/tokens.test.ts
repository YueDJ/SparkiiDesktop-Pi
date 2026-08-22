import { describe, it, expect } from 'vitest';
import { resolveTheme, cssVariables } from '../src/tokens.js';

describe('theme tokens', () => {
  it('resolves tokens and emits css variables', () => {
    const tokens = resolveTheme({ color: { primary: '#111' }, spacing: { md: '8px' }, radius: { md: '6px' }, shadow: { md: '0 1px 2px' }, font: { body: 'sans-serif' } });
    expect(cssVariables(tokens)).toContain('--color-primary: #111');
  });
  it('rejects missing token group', () => {
    expect(() => resolveTheme({ color: {} })).toThrow(/THEME_INVALID/);
  });
});
