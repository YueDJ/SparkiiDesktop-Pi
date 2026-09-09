import { ChatMessage, Markdown } from '@sparkii/ui';
import type { CustomSessionEntry } from './contract.js';

export const KNOWLEDGE_TURN = 'knowledge_turn';
export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。';

export type KnowledgeCitation = {
  index: number;
  documentId: string;
  documentName: string;
  datasetId: string;
  snippet: string;
};

export type KnowledgeTurnData = {
  refused?: boolean;
  text?: string;
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>;
  citations: KnowledgeCitation[];
};

function asDoc(item: unknown): KnowledgeTurnData['documents'][number] | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  return {
    documentId: String(rec.documentId ?? ''),
    documentName: String(rec.documentName ?? ''),
    datasetId: String(rec.datasetId ?? ''),
  };
}

function asCitation(item: unknown, fallbackIndex: number): KnowledgeCitation | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const documentId = String(rec.documentId ?? '');
  const documentName = String(rec.documentName ?? '');
  if (!documentId && !documentName) return null;
  const index = typeof rec.index === 'number' && rec.index > 0 ? rec.index : fallbackIndex;
  return {
    index,
    documentId,
    documentName,
    datasetId: String(rec.datasetId ?? ''),
    snippet: String(rec.snippet ?? ''),
  };
}

export function parseKnowledgeTurn(entry: CustomSessionEntry): KnowledgeTurnData | null {
  if (entry.customType !== KNOWLEDGE_TURN) return null;
  const documents = Array.isArray(entry.data.documents)
    ? entry.data.documents.flatMap((item) => {
      const doc = asDoc(item);
      return doc ? [doc] : [];
    })
    : [];
  const citations = Array.isArray(entry.data.citations)
    ? entry.data.citations.flatMap((item, i) => {
      const citation = asCitation(item, i + 1);
      return citation ? [citation] : [];
    })
    : [];
  return {
    refused: entry.data.refused === true,
    text: typeof entry.data.text === 'string' ? entry.data.text : undefined,
    documents,
    citations,
  };
}

export function KnowledgeAnswerBubble(props: {
  text: string;
  thinking?: string;
  streaming?: boolean;
  documents: KnowledgeTurnData['documents'];
  citations?: KnowledgeCitation[];
  onOpenDocument?(doc: KnowledgeTurnData['documents'][number]): void;
}) {
  const { text, thinking, streaming, documents, citations, onOpenDocument } = props;
  const sources = citations && citations.length > 0
    ? citations.map((c) => ({
      key: `${c.index}:${c.datasetId}:${c.documentId}`,
      label: `[${c.index}] ${c.documentName}`,
      title: c.snippet || undefined,
      doc: { documentId: c.documentId, documentName: c.documentName, datasetId: c.datasetId },
    }))
    : documents.map((doc) => ({
      key: `${doc.datasetId}:${doc.documentId}`,
      label: doc.documentName,
      title: undefined as string | undefined,
      doc: doc,
    }));
  return (
    <ChatMessage role="assistant" text={text} thinking={thinking} streaming={streaming}>
      <Markdown text={text} />
      {sources.length > 0 ? (
        <>
          <hr className="knowledge-source-divider" />
          <div className="knowledge-sources">
            {sources.map((source) => (
              <button
                key={source.key}
                type="button"
                className="knowledge-source-btn"
                data-testid="knowledge-source"
                title={source.title}
                onClick={() => onOpenDocument?.(source.doc)}
              >
                {source.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </ChatMessage>
  );
}
