import { ConnectorError } from '../types.js';
import { mapDatasets, mapRetrieval } from './map.js';
import type { SparkiiRagDataset, SparkiiRagRetrieveInput, RetrievalResult } from './types.js';

export type { SparkiiRagRetrieveInput, RetrievalChunk, RetrievalResult, SparkiiRagDataset } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DATASET_PAGE_SIZE = 100;
const MAX_DATASET_PAGES = 100;

export class SparkiiRagClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await this.send(`${this.baseUrl}/api/v1/system/healthz`, { method: 'GET' });
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return { ok: res.ok };
    const payload = await this.parseJson(res);
    const record = payload !== null && typeof payload === 'object'
      ? payload as { status?: unknown; code?: unknown }
      : {};
    if (typeof record.status === 'string') return { ok: res.ok && record.status === 'ok' };
    if (record.code != null) return { ok: res.ok && Number(record.code) === 0 };
    return { ok: res.ok };
  }

  async listDatasets(): Promise<SparkiiRagDataset[]> {
    const out: SparkiiRagDataset[] = [];
    for (let page = 1; page <= MAX_DATASET_PAGES; page++) {
      const payload = await this.requestJson(
        `${this.baseUrl}/api/v1/datasets?page=${page}&page_size=${DATASET_PAGE_SIZE}`,
        { method: 'GET', headers: this.authHeaders() },
      );
      const rows = mapDatasets((payload as { data?: unknown }).data);
      out.push(...rows);
      if (rows.length < DATASET_PAGE_SIZE) break;
    }
    return out;
  }

  async retrieve(input: SparkiiRagRetrieveInput): Promise<RetrievalResult> {
    const similarityThreshold = input.similarityThreshold ?? 0.2;
    const payload = await this.requestJson(`${this.baseUrl}/api/v1/retrieval`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.question,
        dataset_ids: input.datasetIds,
        similarity_threshold: similarityThreshold,
        vector_similarity_weight: input.vectorSimilarityWeight ?? 0.3,
        page_size: Math.min(Math.max(input.topK ?? 6, 1), 20),
      }),
    });
    return mapRetrieval((payload as { data?: unknown }).data, similarityThreshold);
  }

  async fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'GET', headers: this.authHeaders() },
    );
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const payload = await this.parseJson(res);
      this.assertOk(payload);
      throw new ConnectorError('CONNECTOR_IO', 'document fetch returned JSON instead of file bytes');
    }
    if (!res.ok) {
      throw new ConnectorError('CONNECTOR_IO', `document fetch failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.send(url, init);
    const payload = await this.parseJson(res);
    this.assertOk(payload);
    if (!res.ok) {
      throw new ConnectorError('CONNECTOR_IO', `HTTP ${res.status}`);
    }
    return payload;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ConnectorError('CONNECTOR_IO', error instanceof Error ? error.message : String(error));
    }
  }

  private async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (error) {
      throw new ConnectorError('CONNECTOR_IO', error instanceof Error ? error.message : String(error));
    }
  }

  private assertOk(payload: unknown): void {
    const record = payload !== null && typeof payload === 'object' ? payload as { code?: unknown; message?: unknown } : {};
    if (record.code != null && Number(record.code) !== 0) {
      throw new ConnectorError('CONNECTOR_DENIED', String(record.message ?? 'SparkiiRAG request failed'));
    }
  }
}
