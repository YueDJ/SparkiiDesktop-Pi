import type { ProviderApi } from './provider-catalog.js';

export type ProbeReason = 'ok' | 'unreachable' | 'unauthorized' | 'unsupported' | 'invalid_response';

export interface ProbeResult {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  models?: string[];
  reason: ProbeReason;
  error?: string;
}

export interface ProbeTarget {
  providerId: string;
  baseUrl: string;
  api?: ProviderApi;
  apiKey?: string | null;
}

type FetchLike = typeof fetch;

const ANTHROPIC_VERSION = '2023-06-01';

function buildAttempts(target: ProbeTarget): Array<{ url: string; headers: Record<string, string> }> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const isAnthropic = target.api === 'anthropic-messages' || target.providerId === 'anthropic';

  if (isAnthropic) {
    return [
      {
        url: `${base}/v1/models`,
        headers: {
          'anthropic-version': ANTHROPIC_VERSION,
          ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
        },
      },
    ];
  }

  // OpenAI-compatible endpoints expose /models at the root or under /v1.
  const headers: Record<string, string> = target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {};
  return [`${base}/models`, `${base}/v1/models`].map((url) => ({ url, headers }));
}

function parseModels(text: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;

  const data = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const ids = data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => item.id ?? item.name)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '未知错误');
}

/**
 * Lightweight, token-free connectivity/key check against the provider's
 * model-listing endpoint (GET /models). A 2xx response proves both network
 * reachability and credential validity, and yields the live model ids.
 */
export async function probeProviderModels(
  target: ProbeTarget,
  fetchFn: FetchLike = fetch,
  timeoutMs = 12_000,
): Promise<ProbeResult> {
  const started = Date.now();
  for (const { url, headers } of buildAttempts(target)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      const latencyMs = Date.now() - started;

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          httpStatus: res.status,
          latencyMs,
          reason: 'unauthorized',
          error: `API Key 无效或未授权（${res.status}）`,
        };
      }
      if (res.ok) {
        const models = parseModels(await res.text());
        return models.length > 0
          ? { ok: true, httpStatus: res.status, latencyMs, models, reason: 'ok' }
          : { ok: true, httpStatus: res.status, latencyMs, models: [], reason: 'ok' };
      }
      if (res.status === 404 || res.status === 405) {
        continue;
      }
      return {
        ok: false,
        httpStatus: res.status,
        latencyMs,
        reason: 'unreachable',
        error: `服务商返回异常状态（${res.status}）`,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (controller.signal.aborted) {
        return { ok: false, latencyMs, reason: 'unreachable', error: '连接超时' };
      }
      return { ok: false, latencyMs, reason: 'unreachable', error: errorText(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    latencyMs: Date.now() - started,
    reason: 'unsupported',
    error: '该服务商未提供模型列表端点（/models）',
  };
}
