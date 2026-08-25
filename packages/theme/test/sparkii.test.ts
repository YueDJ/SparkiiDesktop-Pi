import { describe, it, expect } from 'vitest';
import { sparkiiLight, sparkiiDark, variantTheme } from '../src/sparkii.js';
import { resolveTheme, cssVariables } from '../src/tokens.js';

describe('Sparkii V3 theme tokens', () => {
  it('light and dark themes resolve as valid token sets', () => {
    expect(() => resolveTheme(sparkiiLight)).not.toThrow();
    expect(() => resolveTheme(sparkiiDark)).not.toThrow();
  });

  it('light theme carries the V3 brand tokens', () => {
    expect(sparkiiLight.color.primary).toBe('#2563EB');
    expect(sparkiiLight.color.surface).toBe('#FFFFFF');
    expect(sparkiiLight.color.bg).toBe('#F5F7FB');
    expect(sparkiiLight.radius.card).toBe('12px');
    expect(sparkiiLight.shadow.card).toContain('0 2px 8px');
  });

  it('dark theme differs on brand and semantic colors', () => {
    expect(sparkiiDark.color.primary).toBe('#60A5FA');
    expect(sparkiiDark.color.bg).toBe('#0B1220');
    expect(sparkiiDark.color.surface).toBe('#111A2C');
    expect(sparkiiDark.color.primary).not.toBe(sparkiiLight.color.primary);
  });

  it('cssVariables emits :root for light and .dark for dark', () => {
    expect(cssVariables(sparkiiLight)).toContain(':root {');
    expect(cssVariables(sparkiiLight)).toContain('--color-primary: #2563EB');
    expect(cssVariables(sparkiiDark, '.dark')).toContain('.dark {');
    expect(cssVariables(sparkiiDark, '.dark')).toContain('--color-primary: #60A5FA');
  });

  it('variantTheme picks light or dark token set', () => {
    expect(variantTheme('light')).toBe(sparkiiLight);
    expect(variantTheme('dark')).toBe(sparkiiDark);
  });
});
