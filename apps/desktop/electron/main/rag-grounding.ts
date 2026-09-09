export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。';
export const KNOWLEDGE_TURN = 'knowledge_turn';

export type GroundingTurn = {
  searchCalled: boolean;
  miss: boolean;
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asDocument(item: unknown): { documentId: string; documentName: string; datasetId: string } {
  const rec = asRecord(item);
  return {
    documentId: String(rec.documentId ?? ''),
    documentName: String(rec.documentName ?? ''),
    datasetId: String(rec.datasetId ?? ''),
  };
}

export function resetTurn(): GroundingTurn {
  return { searchCalled: false, miss: false, documents: [] };
}

export function markSearchResult(
  turn: GroundingTurn,
  result: { chunks: unknown[]; documents?: GroundingTurn['documents'] },
): GroundingTurn {
  const chunks = Array.isArray(result.chunks) ? result.chunks : [];
  const miss = chunks.length === 0;
  const datasetByDoc = new Map<string, string>();
  for (const item of chunks) {
    const rec = asRecord(item);
    const documentId = String(rec.documentId ?? '');
    const datasetId = String(rec.datasetId ?? '');
    if (documentId && datasetId && !datasetByDoc.has(documentId)) datasetByDoc.set(documentId, datasetId);
  }
  let documents = Array.isArray(result.documents) ? result.documents.map(asDocument) : [];
  documents = documents.map((doc) => ({
    ...doc,
    datasetId: doc.datasetId || datasetByDoc.get(doc.documentId) || '',
  }));
  if (!documents.length && !miss) {
    const seen = new Set<string>();
    documents = chunks.flatMap((item) => {
      const rec = asRecord(item);
      const documentId = String(rec.documentId ?? '');
      if (!documentId || seen.has(documentId)) return [];
      seen.add(documentId);
      return [{
        documentId,
        documentName: String(rec.documentName ?? ''),
        datasetId: String(rec.datasetId ?? ''),
      }];
    });
  }
  return { searchCalled: true, miss, documents };
}

export function shouldAbortGeneration(turn: GroundingTurn): boolean {
  return turn.searchCalled && turn.miss;
}

export function knowledgeTurnPayload(turn: GroundingTurn): {
  refused: boolean;
  text?: string;
  documents: GroundingTurn['documents'];
} {
  if (turn.miss) {
    return { refused: true, text: RAG_REFUSE_TEXT, documents: [] };
  }
  return { refused: false, documents: turn.documents };
}

export function isVisibleAssistantEnd(message: unknown): boolean {
  const rec = asRecord(message);
  const msg = rec.message && typeof rec.message === 'object' ? asRecord(rec.message) : rec;
  const content = msg.content;
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  const text = content.map((part) => {
    const partRec = asRecord(part);
    if (partRec.type === 'text' || typeof partRec.text === 'string') return String(partRec.text ?? '');
    return '';
  }).join('');
  return text.trim() !== '';
}
