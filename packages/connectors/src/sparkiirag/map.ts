import type { RetrievalResult, SparkiiRagDataset } from './types.js';

export function firstNonEmptyId(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item ?? '').trim();
      if (text) return text;
    }
    return '';
  }
  return String(value ?? '').trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function mapRetrieval(raw: unknown, similarityThreshold = 0.2): RetrievalResult {
  const data = asRecord(raw);
  const chunksRaw = Array.isArray(data.chunks) ? data.chunks : [];
  const chunks = chunksRaw.flatMap((item) => {
    const chunk = asRecord(item);
    const similarity = Number(chunk.similarity ?? 0);
    if (!Number.isFinite(similarity) || similarity < similarityThreshold) return [];
    return [{
      id: String(chunk.id ?? ''),
      content: String(chunk.content ?? ''),
      documentId: String(chunk.document_id ?? ''),
      documentName: String(chunk.document_keyword ?? ''),
      datasetId: firstNonEmptyId(chunk.dataset_id),
      similarity,
      ...(chunk.term_similarity == null ? {} : { termSimilarity: Number(chunk.term_similarity) }),
      ...(chunk.vector_similarity == null ? {} : { vectorSimilarity: Number(chunk.vector_similarity) }),
      ...(chunk.positions == null ? {} : { positions: chunk.positions }),
    }];
  });

  const aggs = data.doc_aggs;
  const documents = Array.isArray(aggs)
    ? aggs.map((item) => {
      const row = asRecord(item);
      return {
        documentId: String(row.doc_id ?? ''),
        documentName: String(row.doc_name ?? ''),
        chunkCount: Number(row.count ?? 0),
      };
    })
    : [];

  return { chunks, documents };
}

export function mapDatasets(raw: unknown): SparkiiRagDataset[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((item) => {
    const row = asRecord(item);
    return { id: String(row.id ?? ''), name: String(row.name ?? '') };
  });
}
