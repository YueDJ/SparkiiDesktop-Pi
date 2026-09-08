import { useEffect, useMemo, useRef } from 'react';
import { StandardChatSurface, type StandardChatProps } from '../../../src/surface/standard-chat.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { applyApprovalStatus } from './approval-timeline.js';
import { decideTitle, firstAssistantText, firstUserText, placeholderOf } from './title.js';
import { useSessionApprovals } from '../../../src/trust/ApprovalInbox.js';
import { InlineApprovalCard } from '../../../src/trust/InlineApprovalCard.js';
import type { SessionEntry } from '../../../src/surface/contract.js';

export { applyChatEvent, normalizeMessages, type ChatEntry } from '@sparkii/ui';

function sparkiiApi(): Pick<SparkiiApi, 'setChatTitle' | 'completeText'> {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

export default function GeneralAgentSurface(props: StandardChatProps) {
  const { sessionId, session, title, api: apiOverride } = props;
  const lastDecisionKey = useRef('');
  const entries = useMemo(() => applyApprovalStatus(session.entries), [session.entries]);
  const { waiting } = useSessionApprovals(sessionId);
  const byRequestId = useMemo(() => new Map(waiting.map((p) => [p.requestId, p])), [waiting]);

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

  const onSessionCreated = (id: string, userText: string) => {
    const api = apiOverride ?? sparkiiApi();
    void api.setChatTitle?.(id, placeholderOf(userText), 'agent');
  };

  const renderApprovalCard = (entry: Extract<SessionEntry, { kind: 'tool' }>) => {
    const requestId = entry.approvalRequestId;
    if (!requestId) return null;
    const proposal = byRequestId.get(requestId);
    return proposal ? <InlineApprovalCard proposal={proposal} /> : null;
  };

  return (
    <StandardChatSurface
      {...props}
      session={{ ...session, entries }}
      onSessionCreated={onSessionCreated}
      renderApprovalCard={renderApprovalCard}
    />
  );
}
