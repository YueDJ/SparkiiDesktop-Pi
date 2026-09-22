import { ConnectorError } from '../types.js';
import { mapDatasets, mapRetrieval } from '../sparkiirag/map.js';
import type { RetrievalResult, SparkiiRagDataset, SparkiiRagRetrieveInput } from '../sparkiirag/types.js';
import type { SparkiiOntoInfo } from './types.js';

export type { SparkiiOntoInfo, SparkiiOntoCapabilities, SparkiiOntoDataset, SparkiiOntoRetrieval } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DATASET_PAGE_SIZE = 100;
const MAX_DATASET_PAGES = 100;

export const ONTO_PRODUCT = 'SparkiiOnto';
export const ONTO_API_VERSION = 'v1';
export const ONTO_DEPLOYMENT_PROFILE = 'single-instance';

/**
 * `/retrieval` 的 `vector_similarity_weight` 在 Onto 上**必填但被服务端忽略**
 * （服务端 `extra="forbid"` + 无默认值 ⇒ 省略即 422，而 422 会被误读成"服务不支持"）。
 * 因此固定传常量，不暴露给调用方。
 */
export const ONTO_VECTOR_SIMILARITY_WEIGHT = 0.3;

export type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; reason: string };

/**
 * 校验并归一化 Onto 服务地址：允许内网 `http://` 与端口，拒绝 userinfo / query / hash。
 * 读配置路径**不要**直接用它抛错（那要求调用方先捕获）；它只返回判定结果。
 */
