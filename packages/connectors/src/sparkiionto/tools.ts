import type { Connector, ToolHandler } from '../types.js';

/**
 * 本体只读工具面的 stub handler。
 *
 * 11 个工具全部 `host: 'main'`：工具定义只用于注册与模型可见面，真正的执行由 Main 侧
 * `executeOntologyTool`（凭据注入）完成。Pi 子进程若直接调用此 handler，只会得到拒答，
 * 与 `document.read` / `knowledge.search` 的既有 stub 写法一致。
 */
const handler: ToolHandler = async () => ({
  ok: false,
  error: { code: 'CONNECTOR_DENIED', message: 'ontology tools must run on main' },
});

export const sparkiiOntoConnector: Connector = {
  id: 'sparkiionto',
  tools: [
    {
      name: 'ontology.search_nodes',
      description: '在工艺图谱里按关键词查找节点（设备、参数、工序、事件），返回命中的节点列表。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
        required: ['query'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.search_documents',
      description: '在指定的工艺知识域里检索文档片段（工艺规程、说明、记录）。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          domainId: { type: 'string', description: '工艺知识域标识；缺省用该智能体绑定的默认域。' },
          limit: { type: 'number', maximum: 20, default: 6 },
        },
        required: ['query'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.node',
      description: '取一个节点的详情及其邻域（有哪些关联节点、什么关系、多少跳）。',
      params: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          depth: { type: 'number', default: 1 },
        },
        required: ['nodeId'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.path',
      description: '取两个节点之间的关系路径（中间经过哪些节点、多少跳）。',
      params: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          algorithm: { type: 'string', enum: ['bfs', 'dijkstra'] },
          directed: { type: 'boolean' },
        },
        required: ['source', 'target'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.decisions',
      description: '列出决策记录（可按类别过滤）。',
      params: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.decision_chain',
      description: '取某条决策的因果链、先例与合规结论。',
      params: {
        type: 'object',
        properties: {
          decisionId: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['decisionId'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.provenance',
      description: '取本体血缘：某条结论或某份文档的依据来源。',
      params: {
        type: 'object',
        properties: {
          domainId: { type: 'string' },
          documentId: { type: 'string' },
        },
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.graph_summary',
      description: '自检图谱规模（有多少节点、什么类型、有没有可推理的数据）。',
      params: { type: 'object', properties: {} },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.distance_matrix',
      description: '给一组节点返回两两距离（用于比较多个可疑原因谁离异常点更近）。',
      params: {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' } },
          metric: { type: 'string', enum: ['hops', 'weighted', 'semantic'] },
        },
        required: ['nodeIds'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.reason',
      description: '把事实与规则交给本体做逻辑推理，得到推出的结论（前向 / 反向）。',
      params: {
        type: 'object',
        properties: {
          facts: { type: 'array', items: { type: 'string' } },
          rules: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['forward', 'backward'] },
        },
        required: ['facts', 'rules'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
    {
      name: 'ontology.query',
      description: '对工艺图谱执行只读查询，支持聚合、分组与按属性过滤。这是高级查询入口，优先使用专用工具；没有结果不等于图谱里没有数据，也不等于没有风险。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      sideEffect: 'read',
      host: 'main',
      handler,
    },
  ],
  async init() {},
};
