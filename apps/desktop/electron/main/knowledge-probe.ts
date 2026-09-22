import {
  ConnectorError,
  SparkiiOntoClient,
  SparkiiOntoHttpError,
  SparkiiRagClient,
  normalizeOntoBaseUrl,
  type SparkiiOntoInfo,
} from '@sparkii/connectors';
import type { KnowledgeBackendId } from './knowledge-settings.js';

export type KnowledgeProbeReason =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'unsupported'
  | 'unhealthy'
  | 'invalid_config';

/** 探活可带入未保存的临时值（设置页先"测试连接"后"保存"）。 */
export type KnowledgeProbeOverride = { baseUrl?: string; apiKey?: string | null };

export type KnowledgeProbeError = { code: string; message: string; reason: KnowledgeProbeReason };

export type KnowledgeProbeResult = {
  ok: boolean;
  backend: KnowledgeBackendId;
  /** 探活实际使用的（归一化后）地址。 */
  baseUrl?: string;
  /** 仅 Onto：`/api/v1/info` 的能力协商结果。 */
  info?: SparkiiOntoInfo;
  datasets?: Array<{ id: string; name: string }>;
  error?: KnowledgeProbeError;
};

export type KnowledgeProbeOptions = {
  baseUrl: string;
  credential: string | null;
  override?: KnowledgeProbeOverride;
  /** 测试注入点；生产走全局 fetch。 */
  fetch?: typeof fetch;
};

function fail(
  backend: KnowledgeBackendId,
  baseUrl: string | undefined,
  code: string,
  message: string,
  reason: KnowledgeProbeReason,
): KnowledgeProbeResult {
  return { ok: false, backend, ...(baseUrl ? { baseUrl } : {}), error: { code, message, reason } };
}

export function invalidBackendProbeResult(
  backend: unknown,
): { ok: false; backend: KnowledgeBackendId; error: KnowledgeProbeError } {
  return {
    ok: false,
    // renderer 侧 `KnowledgeProbeResult.backend` 是必填（`electron/preload/api-types.ts`）；
    // 未知后端不是合法 id，原样回带便于诊断（当前 UI 不读这个字段）。
    backend: backend as KnowledgeBackendId,
    error: {
      code: 'CONNECTOR_UNSUPPORTED',
      message: `未知知识后端：${String(backend ?? '') || '（空）'}`,
      reason: 'invalid_config',
    },
  };
}

function reasonForStatus(status: number): KnowledgeProbeReason {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 405 || status === 422) return 'unsupported';
  return 'unreachable';
}

function fromError(error: unknown, backend: KnowledgeBackendId, baseUrl: string): KnowledgeProbeResult {
  if (error instanceof SparkiiOntoHttpError) {
    return fail(backend, baseUrl, error.code, error.message, reasonForStatus(error.status));
  }
  if (error instanceof ConnectorError) {
    const reason: KnowledgeProbeReason = error.code === 'CONNECTOR_DENIED'
      ? 'unauthorized'
      : error.code === 'CONNECTOR_UNSUPPORTED'
        ? 'unsupported'
        : 'unreachable';
    return fail(backend, baseUrl, error.code, error.message, reason);
  }
  return fail(backend, baseUrl, 'CONNECTOR_IO', error instanceof Error ? error.message : String(error), 'unreachable');
}

async function probeSparkiiRag(
  baseUrl: string,
  credential: string | null,
  fetchImpl?: typeof fetch,
): Promise<KnowledgeProbeResult> {
  if (!credential) return fail('sparkiirag', baseUrl, 'CONNECTOR_DENIED', '未配置 API Key', 'invalid_config');
  try {
    const client = new SparkiiRagClient({ baseUrl, apiKey: credential, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const health = await client.health();
    if (!health.ok) return fail('sparkiirag', baseUrl, 'CONNECTOR_IO', 'SparkiiRAG 不可达', 'unreachable');
    const datasets = await client.listDatasets();
    return { ok: true, backend: 'sparkiirag', baseUrl, datasets };
  } catch (error) {
    return fromError(error, 'sparkiirag', baseUrl);
  }
}

async function probeSparkiiOnto(
  rawBaseUrl: string,
  credential: string | null,
  fetchImpl?: typeof fetch,
): Promise<KnowledgeProbeResult> {
  const check = normalizeOntoBaseUrl(rawBaseUrl);
  if (!check.ok) {
    return fail('sparkiionto', undefined, 'CONNECTOR_UNSUPPORTED', `知识库地址无效：${check.reason}`, 'invalid_config');
  }
  const baseUrl = check.baseUrl;
  if (!credential) return fail('sparkiionto', baseUrl, 'CONNECTOR_DENIED', '未配置 API Token', 'invalid_config');
  const client = new SparkiiOntoClient({ baseUrl, apiKey: credential, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  try {
    // 顺序固定：healthz（无需凭据）→ info（能力协商）→ datasets（可见域）。
    const health = await client.health();
    if (!health.ok) return fail('sparkiionto', baseUrl, 'CONNECTOR_IO', 'SparkiiOnto 服务不健康', 'unhealthy');
    const info = await client.info();
    const datasets = await client.listDatasets();
    return { ok: true, backend: 'sparkiionto', baseUrl, info, datasets };
  } catch (error) {
    return fromError(error, 'sparkiionto', baseUrl);
  }
}

/**
 * 探活：`healthz → info → datasets`（RAG 没有 `/info`，只有 `healthz → datasets`）。
 * `override` 中的非空值优先于已存配置（设置页未保存的临时地址/凭据）。
 */
export async function probeKnowledgeBackend(
  backend: KnowledgeBackendId,
  opts: KnowledgeProbeOptions,
): Promise<KnowledgeProbeResult> {
  const override = opts.override ?? {};
  const baseUrl = typeof override.baseUrl === 'string' && override.baseUrl.trim()
    ? override.baseUrl.trim()
    : opts.baseUrl;
  const credential = typeof override.apiKey === 'string' && override.apiKey.trim()
    ? override.apiKey.trim()
    : opts.credential;
  return backend === 'sparkiirag'
    ? probeSparkiiRag(baseUrl, credential, opts.fetch)
    : probeSparkiiOnto(baseUrl, credential, opts.fetch);
}
