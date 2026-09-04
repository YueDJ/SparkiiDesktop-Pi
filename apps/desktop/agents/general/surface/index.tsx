import { useEffect, useRef } from 'react';
import { StandardChatSurface, type StandardChatProps } from '../../../src/surface/standard-chat.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { decideTitle, firstAssistantText, firstUserText } from './title.js';

export { applyChatEvent, normalizeMessages, type ChatEntry } from '@sparkii/ui';

function sparkiiApi(): Pick<SparkiiApi, 'setChatTitle' | 'completeText'> {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export default function GeneralAgentSurface(props: StandardChatProps) {
  const { sessionId, session, title, api: apiOverride } = props;
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

  return <StandardChatSurface {...props} />;
}
