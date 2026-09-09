import { useState } from 'react';
import { ChatMessage, Markdown } from '@sparkii/ui';
import { StandardChatSurface, type StandardChatProps } from '../../../src/surface/standard-chat.js';
import { KnowledgeDatasetPicker } from '../../../src/surface/KnowledgeDatasetPicker.js';
import {
  KnowledgeAnswerBubble,
  parseKnowledgeTurn,
  RAG_REFUSE_TEXT,
} from '../../../src/surface/knowledge-citations.js';
import type { KnowledgeSelection } from '../../../electron/preload/api-types.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';

function sparkiiApi(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export default function KnowledgeQaSurface(props: StandardChatProps) {
  const api = props.api ?? sparkiiApi();
  const { agent, sessionId } = props;
  const [selection, setSelection] = useState<KnowledgeSelection>({ mode: 'all' });
  const picker = agent.knowledge?.picker === 'session';

  return (
    <StandardChatSurface
      {...props}
      api={api}
      emptyCopy={{ heading: agent.name, body: '可以询问制度条款。回答依据知识库检索结果。' }}
      hideWorkspace
      hideToolNames={['knowledge.search', 'knowledge_search']}
      composerSkills={null}
      toolbarExtra={picker ? <KnowledgeDatasetPicker api={api} value={selection} onChange={setSelection} /> : undefined}
      onBeforeSend={async () => {
        const key = sessionId ?? `draft:${agent.id}`;
        const result = await api.setSessionKnowledge?.(key, selection);
        if (result && result.ok === false) throw new Error(result.error ?? '选库失败');
      }}
      renderAssistantMessage={({ entry, following }) => {
        const turn = following[0] ? parseKnowledgeTurn(following[0]) : null;
        if (turn?.refused) {
          return <ChatMessage role="assistant" text={turn.text ?? RAG_REFUSE_TEXT} />;
        }
        if (turn && !turn.refused) {
          return (
            <KnowledgeAnswerBubble
              text={entry.text}
              thinking={entry.thinking}
              streaming={entry.streaming}
              documents={turn.documents}
              onOpenDocument={(doc) => {
                void api.openRagDocument?.({
                  datasetId: doc.datasetId,
                  documentId: doc.documentId,
                  fileName: doc.documentName,
                });
              }}
            />
          );
        }
        return (
          <ChatMessage role="assistant" text={entry.text} thinking={entry.thinking} streaming={entry.streaming}>
            <Markdown text={entry.text} />
          </ChatMessage>
        );
      }}
      renderCustomEntry={(entry) => {
        const turn = parseKnowledgeTurn(entry);
        if (turn?.refused) return <ChatMessage role="assistant" text={turn.text ?? RAG_REFUSE_TEXT} />;
        return null;
      }}
    />
  );
}
