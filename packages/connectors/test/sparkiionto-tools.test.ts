import { describe, it, expect } from 'vitest';
import { sparkiiOntoConnector } from '../src/sparkiionto/tools.js';
import { knowledgeConnector } from '../src/knowledge/index.js';
import { documentConnector } from '../src/document/index.js';
import { reportConnector } from '../src/report/index.js';

describe('sparkiiOntoConnector tools', () => {
  const tools = sparkiiOntoConnector.tools;

  it('恰好 11 个工具且全部 host=main / read', () => {
    expect(tools).toHaveLength(11);
    for (const t of tools) expect(t).toMatchObject({ host: 'main', sideEffect: 'read' });
  });

  it('规范化后的函数名全局唯一', () => {
    const sdk = [...tools, ...knowledgeConnector.tools, ...documentConnector.tools, ...reportConnector.tools]
      .map((t) => t.name.replace(/[^a-zA-Z0-9_-]+/g, '_'));
    expect(new Set(sdk).size).toBe(sdk.length);
  });

  it('描述不泄露实现细节', () => {
    for (const t of tools) expect(t.description).not.toMatch(/SparkiiOnto|Paddle|SQL|graph:read|api\/v1/i);
  });

  it('query 的描述声明高级定位与空结果语义', () => {
    const q = tools.find((t) => t.name === 'ontology.query')!;
    expect(q.description).toContain('高级');
    expect(q.description).toContain('没有结果');
  });

  it('ontology.reason 不暴露 applyToGraph', () => {
    const reason = tools.find((t) => t.name === 'ontology.reason')!;
    expect(Object.keys((reason.params as any).properties)).not.toContain('applyToGraph');
  });
});
