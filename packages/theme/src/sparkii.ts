import type { DesignTokens } from './tokens.js';

const base = {
  spacing: { xxs: '4px', xs: '8px', sm: '12px', md: '16px' },
  radius: { control: '8px', button: '10px', card: '12px', overlay: '14px', pill: '999px' },
  shadow: { card: '0 2px 8px rgba(15,23,42,.04)', overlay: '0 8px 24px rgba(15,23,42,.12)' },
  font: {
    body: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  },
};

export const sparkiiLight: DesignTokens = {
  ...base,
  color: {
    bg: '#F5F7FB',
    surface: '#FFFFFF',
    border: '#EAF0F6',
    borderStrong: '#E2E8F0',
    text: '#1E293B',
    textSecondary: '#475569',
    textMuted: '#94A3B8',
    primary: '#2563EB',
    primaryHover: '#1D4ED8',
    primaryBg: '#EFF6FF',
    risk: '#B91C1C',
    riskBg: '#FEF2F2',
    warn: '#C2410C',
    warnBg: '#FFF7ED',
    ok: '#15803D',
    okBg: '#F0FDF4',
  },
};

export const sparkiiDark: DesignTokens = {
  ...base,
  color: {
    bg: '#0B1220',
    surface: '#111A2C',
    border: '#1E293B',
    borderStrong: '#28364A',
    text: '#E2E8F0',
    textSecondary: '#94A3B8',
    textMuted: '#64748B',
    primary: '#60A5FA',
    primaryHover: '#3B82F6',
    primaryBg: 'rgba(59,130,246,.14)',
    risk: '#F87171',
    riskBg: 'rgba(248,113,113,.12)',
    warn: '#FBBF24',
    warnBg: 'rgba(245,158,11,.12)',
    ok: '#4ADE80',
    okBg: 'rgba(74,222,128,.12)',
  },
};

export function variantTheme(variant: 'light' | 'dark'): DesignTokens {
  return variant === 'dark' ? sparkiiDark : sparkiiLight;
}