export function normalizeOntoBaseUrl(raw: string): BaseUrlCheck {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: '地址为空' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: '地址不是合法的 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `仅支持 http/https（收到 ${url.protocol.replace(':', '') || '未知'}）` };
  }
  if (!url.hostname) return { ok: false, reason: '地址缺少主机名' };
  if (url.username || url.password) return { ok: false, reason: '地址不得包含用户名或密码' };
  if (url.search) return { ok: false, reason: '地址不得包含查询串' };
  if (url.hash) return { ok: false, reason: '地址不得包含片段标识' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.origin}${path}` };
}

/**
 * 带 HTTP 状态码的连接器错误：Onto 的 401（凭据失效）与 403（权限不足）在
 * `ConnectorError.code` 上都归 `CONNECTOR_DENIED`，探活需要区分二者，故保留 `status`。
 */
export class SparkiiOntoHttpError extends ConnectorError {
  constructor(
    public readonly status: number,
    code: ConnectorError['code'],
    message: string,
  ) {
    super(code, message);
    this.name = 'SparkiiOntoHttpError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorDetail(payload: unknown): string {
  const rec = asRecord(payload);
  for (const key of ['message', 'detail'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return '';
}

function withDetail(prefix: string, payload: unknown): string {
  const detail = errorDetail(payload);
  return detail ? `${prefix}：${detail}` : prefix;
}

function asInfo(raw: unknown): SparkiiOntoInfo {
  const rec = asRecord(raw);
  const retrieval = asRecord(rec.retrieval);
  const capabilities: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(asRecord(rec.capabilities))) {
    if (typeof value === 'boolean') capabilities[key] = value;
  }
  return {
    product: typeof rec.product === 'string' ? rec.product : '',
    version: typeof rec.version === 'string' ? rec.version : '',
    api_version: typeof rec.api_version === 'string' ? rec.api_version : '',
    deployment_profile: typeof rec.deployment_profile === 'string' ? rec.deployment_profile : '',
    retrieval: {
      backend: typeof retrieval.backend === 'string' ? retrieval.backend : '',
      semantic_embeddings: retrieval.semantic_embeddings === true,
    },
    capabilities,
  };
}

/**
 * SparkiiOnto 产品服务客户端（自带传输）。
 *
 * **不继承 `SparkiiRagClient`**：后者的传输方法全是 `private`，且把所有非零 `code`
 * 一律映射成 `CONNECTOR_DENIED`，无法满足 Onto 的 401/403/404/422 区分。
 * 载荷映射仍然复用 `sparkiirag/map.ts`（兼容载荷字段与其完全一致）。
 */
export class SparkiiOntoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMsValue: number;
  private infoPromise: Promise<SparkiiOntoInfo> | null = null;

  constructor(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    const parsed = normalizeOntoBaseUrl(opts.baseUrl);
    if (!parsed.ok) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', `SparkiiOnto 地址无效：${parsed.reason}`);
    }
    this.baseUrl = parsed.baseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMsValue = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 归一化后的服务地址（无尾斜杠）。 */
  get address(): string {
    return this.baseUrl;
  }

  /** 默认单次调用超时（子类可用 budgetMs 覆盖单次预算）。 */
  protected get timeoutMs(): number {
    return this.timeoutMsValue;
  }

  /**
   * `/api/v1/system/healthz`：不需要凭据；503 且 `status:"nok"` 视为不健康。
   *
   * 例外：401/403 **不是**"服务不健康"而是凭据/权限问题（例如 healthz 前面挂了要求
   * 鉴权的反向代理），按 HTTP 状态码抛 `SparkiiOntoHttpError`，探活侧即可分类成
   * unauthorized/forbidden。503 与其它响应（含非 JSON）仍按"不健康"处理。
   */
  async health(): Promise<{ ok: boolean }> {
    const res = await this.send(`${this.baseUrl}/api/v1/system/healthz`, { method: 'GET' });
    if (res.status === 401 || res.status === 403) {
      throw this.httpError(res.status, await this.bodyIfJson(res));
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return { ok: res.ok };
    const payload = await this.parseJson(res);
    const record = asRecord(payload);
    if (typeof record.status === 'string') return { ok: res.ok && record.status === 'ok' };
    if (record.code != null) return { ok: res.ok && Number(record.code) === 0 };
    return { ok: res.ok };
  }

  /** `/api/v1/info`：一次性能力协商并缓存；不匹配的 product/api_version/deployment_profile/capabilities 视为不支持。 */
  async info(): Promise<SparkiiOntoInfo> {
    if (!this.infoPromise) {
      this.infoPromise = this.negotiate().catch((error: unknown) => {
        this.infoPromise = null;
        throw error;
      });
    }
    return this.infoPromise;
  }

  async listDatasets(): Promise<SparkiiRagDataset[]> {
    await this.info();
    const out: SparkiiRagDataset[] = [];
    for (let page = 1; page <= MAX_DATASET_PAGES; page++) {
      const payload = await this.requestJson(
        `${this.baseUrl}/api/v1/datasets?page=${page}&page_size=${DATASET_PAGE_SIZE}`,
        { method: 'GET', headers: this.authHeaders() },
      );
      const rows = mapDatasets(asRecord(payload).data);
      out.push(...rows);
      if (rows.length < DATASET_PAGE_SIZE) break;
    }
    return out;
  }

  async retrieve(input: SparkiiRagRetrieveInput): Promise<RetrievalResult> {
    await this.info();
    const similarityThreshold = input.similarityThreshold ?? 0.2;
    const payload = await this.requestJson(`${this.baseUrl}/api/v1/retrieval`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.question,
        dataset_ids: input.datasetIds,
        similarity_threshold: similarityThreshold,
        vector_similarity_weight: ONTO_VECTOR_SIMILARITY_WEIGHT,
        page_size: Math.min(Math.max(input.topK ?? 6, 1), 20),
      }),
    });
    return mapRetrieval(asRecord(payload).data, similarityThreshold);
  }

  async fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array> {
    await this.info();
    const res = await this.send(
      `${this.baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'GET', headers: this.authHeaders() },
    );
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const payload = await this.parseJson(res);
      if (!res.ok) throw this.httpError(res.status, payload);
      const code = asRecord(payload).code;
      if (code != null && Number(code) !== 0) throw this.httpError(Number(code), payload);
      throw new ConnectorError('CONNECTOR_IO', '原文下载返回了 JSON 而不是文件字节');
    }
    if (!res.ok) throw this.httpError(res.status, undefined);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async negotiate(): Promise<SparkiiOntoInfo> {
    const payload = await this.requestJson(`${this.baseUrl}/api/v1/info`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    const info = asInfo(payload);
    if (info.product !== ONTO_PRODUCT) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', `该地址不是 ${ONTO_PRODUCT} 产品服务（product=${info.product || '未知'}）`);
    }
    if (info.api_version !== ONTO_API_VERSION) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', `SparkiiOnto API 版本不匹配（api_version=${info.api_version || '未知'}，需要 ${ONTO_API_VERSION}）`);
    }
    if (info.deployment_profile !== ONTO_DEPLOYMENT_PROFILE) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', `SparkiiOnto 部署档位不匹配（deployment_profile=${info.deployment_profile || '未知'}）`);
    }
    if (info.capabilities.datasets !== true) {
      throw new ConnectorError('CONNECTOR_UNSUPPORTED', 'SparkiiOnto 未声明 datasets 能力，无法列出知识域');
    }
    return info;
  }

  protected authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  protected async requestJson(url: string, init: RequestInit, budgetMs?: number): Promise<unknown> {
    const res = await this.send(url, init, budgetMs);
    const payload = await this.parseJson(res);
    if (!res.ok) throw this.httpError(res.status, payload);
    const code = asRecord(payload).code;
    if (typeof code === 'number' && code !== 0) throw this.httpError(code, payload);
    return payload;
  }

  /** 只按 HTTP 状态码分类（Starlette 路由级错误不经产品 handler，响应体形状不可依赖）。 */
  protected httpError(status: number, payload: unknown): ConnectorError {
    if (status === 401) {
      return new SparkiiOntoHttpError(401, 'CONNECTOR_DENIED', withDetail('SparkiiOnto 凭据无效或已过期（HTTP 401）', payload));
    }
    if (status === 403) {
      return new SparkiiOntoHttpError(403, 'CONNECTOR_DENIED', withDetail('SparkiiOnto 凭据权限不足（HTTP 403）', payload));
    }
    if (status === 404 || status === 405) {
      return new SparkiiOntoHttpError(status, 'CONNECTOR_UNSUPPORTED', withDetail(`SparkiiOnto 端点或方法不存在（HTTP ${status}）`, payload));
    }
    if (status === 422) {
      return new SparkiiOntoHttpError(422, 'CONNECTOR_UNSUPPORTED', withDetail('SparkiiOnto 请求参数不被该服务接受（HTTP 422）', payload));
    }
    if (status === 429) {
      return new SparkiiOntoHttpError(429, 'CONNECTOR_IO', withDetail('SparkiiOnto 请求过于频繁（HTTP 429）', payload));
    }
    if (status >= 500) {
      return new SparkiiOntoHttpError(status, 'CONNECTOR_IO', withDetail(`SparkiiOnto 服务暂时不可用（HTTP ${status}）`, payload));
    }
    return new SparkiiOntoHttpError(status, 'CONNECTOR_IO', withDetail(`SparkiiOnto 请求失败（HTTP ${status}）`, payload));
  }

  protected async send(url: string, init: RequestInit, budgetMs?: number): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(budgetMs ?? this.timeoutMs) });
    } catch (error) {
      throw new ConnectorError('CONNECTOR_IO', error instanceof Error ? error.message : String(error));
    }
  }

  protected async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (error) {
      throw new ConnectorError('CONNECTOR_IO', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 宽容解析：只用于给 401/403 补全文案。响应体形状不可依赖（可能是代理/网关生成的，
   * 也可能根本没有 JSON 正文），读不到就只按状态码给文案，绝不因此改变错误分类。
   */
  protected async bodyIfJson(res: Response): Promise<unknown> {
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}
