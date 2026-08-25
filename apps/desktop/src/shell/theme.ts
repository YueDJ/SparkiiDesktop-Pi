import { cssVariables, sparkiiLight, sparkiiDark } from '@sparkii/theme';

const TOKEN_STYLE_ID = 'sparkii-theme-tokens';

function ensureTokenStyle(): HTMLStyleElement {
  let style = document.getElementById(TOKEN_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = TOKEN_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `${cssVariables(sparkiiLight)}\n${cssVariables(sparkiiDark, '.dark')}`;
  return style;
}

export function readSavedTheme(): 'light' | 'dark' {
  try {
    return localStorage.getItem('sparkii-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function initTheme(): 'light' | 'dark' {
  ensureTokenStyle();
  const saved = readSavedTheme();
  document.documentElement.classList.toggle('dark', saved === 'dark');
  return saved;
}

export function setTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('sparkii-theme', dark ? 'dark' : 'light');
  } catch {
    /* storage unavailable */
  }
}
