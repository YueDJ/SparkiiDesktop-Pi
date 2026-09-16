import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'test', 'tests']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
}

function dirOf(path: string): string {
  return path;
}

describe('procurement-review isolation', () => {
  it('does not branch production code on procurement-review agent id', () => {
    const roots = [
      join(repoRoot, 'apps', 'desktop', 'src'),
      join(repoRoot, 'apps', 'desktop', 'electron'),
      join(repoRoot, 'packages'),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(dirOf(root))) {
        const text = readFileSync(file, 'utf8');
        // 命中即失败：禁止对 procurement-review 做 === / == / 左右对调 / case 分支。
        // agent-surface-bindings.ts 的 Record 映射不含这些运算符，不应被扫中。
        const BRANCH = /(?:agent\.id|profileId|agentId)\s*===?\s*['"]procurement-review['"]|['"]procurement-review['"]\s*===?\s*(?:agent\.id|profileId|agentId)|case\s+['"]procurement-review['"]/;
        if (BRANCH.test(text)) {
          hits.push(relative(repoRoot, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
