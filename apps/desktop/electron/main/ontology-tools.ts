import { ConnectorError, SparkiiOntoGraph } from '@sparkii/connectors';
import { knowledgeBackendSettings, type KnowledgeBackendSettings } from './knowledge-settings.js';
import type { AppSettings } from './settings.js';

/** `ontology.query` 的响应体上限：超出即截断并置 `truncated: true`（D16 护栏）。 */
export const QUERY_MAX_BYTES = 256 * 1024;

/** 逐工具总预算（spec §6）：query 单独更短超时，其余走默认 30s。 */
export const TOOL_BUDGET_MS: Record<string, number> = {
  'ontology.query': 10_000,
  default: 30_000,
};

export type OntologyToolResult = {
  ok: boolean;
  data?: unknown;
  empty?: boolean;
  truncated?: boolean;
  error?: { code: string; message: string };
};

/**
 * 带总预算的图客户端：在每次 `requestJson`（含 `/info` 协商与各工具端点）之前
 * 用注入的时钟计算剩余预算，耗尽即抛 `CONNECTOR_IO`，保证多端点工具不返回部分结果。
 */
class BudgetedOntoGraph extends SparkiiOntoGraph {
  constructor(
    private readonly deadline: number,
    private readonly clock: () => number,
    opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch },
  ) {
    super(opts);
  }

  protected override async requestJson(url: string, init: RequestInit, budgetMs?: number): Promise<unknown> {
    const remaining = this.deadline - this.clock();
    if (remaining <= 0) {
      throw new ConnectorError('CONNECTOR_IO', '本体工具总预算已耗尽，已停止后续请求');
    }
    return super.requestJson(url, init, budgetMs ?? remaining);
  }
}

function asInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isEmpty(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/** 递归裁剪字符串字段，使截断后的数据仍是合法 JSON 且体积受控。 */
function clipStrings(value: unknown, maxLen: number): unknown {
  if (typeof value === 'string') return value.slice(0, maxLen);
  if (Array.isArray(value)) return value.map((item) => clipStrings(item, maxLen));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clipStrings(item, maxLen);
    }
    return out;
  }
  return value;
}

/** 把查询结果行裁到 `maxBytes` 以内（逐级收缩字符串字段）。 */
function truncateQueryRows(rows: unknown[], maxBytes: number): unknown[] {
  let maxLen = 1024;
  let out = rows.map((row) => clipStrings(row, maxLen));
  while (Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes && maxLen > 1) {
    maxLen = Math.floor(maxLen / 2);
    out = rows.map((row) => clipStrings(row, maxLen));
  }
  return out;
}

function mapError(error: unknown): OntologyToolResult {
  if (error instanceof ConnectorError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'CONNECTOR_IO', message } };
}

/** `ontology.search_documents` 的默认域：命中该智能体绑定，否则返回 `undefined`。 */
export function resolveOntologyDefaultDomain(settings: AppSettings, profileId: string): string | undefined {
  const bindings = settings.sparkiionto?.bindings;
  if (!Array.isArray(bindings)) return undefined;
  const hit = bindings.find((b) => b?.agentId === profileId);
  return hit?.defaultDatasetId || undefined;
}

