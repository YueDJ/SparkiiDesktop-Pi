import { useEffect, useRef, useState } from 'react';
import { ChatMessage, Markdown } from '@sparkii/ui';
import { StandardChatSurface, type StandardChatProps } from '../../../src/surface/standard-chat.js';
import { KnowledgeDatasetPicker } from '../../../src/surface/KnowledgeDatasetPicker.js';
import {
  KnowledgeAnswerBubble,
  parseKnowledgeTurn,
  RAG_REFUSE_TEXT,
} from '../../../src/surface/knowledge-citations.js';
import { decideTitle, firstAssistantText, firstUserText, placeholderOf } from '../../general/surface/title.js';
import type { KnowledgeSelection } from '../../../electron/preload/api-types.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';

function sparkiiApi(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

function defaultSelection(
  agentId: string,
  settings: unknown,
  datasets: Array<{ id: string }>,
): KnowledgeSelection {
  const rag = (settings as { rag?: { bindings?: Array<{ agentId?: string; defaultDatasetId?: string }> } } | null)?.rag;
  const bindings = Array.isArray(rag?.bindings) ? rag.bindings : [];
  const defaultId = bindings.find((b) => b.agentId === agentId)?.defaultDatasetId;
  const allowed = new Set(datasets.map((d) => d.id));
  const id = defaultId && allowed.has(defaultId) ? defaultId : datasets[0]?.id;
  return id ? { mode: 'ids', datasetIds: [id] } : { mode: 'ids', datasetIds: [] };
}

export default function KnowledgeQaSurface(props: StandardChatProps) {
  const api = props.api ?? sparkiiApi();
  const { agent, sessionId, session, title } = props;
  const sessionKey = sessionId ?? `draft:${agent.id}`;
  const [bySession, setBySession] = useState<Record<string, KnowledgeSelection>>({});
  const [resolvedDefault, setResolvedDefault] = useState<KnowledgeSelection | null>(null);
  const prevSessionId = useRef(sessionId);
  const lastDecisionKey = useRef('');

  useEffect(() => {
    if (!sessionId) return;
    const user = firstUserText(session.entries);
    const assistant = firstAssistantText(session.entries);
    const decision = decideTitle({
      currentTitle: title,
      firstUserText: user,
      firstAssistantText: assistant,
    });
    if (decision.action === 'none') return;
    const key = `${sessionId}:${decision.action}:${decision.action === 'placeholder' ? decision.title : decision.prompt}`;
    if (lastDecisionKey.current === key) return;
    lastDecisionKey.current = key;

    if (decision.action === 'placeholder') {
      void api.setChatTitle?.(sessionId, decision.title, 'agent');
      return;
    }

    void (async () => {
      const result = await api.completeText?.(sessionId, decision.prompt);
      const next = String(result?.text ?? '').trim().slice(0, 20);
      if (!result?.ok || !next) return;
      await api.setChatTitle?.(sessionId, next, 'agent');
    })();
  }, [sessionId, session.entries, title, api]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.listRagDatasets?.() ?? Promise.resolve({ ok: false as const }),
      api.getSettings?.() ?? Promise.resolve({}),
    ]).then(([listed, settings]) => {
      if (cancelled) return;
      const datasets = listed && typeof listed === 'object' && 'ok' in listed && listed.ok
        ? (listed.datasets ?? [])
        : [];
      setResolvedDefault(defaultSelection(agent.id, settings, datasets));
    }).catch(() => {
      if (!cancelled) setResolvedDefault({ mode: 'ids', datasetIds: [] });
    });
    return () => { cancelled = true; };
  }, [api, agent.id]);

  useEffect(() => {
    const prev = prevSessionId.current;
    prevSessionId.current = sessionId;
    if (prev && !sessionId) {
      const draftKey = `draft:${agent.id}`;
      setBySession((prevMap) => {
        if (!(draftKey in prevMap)) return prevMap;
        const next = { ...prevMap };
        delete next[draftKey];
        return next;
      });
    }
  }, [sessionId, agent.id]);

  const selection = bySession[sessionKey] ?? resolvedDefault ?? { mode: 'ids', datasetIds: [] };
  const picker = agent.knowledge?.picker === 'session';

  return (
    <StandardChatSurface
      {...props}
      api={api}
      emptyCopy={{
        heading: agent.name,
        body: '可以询问制度条款。回答依据知识库检索结果。',
        hint: '开始提问，回答将依据知识库检索结果。',
      }}
      hideWorkspace
      hideToolNames={['knowledge.search', 'knowledge_search']}
      composerSkills={null}
      onSessionCreated={(id, text) => {
        setBySession((prev) => {
          const draftKey = `draft:${agent.id}`;
          const draft = prev[draftKey];
          if (!draft) return prev;
          return { ...prev, [id]: draft };
        });
        void api.setChatTitle?.(id, placeholderOf(text), 'agent');
        props.onSessionCreated?.(id, text);
      }}
      toolbarExtra={picker ? (
        <KnowledgeDatasetPicker
          api={api}
          value={selection}
          onChange={(next) => setBySession((prev) => ({ ...prev, [sessionKey]: next }))}
        />
      ) : undefined}
      onBeforeSend={async () => {
        const key = sessionId ?? `draft:${agent.id}`;
        const current = bySession[key] ?? resolvedDefault;
        if (!current || (current.mode === 'ids' && current.datasetIds.length === 0)) {
          throw new Error('请选择知识库');
        }
        const result = await api.setSessionKnowledge?.(key, current);
        if (result && result.ok === false) throw new Error(result.error ?? '选库失败');
      }}
      renderAssistantMessage={({ entry, following }) => {
        const turn = following.map(parseKnowledgeTurn).find((item) => item !== null) ?? null;
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
              citations={turn.citations}
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
