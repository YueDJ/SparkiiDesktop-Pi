import { ChatMessage, Markdown } from '@sparkii/ui';
import type { CustomSessionEntry } from './contract.js';

export const KNOWLEDGE_TURN = 'knowledge_turn';
export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。';

export type KnowledgeTurnData = {
  refused?: boolean;
  text?: string;
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>;
};

export function parseKnowledgeTurn(entry: CustomSessionEntry): KnowledgeTurnData | null {
  if (entry.customType !== KNOWLEDGE_TURN) return null;
  const documents = Array.isArray(entry.data.documents)
    ? entry.data.documents.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as Record<string, unknown>;
      return [{
        documentId: String(rec.documentId ?? ''),
        documentName: String(rec.documentName ?? ''),
        datasetId: String(rec.datasetId ?? ''),
      }];
    })
    : [];
  return {
    refused: entry.data.refused === true,
    text: typeof entry.data.text === 'string' ? entry.data.text : undefined,
    documents,
  };
}

export function KnowledgeAnswerBubble(props: {
  text: string;
  thinking?: string;
  streaming?: boolean;
  documents: KnowledgeTurnData['documents'];
  onOpenDocument?(doc: KnowledgeTurnData['documents'][number]): void;
}) {
  const { text, thinking, streaming, documents, onOpenDocument } = props;
  return (
    <ChatMessage role="assistant" text={text} thinking={thinking} streaming={streaming}>
      <Markdown text={text} />
      {documents.length > 0 ? (
        <>
          <hr className="knowledge-source-divider" />
          <div className="knowledge-sources">
            {documents.map((doc) => (
              <button
                key={`${doc.datasetId}:${doc.documentId}`}
                type="button"
                className="knowledge-source-btn"
                data-testid="knowledge-source"
                onClick={() => onOpenDocument?.(doc)}
              >
                {doc.documentName}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </ChatMessage>
  );
}
