/**
 * Bid-writing conversation wrapper.
 *
 * Physical isolation: this wrapper renders the forked `standard-chat-bid.tsx`
 * (never src/surface/standard-chat.tsx) and owns a bid-local two-phase title
 * policy in `title.ts`. Changes here cannot affect general chat or workflow.
 */
import { useEffect, useRef } from 'react';
import { StandardChatSurface, type StandardChatProps } from './standard-chat-bid.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { decideTitle, firstAssistantText, firstUserText, placeholderOf } from './title.js';

function sparkiiApi(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export default function BidChatSurface(props: StandardChatProps) {
  const { sessionId, session, title, api: apiOverride } = props;
  const lastDecisionKey = useRef('');

  // Two-phase title, parallel to general chat but on the bid-local copy.
  // A project session already carries project.json.name as its title, so the
  // decision is normally 'none' and the project name is never overwritten.
  useEffect(() => {
    if (!sessionId) return;
    const decision = decideTitle({
      currentTitle: title,
      firstUserText: firstUserText(session.entries),
      firstAssistantText: firstAssistantText(session.entries),
    });
    if (decision.action === 'none') return;
    const key = `${sessionId}:${decision.action}:${decision.action === 'placeholder' ? decision.title : decision.prompt}`;
    if (lastDecisionKey.current === key) return;
    lastDecisionKey.current = key;

    const api = apiOverride ?? sparkiiApi();
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
  }, [sessionId, session.entries, title, apiOverride]);

  const onSessionCreated = (id: string, userText: string) => {
    props.onSessionCreated?.(id, userText);
    void (async () => {
      const api = apiOverride ?? sparkiiApi();
      let projectName: string | undefined;
      try {
        const record = await api.getChatSession?.(id) as { workspacePath?: string } | null | undefined;
        if (record?.workspacePath) {
          const read = await api.workspaceRead?.({ sessionId: id, path: 'project.json' });
          if (read?.ok && typeof read.content === 'string') {
            const parsed = JSON.parse(read.content) as { name?: unknown };
            if (typeof parsed?.name === 'string' && parsed.name.trim()) projectName = parsed.name.trim();
          }
        }
      } catch { /* keep the local placeholder */ }
      void api.setChatTitle?.(id, projectName ?? placeholderOf(userText), 'agent');
    })();
  };

  return <StandardChatSurface {...props} onSessionCreated={onSessionCreated} />;
}
