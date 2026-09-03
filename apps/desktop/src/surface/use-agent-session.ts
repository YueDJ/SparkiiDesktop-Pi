import { useEffect, useState } from 'react';
import type { AgentSession, SessionEntry } from './contract.js';
import { applySurfaceEvent, deriveWorkflowTimeline, extractWorkflowResult, normalizeSessionEntries } from './normalize.js';
import { normalizeMessages as uiNormalizeMessages } from '@sparkii/ui';

const EMPTY: AgentSession = { entries: [], streaming: false, status: 'idle', meta: { currentStep: null } };

function withWorkflowFromEntries(
  session: AgentSession,
  entries: SessionEntry[],
  extra: Partial<AgentSession> = {},
): AgentSession {
  const timeline = deriveWorkflowTimeline(entries);
  return {
    ...session,
    ...extra,
    entries,
    status: timeline.status,
    result: extractWorkflowResult(entries),
    meta: {
      ...session.meta,
      ...extra.meta,
      currentStep: timeline.step ?? extra.meta?.currentStep ?? session.meta.currentStep,
    },
  };
}

export function useAgentSession(agentId: string, sessionId: string | null, mode: 'live' | 'history'): AgentSession {
  const [session, setSession] = useState<AgentSession>(EMPTY);

  useEffect(() => {
    setSession(EMPTY);
    if (!sessionId) return;

    let open = true;
    (window as any).sparkii?.openChatSession?.(sessionId)
      .then((res: any) => {
        if (!open) return;
        const rawEntries = Array.isArray(res?.entries) ? res.entries : undefined;
        const rawMessages = Array.isArray(res?.messages) ? res.messages : undefined;
        const entries = rawEntries?.length
          ? normalizeSessionEntries(rawEntries)
          : rawMessages?.length
            ? uiNormalizeMessages(rawMessages)
            : [];
        const inputs = Array.isArray(res?.inputs)
          ? res.inputs.map((i: any) => typeof i === 'string'
            ? { path: i }
            : {
                path: String(i?.path ?? ''),
                name: typeof i?.name === 'string' ? i.name : undefined,
                ...(i?.missing ? { missing: true } : {}),
              })
          : Array.isArray(res?.documents)
            ? res.documents.map((i: any) => typeof i === 'string'
              ? { path: i }
              : { path: String(i?.path ?? '') })
            : undefined;
        setSession((s) => withWorkflowFromEntries(s, entries, {
          streaming: Boolean(res?.streaming),
          meta: { ...s.meta, currentStep: res?.currentStep ?? null, inputs: inputs ?? s.meta.inputs },
        }));
      })
      .catch(() => {
        // 读取失败保持空会话，不打断 UI
      });

    const offChat = (window as any).sparkii?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      setSession((s) => {
        const entries = applySurfaceEvent(s.entries, p);
        let streaming = s.streaming;
        if (p?.type === 'agent_start') streaming = true;
        else if (p?.type === 'agent_end' || p?.type === 'agent_settled') streaming = false;
        return withWorkflowFromEntries(s, entries, { streaming });
      });
    });
    return () => {
      open = false;
      offChat?.();
    };
  }, [agentId, sessionId, mode]);

  return session;
}