async function dispatch(
  graph: BudgetedOntoGraph,
  toolName: string,
  args: Record<string, unknown>,
  profileId: string,
  settings: AppSettings,
  kb: KnowledgeBackendSettings,
): Promise<OntologyToolResult> {
  switch (toolName) {
    case 'ontology.search_nodes': {
      const nodes = await graph.searchNodes({ query: String(args.query ?? ''), limit: asInt(args.limit, 20) });
      return isEmpty(nodes) ? { ok: true, empty: true } : { ok: true, data: nodes };
    }
    case 'ontology.search_documents': {
      const query = String(args.query ?? '');
      const domainId = typeof args.domainId === 'string' && args.domainId
        ? args.domainId
        : resolveOntologyDefaultDomain(settings, profileId);
      if (!domainId) {
        return {
          ok: false,
          error: {
            code: 'CONNECTOR_DENIED',
            message: '未绑定默认工艺知识域，请先在设置 → 知识库为该智能体绑定默认域',
          },
        };
      }
      const result = await graph.retrieve({
        question: query,
        datasetIds: [domainId],
        similarityThreshold: kb.similarityThreshold,
        topK: asInt(args.limit, 6),
      });
      return result.chunks.length === 0 ? { ok: true, empty: true, data: result } : { ok: true, data: result };
    }
    case 'ontology.node': {
      const nodeId = String(args.nodeId ?? '');
      const node = await graph.getNode(nodeId);
      const neighbors = await graph.neighbors(nodeId, asInt(args.depth, 1));
      return { ok: true, data: { node, neighbors } };
    }
    case 'ontology.path': {
      const result = await graph.path({
        source: String(args.source ?? ''),
        target: String(args.target ?? ''),
        ...(typeof args.algorithm === 'string' ? { algorithm: args.algorithm as 'bfs' | 'dijkstra' } : {}),
        ...(typeof args.directed === 'boolean' ? { directed: args.directed } : {}),
      });
      return result === null ? { ok: true, empty: true } : { ok: true, data: result };
    }
    case 'ontology.decisions': {
      const decisions = await graph.listDecisions({
        ...(typeof args.category === 'string' && args.category ? { category: args.category } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      return isEmpty(decisions) ? { ok: true, empty: true } : { ok: true, data: decisions };
    }
    case 'ontology.decision_chain': {
      const data = await graph.decisionChain(String(args.decisionId ?? ''), asInt(args.limit, 10));
      return { ok: true, data };
    }
    case 'ontology.provenance': {
      const records = await graph.provenance({
        ...(typeof args.domainId === 'string' && args.domainId ? { domainId: args.domainId } : {}),
        ...(typeof args.documentId === 'string' && args.documentId ? { documentId: args.documentId } : {}),
      });
      return isEmpty(records) ? { ok: true, empty: true } : { ok: true, data: records };
    }
    case 'ontology.graph_summary': {
      const summary = await graph.graphSummary();
      return { ok: true, data: summary };
    }
    case 'ontology.distance_matrix': {
      const data = await graph.distanceMatrix({
        nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [],
        ...(typeof args.metric === 'string' ? { metric: args.metric as 'hops' | 'weighted' | 'semantic' } : {}),
      });
      return { ok: true, data };
    }
    case 'ontology.reason': {
      const data = await graph.reason({
        facts: Array.isArray(args.facts) ? args.facts : [],
        rules: Array.isArray(args.rules) ? args.rules : [],
        ...(typeof args.mode === 'string' ? { mode: args.mode as 'forward' | 'backward' } : {}),
      });
      return { ok: true, data };
    }
    case 'ontology.query': {
      const rows = await graph.query({ query: String(args.query ?? '') });
      if (rows.length === 0) return { ok: true, empty: true };
      if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > QUERY_MAX_BYTES) {
        return { ok: true, truncated: true, data: truncateQueryRows(rows, QUERY_MAX_BYTES) };
      }
      return { ok: true, data: rows };
    }
    default:
      return { ok: false, error: { code: 'CONNECTOR_UNSUPPORTED', message: `未知的本体工具：${toolName}` } };
  }
}

export async function executeOntologyTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  profileId: string;
  settings: AppSettings;
  credential: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<OntologyToolResult> {
  const clock = input.now ?? Date.now;

  if (input.credential === null) {
    return {
      ok: false,
      error: {
        code: 'CONNECTOR_DENIED',
        message: '未配置 SparkiiOnto 凭据，请先在设置 → 知识库配置 SparkiiOnto',
      },
    };
  }

  const kb = knowledgeBackendSettings('sparkiionto', input.settings);
  const budget = TOOL_BUDGET_MS[input.toolName] ?? TOOL_BUDGET_MS.default;
  const deadline = clock() + budget;

  let graph: BudgetedOntoGraph;
  try {
    graph = new BudgetedOntoGraph(deadline, clock, {
      baseUrl: kb.baseUrl,
      apiKey: input.credential,
      fetch: input.fetch,
    });
  } catch (error) {
    return mapError(error);
  }

  try {
    return await dispatch(graph, input.toolName, input.args, input.profileId, input.settings, kb);
  } catch (error) {
    return mapError(error);
  }
}

function resultSize(toolName: string, data: unknown): string {
  if (data == null) return '';
  if (Array.isArray(data)) return `count=${data.length}`;
  if (typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    if (toolName === 'ontology.graph_summary') {
      return `nodes=${rec.nodeCount ?? '?'} edges=${rec.edgeCount ?? '?'}`;
    }
    if (Array.isArray(rec.chunks)) return `hits=${rec.chunks.length}`;
    if (toolName === 'ontology.path' && typeof rec.hopCount === 'number') return `hops=${rec.hopCount}`;
  }
  return '';
}

/**
 * 审计摘要：按工具名记录调用与结果规模，不记 token、不记服务端原始信封。
 * 唯一豁免：`ontology.query` 记录查询全文（D16）。
 */
export function ontologyAuditSummary(toolName: string, args: Record<string, unknown>, result: unknown): string {
  const query = typeof args.query === 'string' ? args.query : '';
  if (toolName === 'ontology.query') {
    return query ? `ontology.query ${query}` : 'ontology.query';
  }

  const rec = (result && typeof result === 'object' ? result : {}) as OntologyToolResult;
  if (rec.ok === false && rec.error?.message) {
    return `${toolName} ${rec.error.code ?? 'error'}: ${rec.error.message}`;
  }
  if (rec.empty) return `${toolName} empty`;
  const size = resultSize(toolName, rec.data);
  return `${toolName}${size ? ` ${size}` : ''}${rec.truncated ? ' truncated' : ''}`;
}
