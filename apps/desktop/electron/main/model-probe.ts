export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  models?: string[];
  error?: string;
}

const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/api\/tags$/.test(trimmed) || /\/models$/.test(trimmed)) return trimmed;
  return `${trimmed}/models`;
}

export async function listModels(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
  try {
    const start = Date.now();
    const res = await fetchWithTimeout(endpoint(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, TIMEOUT_MS);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    const models = Array.isArray(body.data)
      ? (body.data as Array<Record<string, unknown>>).map((m) => String(m.id ?? '')).filter(Boolean)
      : Array.isArray(body.models)
        ? (body.models as Array<Record<string, unknown>>).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean)
        : [];
    return { ok: true, latencyMs: Date.now() - start, models };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function testModel(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
  try {
    const start = Date.now();
    const res = await fetchWithTimeout(endpoint(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, TIMEOUT_MS);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
