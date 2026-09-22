export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。';
export const KNOWLEDGE_TURN = 'knowledge_turn';

/**
 * 出处归属：远端知识后端 id。**可选字段**，缺省语义 = `sparkiirag`
 * （历史 JSONL 里没有这个字段，读回时行为不变）。
 */
export type KnowledgeSourceBackend = 'sparkiirag' | 'sparkiionto';

export type KnowledgeCitation = {
  index: number;
  documentId: string;
  documentName: string;
  datasetId: string;
  snippet: string;
  backend?: KnowledgeSourceBackend;
};

export type GroundingDocument = {
  documentId: string;
  documentName: string;
  datasetId: string;
  backend?: KnowledgeSourceBackend;
};

export type GroundingTurn = {
  searchCalled: boolean;
  miss: boolean;
  sealed: boolean;
  documents: GroundingDocument[];
  citations: KnowledgeCitation[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 只认两个知识后端 id；缺省（含历史数据）不写字段，由调用方按 `sparkiirag` 解释。 */
function backendTag(item: Record<string, unknown>): { backend?: KnowledgeSourceBackend } {
  const value = item.backend;
  return value === 'sparkiirag' || value === 'sparkiionto' ? { backend: value } : {};
}

function asDocument(item: unknown): GroundingDocument {
  const rec = asRecord(item);
  return {
    documentId: String(rec.documentId ?? ''),
    documentName: String(rec.documentName ?? ''),
    datasetId: String(rec.datasetId ?? ''),
    ...backendTag(rec),
  };
}

function snippetFromChunk(item: unknown): string {
  const rec = asRecord(item);
  return String(rec.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function citationsFromChunks(chunks: unknown[], startIndex: number): KnowledgeCitation[] {
  return chunks.map((item, i) => {
    const rec = asRecord(item);
    return {
      index: startIndex + i,
      documentId: String(rec.documentId ?? ''),
      documentName: String(rec.documentName ?? ''),
      datasetId: String(rec.datasetId ?? ''),
      snippet: snippetFromChunk(item),
      ...backendTag(rec),
    };
  });
}

export function resetTurn(): GroundingTurn {
  return { searchCalled: false, miss: false, sealed: false, documents: [], citations: [] };
}

export function sealTurn(turn: GroundingTurn): GroundingTurn {
  return { ...turn, sealed: true };
}

export function markSearchResult(
  turn: GroundingTurn,
  result: { chunks: unknown[]; documents?: GroundingTurn['documents'] },
): GroundingTurn {
  const base = turn.sealed ? resetTurn() : turn;
  const chunks = Array.isArray(result.chunks) ? result.chunks : [];
  const thisHit = chunks.length > 0;
  const miss = base.searchCalled ? (base.miss && !thisHit) : !thisHit;
  const datasetByDoc = new Map<string, string>();
  for (const item of chunks) {
    const rec = asRecord(item);
    const documentId = String(rec.documentId ?? '');
    const datasetId = String(rec.datasetId ?? '');
    if (documentId && datasetId && !datasetByDoc.has(documentId)) datasetByDoc.set(documentId, datasetId);
  }
  let incoming = Array.isArray(result.documents) ? result.documents.map(asDocument) : [];
  incoming = incoming.map((doc) => ({
    ...doc,
    datasetId: doc.datasetId || datasetByDoc.get(doc.documentId) || '',
  }));
  if (!incoming.length && thisHit) {
    const seen = new Set<string>();
    incoming = chunks.flatMap((item) => {
      const rec = asRecord(item);
      const documentId = String(rec.documentId ?? '');
      if (!documentId || seen.has(documentId)) return [];
      seen.add(documentId);
      return [{
        documentId,
        documentName: String(rec.documentName ?? ''),
        datasetId: String(rec.datasetId ?? ''),
        ...backendTag(rec),
      }];
    });
  }
  const merged = new Map<string, GroundingDocument>();
  for (const doc of [...base.documents, ...incoming]) {
    if (!doc.documentId) continue;
    const prev = merged.get(doc.documentId);
    // 按 documentId 合并：backend 必须显式带上，否则会被合并丢成"默认后端"。
    const backend = doc.backend ?? prev?.backend;
    merged.set(doc.documentId, {
      documentId: doc.documentId,
      documentName: doc.documentName || prev?.documentName || '',
      datasetId: doc.datasetId || prev?.datasetId || '',
      ...(backend ? { backend } : {}),
    });
  }
  const citations = [...base.citations, ...citationsFromChunks(chunks, 1)].map((c, i) => ({
    ...c,
    index: i + 1,
  }));
  return { searchCalled: true, miss, sealed: false, documents: [...merged.values()], citations };
}

export function shouldAbortGeneration(turn: GroundingTurn): boolean {
  return turn.searchCalled && turn.miss;
}

export function knowledgeTurnPayload(turn: GroundingTurn): {
  refused: boolean;
  text?: string;
  documents: GroundingTurn['documents'];
  citations: KnowledgeCitation[];
} {
  if (turn.miss) {
    return { refused: true, text: RAG_REFUSE_TEXT, documents: [], citations: [] };
  }
  return { refused: false, documents: turn.documents, citations: turn.citations };
}

export function isVisibleAssistantEnd(message: unknown): boolean {
  const rec = asRecord(message);
  const msg = rec.message && typeof rec.message === 'object' ? asRecord(rec.message) : rec;
  const role = typeof msg.role === 'string' ? msg.role : 'assistant';
  if (role !== 'assistant') return false;
  const content = msg.content;
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return typeof rec.text === 'string' && rec.text.trim() !== '';
  const text = content.map((part) => {
    const partRec = asRecord(part);
    return partRec.type === 'text' ? String(partRec.text ?? '') : '';
  }).join('');
  return text.trim() !== '';
}
