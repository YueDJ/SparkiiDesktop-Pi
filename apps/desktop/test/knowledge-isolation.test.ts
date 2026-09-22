import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { knowledgeConnector, sparkiiOntoConnector } from '@sparkii/connectors';
import { loadProfile } from '@sparkii/config';

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

describe('knowledge-qa isolation', () => {
  it('does not branch production code on knowledge-qa agent id', () => {
    const roots = [
      join(repoRoot, 'apps', 'desktop', 'src'),
      join(repoRoot, 'apps', 'desktop', 'electron'),
      join(repoRoot, 'packages'),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(dirOf(root))) {
        const text = readFileSync(file, 'utf8');
        if (/if\s*\(\s*(agent\.id|profileId|agentId)\s*===\s*['"]knowledge-qa['"]/.test(text)) {
          hits.push(relative(repoRoot, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('does not call SparkiiRAG chat completions from production code', () => {
    const roots = [
      join(repoRoot, 'apps', 'desktop', 'src'),
      join(repoRoot, 'apps', 'desktop', 'electron'),
      join(repoRoot, 'packages'),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(dirOf(root))) {
        const text = readFileSync(file, 'utf8');
        if (text.includes('/api/v1/openai/')) hits.push(relative(repoRoot, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps knowledge.search params free of datasetId', () => {
    const search = knowledgeConnector.tools.find((t) => t.name === 'knowledge.search')!;
    const props = (search.params as { properties: Record<string, unknown> }).properties;
    expect(props.datasetId).toBeUndefined();
  });

  it('does not import the dataset picker from StandardChat', () => {
    const src = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'surface', 'standard-chat.tsx'), 'utf8');
    expect(src).not.toContain('KnowledgeDatasetPicker');
  });

  // 出处归属（spec Decision 9）：气泡把命中的 `backend` 透传给 Main，Main 才能按后端取原文。
  // 这里做的是"接线守卫"（源码级）；完整的渲染断言随新智能体的 surface 一期补齐。
  it('forwards the citation backend when opening a source document', () => {
    const src = readFileSync(
      join(repoRoot, 'apps', 'desktop', 'agents', 'knowledge-qa', 'surface', 'index.tsx'),
      'utf8',
    );
    const call = src.slice(src.indexOf('api.openRagDocument?.(', src.indexOf('onOpenDocument')));
    expect(call).toContain('backend: doc.backend,');
  });

  it('本体工具全部在 Main 执行且不在 Pi 侧发请求', () => {
    for (const t of sparkiiOntoConnector.tools) expect(t.host).toBe('main');
    expect(sourceOf('packages/connectors/src/sparkiionto/tools.ts')).not.toMatch(/\bfetch\(/);
  });
});

/**
 * 新增 `sparkiionto` 后端时，现存 profile 的 `knowledge` 块必须与 `main` 逐字段一致
 * （期望值就是 `main` 上的取值：`git show main:apps/desktop/agents/<id>/manifest.yaml`）。
 * 这里用生产同一条解析链（`@sparkii/config` 的 `loadProfile`）读仓库里的 manifest，
 * 不额外依赖 git 或构建产物。
 */
describe('shipped profiles keep the knowledge block recorded on main', () => {
  const loadManifest = (id: string) => loadProfile(join(repoRoot, 'apps', 'desktop', 'agents', id), { allowUnsigned: true });

  it('parses contract-review and procurement-review as the local bm25 backend with a hidden picker', async () => {
    for (const id of ['contract-review', 'procurement-review']) {
      const profile = await loadManifest(id);
      expect(profile.manifest.knowledge, id).toEqual({ enabled: true, picker: 'hidden', backend: 'bm25' });
    }
  });

  it('keeps knowledge-qa on SparkiiRAG with a session picker', async () => {
    const profile = await loadManifest('knowledge-qa');
    expect(profile.manifest.knowledge).toEqual({ enabled: true, picker: 'session', backend: 'sparkiirag' });
  });

  it('leaves general without a knowledge block', async () => {
    const profile = await loadManifest('general');
    expect(profile.manifest.knowledge).toBeUndefined();
  });
});

function dirOf(path: string): string {
  return path;
}

function sourceOf(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}
