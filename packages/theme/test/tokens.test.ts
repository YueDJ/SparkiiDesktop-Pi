import { describe, it, expect } from 'vitest';
import { resolveTheme, cssVariables } from '../src/tokens.js';

const full = {
  color: { primary: '#111' },
  spacing: { md: '8px' },
  radius: { md: '6px' },
  shadow: { md: '0 1px 2px' },
  font: { body: 'sans-serif', 'size-sm': '12px' },
  control: { 'height-md': '34px' },
  motion: { normal: '180ms' },
  z: { modal: '50' },
};

describe('theme tokens', () => {
  it('resolves tokens and emits css variables', () => {
    const tokens = resolveTheme(full);
    expect(cssVariables(tokens)).toContain('--color-primary: #111');
    expect(cssVariables(tokens)).toContain('--control-height-md: 34px');
    expect(cssVariables(tokens)).toContain('--motion-normal: 180ms');
    expect(cssVariables(tokens)).toContain('--z-modal: 50');
  });

  it('rejects missing token group', () => {
    expect(() => resolveTheme({ color: {} })).toThrow(/THEME_INVALID/);
  });
});
