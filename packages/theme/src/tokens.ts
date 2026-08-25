export interface DesignTokens {
  color: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  font: Record<string, string>;
}
const groups = ['color', 'spacing', 'radius', 'shadow', 'font'] as const;

export function resolveTheme(raw: unknown): DesignTokens {
  if (!raw || typeof raw !== 'object') throw new Error('THEME_INVALID: theme must be an object');
  for (const g of groups) {
    if (!(raw as any)[g] || typeof (raw as any)[g] !== 'object') throw new Error(`THEME_INVALID: missing ${g}`);
  }
  return raw as DesignTokens;
}

export function cssVariables(tokens: DesignTokens, selector: ':root' | '.dark' = ':root'): string {
  const vars: string[] = [];
  for (const g of groups) {
    for (const [k, v] of Object.entries(tokens[g])) vars.push(`--${g}-${k}: ${v}`);
  }
  return `${selector} { ${vars.join('; ')}; }`;
}
