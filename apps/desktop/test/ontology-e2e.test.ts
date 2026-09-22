import { describe, expect, it } from 'vitest';
import { executeOntologyTool } from '../electron/main/ontology-tools.js';
import type { AppSettings } from '../electron/main/settings.js';

/**
 * 平台级端到端（真实服务，opt-in）。
 *
 * 环境门：仅当 `SPARKII_ONTO_E2E_BASE_URL` 与 `SPARKII_ONTO_E2E_TOKEN` 同时存在时执行，
 * 否则 `describe.skip`（CI 与无服务环境静默跳过）。
 *
 * 服务端数据为契约探测语料（见 spec §2.3 / §13 事项 3）：6 节点 5 边、1 条血缘、
 * 决策为空。检索命中用真实中文词「窑尾」；路径端点读内存图（对端缺陷，spec §13 事项 1），
 * 在真实服务上要么返回路径、要么返回 `empty`，不得抛异常。
 */

const baseUrl = process.env.SPARKII_ONTO_E2E_BASE_URL;
const token = process.env.SPARKII_ONTO_E2E_TOKEN;
const hasGate = Boolean(baseUrl && token);

/** 契约探测语料的唯一知识域（来自 `GET /api/v1/datasets` 实测）。 */
const DOMAIN_ID = 'd264d494-01c7-4bf9-8c03-cd68219716ab';
/** 图内真实节点：文档节点与其中一个分块（来自 `GET /api/graph/nodes` 实测）。 */
const SOURCE = '071c7edd-f080-4cee-8dd5-14a88c674da1';
const TARGET = 'b1929b56-577d-5a21-8ae3-0410c925e1d0';

const settings: AppSettings = {
  sparkiionto: {
    baseUrl: baseUrl ?? 'http://127.0.0.1:9380',
    similarityThreshold: 0.2,
    bindings: [{ agentId: 'e2e', defaultDatasetId: DOMAIN_ID }],
  },
};

describe.skipIf(!hasGate)('ontology 平台级端到端（真实服务）', () => {
  it('环境门未配置时本用例组被跳过', () => {
    // 仅作文档锚点：真正跳过由 describe.skipIf 完成；进入此用例即说明门已配好。
    expect(hasGate).toBe(true);
  });

  it(
    '对本地本体服务跑通只读能力面并守住空/路径对端口径',
    async () => {
      const run = (toolName: string, args: Record<string, unknown>) =>
        executeOntologyTool({
          toolName,
          args,
          profileId: 'e2e',
          settings,
          credential: token as string,
        });

      const documents = await run('ontology.search_documents', { query: '窑尾' });
      expect(documents.ok).toBe(true);
      expect(documents.error).toBeUndefined();
      expect(Array.isArray(documents.data?.chunks)).toBe(true);
      expect(documents.data?.chunks.length).toBeGreaterThan(0);

      const nodes = await run('ontology.search_nodes', { query: '窑尾' });
      expect(nodes.ok).toBe(true);
      expect(nodes.error).toBeUndefined();
      expect(Array.isArray(nodes.data)).toBe(true);
      expect(nodes.data.length).toBeGreaterThan(0);

      const summary = await run('ontology.graph_summary', {});
      expect(summary.ok).toBe(true);
      expect(summary.error).toBeUndefined();
      expect(summary.data?.nodeCount).toBeGreaterThan(0);

      const provenance = await run('ontology.provenance', {});
      expect(provenance.ok).toBe(true);
      expect(provenance.error).toBeUndefined();
      expect(Array.isArray(provenance.data)).toBe(true);
      expect(provenance.data.length).toBeGreaterThan(0);

      const decisions = await run('ontology.decisions', {});
      expect(decisions.ok).toBe(true);
      expect(decisions.error).toBeUndefined();
      expect(decisions.empty).toBe(true);

      // 对端口径（spec §13）：真实服务上要么返回路径、要么返回 empty，不得抛异常。
      const path = await run('ontology.path', { source: SOURCE, target: TARGET });
      expect(path.ok).toBe(true);
      expect(path.error).toBeUndefined();
      expect(path.data !== undefined || path.empty === true).toBe(true);
    },
    120_000,
  );
});
