const DEFAULT_TRUST_ANCHOR_NAMES = new Set([
  '.env',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bashrc',
  '.profile',
  '.zshrc',
  '.mcp.json',
  'mcp.json',
  'id_rsa',
  'id_ed25519',
]);

function pathSegments(value: string): string[] {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/** Path-only trust-anchor detection shared by Main and the local read guard. */
export function isTrustAnchorPath(
  value: string,
  extraNames: string[] = [],
): boolean {
  const segments = pathSegments(value);
  const names = new Set([
    ...DEFAULT_TRUST_ANCHOR_NAMES,
    ...extraNames.map((entry) => entry.toLowerCase()),
  ]);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (names.has(segment) || segment.startsWith('.env.')) return true;
    if (segment === '.git') {
      const child = segments[index + 1];
      if (child === 'hooks' || child === 'config') return true;
    }
    if (
      segment === '.codex'
      || segment === '.cursor'
      || segment === '.claude'
    ) return true;
  }
  return false;
}
