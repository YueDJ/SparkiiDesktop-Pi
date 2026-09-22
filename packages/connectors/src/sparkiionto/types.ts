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
