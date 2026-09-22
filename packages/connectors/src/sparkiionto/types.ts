/**
 * SparkiiOnto 专有类型。
 *
 * 兼容端点（`/datasets`、`/retrieval`、原文下载）的**载荷形状**与 SparkiiRAG 完全一致，
 * 因此复用 `sparkiirag/map.ts` 的映射函数，这里只声明 `/api/v1/info` 能力协商的响应。
 */

export type SparkiiOntoRetrieval = {
  /** 后端自述的检索实现，如 `sql-lexical`。 */
  backend: string;
  /** 是否具备语义嵌入检索；`false` 表示词法检索。 */
  semantic_embeddings: boolean;
};

/** `/info` 的 `capabilities`：键名由服务端定义，值均为布尔。 */
export type SparkiiOntoCapabilities = Record<string, boolean>;

export type SparkiiOntoInfo = {
  product: string;
  version: string;
  api_version: string;
  deployment_profile: string;
  retrieval: SparkiiOntoRetrieval;
  capabilities: SparkiiOntoCapabilities;
};

/** Desktop 侧消费的 dataset（= Onto 的知识域）列表项。 */
export type SparkiiOntoDataset = { id: string; name: string };

/** 图节点（裁剪后的业务形状，不含服务端信封字段如 valid_from/valid_until）。 */
export type OntoGraphNode = {
  id: string;
  type: string;
  content?: string;
  properties?: Record<string, unknown>;
};

/** 图边（裁剪后的业务形状）。 */
export type OntoGraphEdge = {
  source: string;
  target: string;
  type: string;
  weight?: number;
};

/** 图谱规模自检。 */
export type OntoGraphSummary = {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
};

/** 两节点间路径；无路径时为 null（不是错误）。 */
export type OntoPathResult = {
  nodes: string[];
  hopCount: number;
  weight?: number;
} | null;

/** 决策记录（裁剪后：decision_id→id、timestamp→createdAt，其余字段透传）。 */
export type OntoDecision = {
  id: string;
  category?: string;
  title?: string;
  createdAt?: string;
  [k: string]: unknown;
};
