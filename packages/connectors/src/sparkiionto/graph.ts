import { ConnectorError } from '../types.js';
import { SparkiiOntoClient, SparkiiOntoHttpError } from './client.js';
import type { OntoDecision, OntoGraphNode, OntoPathResult } from './types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 把服务端节点裁剪为业务形状：只保留 id/type/content/properties，丢弃 valid_from/valid_until 等信封字段。 */
function mapNode(raw: unknown): OntoGraphNode {
  const rec = asRecord(raw);
  const node: OntoGraphNode = {
    id: typeof rec.id === 'string' ? rec.id : '',
    type: typeof rec.type === 'string' ? rec.type : '',
  };
  if (typeof rec.content === 'string') node.content = rec.content;
  if (rec.properties !== null && typeof rec.properties === 'object' && !Array.isArray(rec.properties)) {
    node.properties = rec.properties as Record<string, unknown>;
  }
  return node;
}

/** 决策记录：decision_id→id、timestamp→createdAt，其余字段透传（不返回服务端原始信封）。 */
function mapDecision(raw: unknown): OntoDecision {
  const rec = asRecord(raw);
  const out: OntoDecision = { id: '' };
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'decision_id') out.id = String(value ?? '');
    else if (key === 'timestamp') {
      if (typeof value === 'string') out.createdAt = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 图谱/决策/查询客户端的默认 limit。 */
const DEFAULT_LIMIT = 20;
const DEFAULT_NEIGHBOR_DEPTH = 1;
const DEFAULT_PRECEDENT_LIMIT = 10;

/**
 * SparkiiOnto 只读图能力客户端（契约层）。
 *
 * 复用 `SparkiiOntoClient` 的 baseUrl 校验、凭据、超时与 `/info` 能力协商（不新建并行栈）。
 * 产品面（`/api/v1/onto/*`）与 Explorer 面（`/api/graph/*`、`/api/decisions/*`、`/api/sparql`、
 * `/api/reason`）都走 `requestJson`；`errorDetail` 已兼容产品面 `message` 与 Explorer 面 `detail` 两套键。
 */
export class SparkiiOntoGraph extends SparkiiOntoClient {
  /** 前置校验：`/info` 的 `capabilities.graph === true`，不满足抛 CONNECTOR_UNSUPPORTED。 */
  private async ensureGraph(): Promise<void> {
    const info = await this.info();
    if (info.capabilities.graph !== true) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', 'SparkiiOnto 未声明 graph 能力，无法访问本体图');
    }
  }

  /** 在工艺图谱里按关键词查找节点（产品面图搜索）。 */
  async searchNodes(input: { query: string; limit?: number }): Promise<OntoGraphNode[]> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/v1/onto/graph/search`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: input.query, limit: input.limit ?? DEFAULT_LIMIT }),
    });
    return asArray(payload).map((item) => mapNode(asRecord(item).node));
  }

  /** 取单个节点详情。 */
  async getNode(nodeId: string): Promise<OntoGraphNode> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/v1/onto/graph/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return mapNode(payload);
  }

  /** 取某节点的邻域（关联节点、关系、权重、跳数）；404 归一化为空数组。 */
  async neighbors(nodeId: string, depth = DEFAULT_NEIGHBOR_DEPTH): Promise<Array<OntoGraphNode & { relationship: string; weight: number; hop: number }>> {
    await this.ensureGraph();
    try {
      const payload = await this.requestJson(`${this.address}/api/graph/node/${encodeURIComponent(nodeId)}/neighbors?depth=${depth}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      return asArray(payload).map((item) => {
        const rec = asRecord(item);
        return {
          ...mapNode(rec),
          relationship: typeof rec.relationship === 'string' ? rec.relationship : '',
          weight: typeof rec.weight === 'number' ? rec.weight : 0,
          hop: typeof rec.hop === 'number' ? rec.hop : 0,
        };
      });
    } catch (error) {
      if (error instanceof SparkiiOntoHttpError && error.status === 404) return [];
      throw error;
    }
  }

  /** 取两节点间的关系路径；404（无路径）归一化为 null（不是错误）。 */
  async path(input: { source: string; target: string; algorithm?: 'bfs' | 'dijkstra'; directed?: boolean }): Promise<OntoPathResult> {
    await this.ensureGraph();
    const params = new URLSearchParams({ source: input.source, target: input.target });
    if (input.algorithm) params.set('algorithm', input.algorithm);
    if (input.directed !== undefined) params.set('directed', String(input.directed));
    try {
      const payload = await this.requestJson(`${this.address}/api/graph/path?${params.toString()}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      const rec = asRecord(payload);
      const nodes = Array.isArray(rec.path) ? rec.path.map(String) : [];
      const result: NonNullable<OntoPathResult> = {
        nodes,
        hopCount: typeof rec.hop_count === 'number' ? rec.hop_count : (nodes.length ? nodes.length - 1 : 0),
      };
      if (typeof rec.total_weight === 'number') result.weight = rec.total_weight;
      return result;
    } catch (error) {
      if (error instanceof SparkiiOntoHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** 给一组节点返回两两距离矩阵。 */
  async distanceMatrix(input: { nodeIds: string[]; metric?: 'hops' | 'weighted' | 'semantic' }): Promise<{ nodes: string[]; matrix: number[][] }> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/graph/distance-matrix`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_ids: input.nodeIds, metric: input.metric ?? 'hops' }),
    });
    const rec = asRecord(payload);
    const nodes = Array.isArray(rec.nodes) ? rec.nodes.map(String) : [];
    const matrix = Array.isArray(rec.matrix)
      ? rec.matrix.map((row) => (Array.isArray(row) ? row.map((value) => (typeof value === 'number' ? value : Number.NaN)) : []))
      : [];
    return { nodes, matrix };
  }

  /** 列出决策记录（可按类别过滤）。 */
  async listDecisions(input: { category?: string; limit?: number }): Promise<OntoDecision[]> {
    await this.ensureGraph();
    const params = new URLSearchParams();
    if (input.category) params.set('category', input.category);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const qs = params.toString();
    const payload = await this.requestJson(`${this.address}/api/decisions${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return asArray(payload).map(mapDecision);
  }

  /** 取某条决策的因果链、先例与合规结论。 */
  async decisionChain(decisionId: string, limit = DEFAULT_PRECEDENT_LIMIT): Promise<{ chain: unknown; precedents: unknown[]; compliance: unknown }> {
    await this.ensureGraph();
    const encoded = encodeURIComponent(decisionId);
    const chainPayload = await this.requestJson(`${this.address}/api/decisions/${encoded}/chain`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const precedentsPayload = await this.requestJson(`${this.address}/api/decisions/${encoded}/precedents?limit=${limit}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const compliancePayload = await this.requestJson(`${this.address}/api/decisions/${encoded}/compliance`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const chainRecord = asRecord(chainPayload);
    const complianceRecord = asRecord(compliancePayload);
    return {
      chain: Array.isArray(chainRecord.chain) ? chainRecord.chain : [],
      precedents: asArray(precedentsPayload).map(mapDecision),
      compliance: {
        compliant: complianceRecord.compliant === true,
        violations: Array.isArray(complianceRecord.violations) ? complianceRecord.violations : [],
      },
    };
  }

  /** 取本体血缘记录。 */
  async provenance(input: { domainId?: string; documentId?: string }): Promise<Array<Record<string, unknown>>> {
    await this.ensureGraph();
    const params = new URLSearchParams();
    if (input.domainId) params.set('domain_id', input.domainId);
    if (input.documentId) params.set('document_id', input.documentId);
    const qs = params.toString();
    const payload = await this.requestJson(`${this.address}/api/v1/onto/provenance${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    return asArray(payload).map(asRecord);
  }

  /** 把事实与规则交给本体做逻辑推理；不传 apply_to_graph（D16：写开关不进模型可见面）。 */
  async reason(input: { facts: unknown[]; rules: unknown[]; mode?: 'forward' | 'backward' }): Promise<unknown> {
    await this.ensureGraph();
    const body: Record<string, unknown> = { facts: input.facts, rules: input.rules };
    if (input.mode) body.mode = input.mode;
    return this.requestJson(`${this.address}/api/reason`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** 对图谱执行只读查询；返回结果行。 */
  async query(input: { query: string }): Promise<unknown[]> {
    await this.ensureGraph();
    const payload = await this.requestJson(`${this.address}/api/sparql`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: input.query }),
    });
    const rows = asRecord(payload).rows;
    return Array.isArray(rows) ? rows : [];
  }
}
