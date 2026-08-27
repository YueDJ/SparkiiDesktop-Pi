import { describe, it, expect, afterEach } from 'vitest';
import { initTheme, setTheme } from '../src/shell/theme.js';

afterEach(() => {
  document.documentElement.className = '';
  localStorage.clear();
  document.getElementById('sparkii-theme-tokens')?.remove();
});

describe('shell theme', () => {
  it('initTheme injects token styles and restores the saved theme', () => {
    localStorage.setItem('sparkii-theme', 'dark');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const style = document.getElementById('sparkii-theme-tokens') as HTMLStyleElement | null;
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain(':root {');
    expect(style!.textContent).toContain('.dark {');
    expect(style!.textContent).toContain('--color-primary: #2563EB');
    expect(style!.textContent).toContain('--control-height-md');
  });

  it('setTheme toggles the dark class and persists the choice', () => {
    initTheme();
    setTheme(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('sparkii-theme')).toBe('dark');
    setTheme(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('sparkii-theme')).toBe('light');
  });
});
