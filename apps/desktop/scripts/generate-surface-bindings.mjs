import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..'); // apps/desktop
const agentsRoot = join(root, 'agents');
const outFile = join(root, 'src', 'platform', 'agent-surface-bindings.ts');

const lines = [
  '// AUTO-GENERATED from agents/*/manifest.yaml - do not edit by hand.',
  "import type { ComponentType } from 'react';",
  '',
];
const entries = [];

for (const name of readdirSync(agentsRoot)) {
  const dir = join(agentsRoot, name);
  const manifest = join(dir, 'manifest.yaml');
  if (!existsSync(manifest)) continue;

  const hasSurface = existsSync(join(dir, 'surface', 'index.tsx')) || existsSync(join(dir, 'surface', 'index.ts'));
  if (!hasSurface) continue;

  const safe = name.replace(/[^a-zA-Z0-9_]/g, '_');
  const rel = `../../agents/${name}/surface/index.js`;
  lines.push(`import Surface_${safe} from '${rel}';`);
  entries.push(`${JSON.stringify(name)}: Surface_${safe},`);
}

lines.push('export const surfaceByAgent: Record<string, ComponentType<any>> = {', ...entries, '};');
writeFileSync(outFile, lines.join('\n') + '\n');
console.log('wrote agent-surface-bindings.ts');
